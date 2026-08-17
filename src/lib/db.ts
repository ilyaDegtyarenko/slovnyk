import Dexie, { type Table } from "dexie";
import type { InvalidRow, Word } from "@/lib/sheet";
import {
  initialCard,
  review,
  type CardState,
  type ReviewRating,
  type SerializedCard,
} from "@/lib/srs";
import type { SyncError } from "@/lib/sync";

export type StoredWord = Word & {
  // Position in the sheet: new cards enter the queue in the order the tutor wrote them,
  // and the id says nothing about order by design.
  order: number;
  orphaned: boolean;
  // When the word's text last changed, not when it was last synced.
  updatedAt: string;
};

export type ProgressRow = {
  id: string;
  // `due` and `state` repeat what `card` already holds: Dexie can only index top-level
  // fields, and the queue is built by asking for the cards that came due.
  due: string;
  state: CardState;
  card: SerializedCard;
};

export type ReviewRow = {
  seq?: number;
  id: string;
  reviewedAt: string;
  rating: ReviewRating;
  // The card as it stood before this answer, which is what lets undo put it back.
  before: SerializedCard;
};

export type SyncFailure = {
  code: SyncError["code"];
  message: string;
  at: string;
};

export type SyncState = {
  syncedAt: string;
  invalid: InvalidRow[];
};

// A row of its own rather than a field on `SyncState`: a failed attempt then cannot
// overwrite the record of the last successful one, and a sync that fails before any has
// ever succeeded still leaves its reason behind.
export type MetaRow =
  | { key: "syncState"; value: SyncState }
  | { key: "lastSyncError"; value: SyncFailure }
  | { key: "newPerDay"; value: number };

export type RecordedReview = {
  seq: number;
  progress: ProgressRow;
};

const DATABASE_NAME = "slovnyk";

class SlovnykDatabase extends Dexie {
  readonly words: Table<StoredWord, string>;
  readonly progress: Table<ProgressRow, string>;
  readonly reviews: Table<ReviewRow, number>;
  readonly meta: Table<MetaRow, MetaRow["key"]>;

  constructor() {
    super(DATABASE_NAME);
    this.version(1).stores({
      words: "id, term, updatedAt",
      progress: "id, due, state",
      reviews: "++seq, id, reviewedAt",
      meta: "key",
    });
    this.words = this.table<StoredWord, string>("words");
    this.progress = this.table<ProgressRow, string>("progress");
    this.reviews = this.table<ReviewRow, number>("reviews");
    this.meta = this.table<MetaRow, MetaRow["key"]>("meta");
  }
}

export const db = new SlovnykDatabase();

export async function readWords(): Promise<StoredWord[]> {
  return db.words.toArray();
}

export async function readProgress(): Promise<ProgressRow[]> {
  return db.progress.toArray();
}

export async function readSyncState(): Promise<SyncState | undefined> {
  const row = await db.meta.get("syncState");
  return row?.key === "syncState" ? row.value : undefined;
}

export async function readLastSyncError(): Promise<SyncFailure | undefined> {
  const row = await db.meta.get("lastSyncError");
  return row?.key === "lastSyncError" ? row.value : undefined;
}

export async function readNewPerDay(): Promise<number | undefined> {
  const row = await db.meta.get("newPerDay");
  return row?.key === "newPerDay" ? row.value : undefined;
}

// Returns the value that was stored: a NaN or a negative cap would quietly empty the
// daily queue instead of failing where the user could see it.
export async function writeNewPerDay(newPerDay: number): Promise<number> {
  const sanitized = Number.isFinite(newPerDay)
    ? Math.max(0, Math.trunc(newPerDay))
    : 0;

  await db.meta.put({ key: "newPerDay", value: sanitized });

  return sanitized;
}

export async function recordReview(input: {
  id: string;
  rating: ReviewRating;
  now: Date;
}): Promise<RecordedReview> {
  return db.transaction("rw", db.progress, db.reviews, async () => {
    const stored = await db.progress.get(input.id);
    const before = stored?.card ?? initialCard(input.now);
    const outcome = review(before, input.rating, input.now);
    const progress = progressRowOf(input.id, outcome.card);

    await db.progress.put(progress);
    const seq = await db.reviews.add({
      id: input.id,
      reviewedAt: outcome.reviewedAt,
      rating: input.rating,
      before,
    });

    return { seq, progress };
  });
}

// Returns the word whose answer was rolled back, or null when the log is empty or its last
// row is no longer the answer the caller means to undo. Deleting from the review log is
// the one thing the user may ask for; nothing else in the app removes a row from it.
export async function undoLastReview(
  expectedSeq: number,
): Promise<string | null> {
  return db.transaction("rw", db.progress, db.reviews, async () => {
    const last = await db.reviews.orderBy("seq").last();
    const seq = last?.seq;

    // Undo reaches the immediately previous answer and no further (SPEC §7). A second
    // undo, or a held-down key, names a row that is no longer last and is refused.
    if (last === undefined || seq === undefined || seq !== expectedSeq) {
      return null;
    }

    // A card leaves state New on its first answer and never returns, so a New snapshot
    // means this very review created the progress row: rolling it back removes the row
    // instead of leaving a never-answered card behind.
    if (last.before.state === "New") {
      await db.progress.delete(last.id);
    } else {
      await db.progress.put(progressRowOf(last.id, last.before));
    }
    await db.reviews.delete(seq);

    return last.id;
  });
}

// Leaves the last successful sync exactly as it was: a failed attempt says nothing about
// how fresh the cached words are, only that this one did not get through.
export async function recordSyncFailure(failure: SyncFailure): Promise<void> {
  await db.meta.put({ key: "lastSyncError", value: failure });
}

// For the sync that succeeded without changing anything worth writing: the complaint
// still has to go, or /health keeps reporting a failure the endpoint has outlived.
export async function clearSyncFailure(): Promise<void> {
  await db.meta.delete("lastSyncError");
}

export async function applySync(input: {
  words: StoredWord[];
  syncState: SyncState;
}): Promise<void> {
  // `progress` and `reviews` are deliberately outside this transaction's scope: a sync
  // writes the word list and the sync report, so no sheet edit can reach the schedule.
  await db.transaction("rw", db.words, db.meta, async () => {
    // The merge returns every cached word, orphans included, so putting the list back is
    // enough to keep the table exact without deleting anything.
    await db.words.bulkPut(input.words);
    await db.meta.put({ key: "syncState", value: input.syncState });
    // This list is the proof the trouble is over, so the old complaint goes with it.
    await db.meta.delete("lastSyncError");
  });
}

function progressRowOf(id: string, card: SerializedCard): ProgressRow {
  return { id, due: card.due, state: card.state, card };
}
