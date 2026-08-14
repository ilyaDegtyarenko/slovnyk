import { z } from "zod";
import {
  db,
  readNewPerDay,
  readProgress,
  readSyncState,
  readWords,
  type ProgressRow,
  type ReviewRow,
  type StoredWord,
} from "@/lib/db";
import { REVIEW_RATINGS, type CardState } from "@/lib/srs";

// The file is the only thing two installations of this app ever agree on, so it carries the
// number of the shape it was written in.
export const SNAPSHOT_VERSION = 1;

// `seq` is the local auto-increment key of the review log and means nothing on the device
// that reads the file back.
export type SnapshotReview = Omit<ReviewRow, "seq">;

export type Snapshot = {
  version: number;
  exportedAt: string;
  newPerDay: number | null;
  syncedAt: string | null;
  words: StoredWord[];
  progress: ProgressRow[];
  reviews: SnapshotReview[];
};

// The two tables a merge is allowed to touch. The word list is not one of them: it belongs
// to the sheet, and the next sync rebuilds it from there.
export type ProgressSnapshot = Pick<Snapshot, "progress" | "reviews">;

export type SnapshotMerge = ProgressSnapshot & {
  addedReviews: number;
  updatedProgress: number;
};

export type SnapshotParseResult =
  | { ok: true; snapshot: Snapshot }
  | { ok: false; message: string };

export type ImportResult =
  | { ok: true; addedReviews: number; updatedProgress: number }
  | {
      ok: false;
      error: {
        code: "SNAPSHOT_INVALID" | "STORAGE_UNAVAILABLE";
        message: string;
      };
    };

const CARD_STATES = [
  "New",
  "Learning",
  "Review",
  "Relearning",
] as const satisfies readonly CardState[];

const SerializedCardSchema = z.object({
  due: z.iso.datetime(),
  stability: z.number(),
  difficulty: z.number(),
  elapsed_days: z.number(),
  scheduled_days: z.number(),
  learning_steps: z.number(),
  reps: z.number(),
  lapses: z.number(),
  state: z.enum(CARD_STATES),
  last_review: z.iso.datetime().nullable(),
});

const SnapshotSchema = z.object({
  version: z.literal(SNAPSHOT_VERSION),
  exportedAt: z.iso.datetime(),
  newPerDay: z.number().nullable(),
  syncedAt: z.iso.datetime().nullable(),
  words: z.array(
    z.object({
      id: z.string().min(1),
      term: z.string().min(1),
      translation: z.string().min(1),
      example: z.string(),
      tags: z.array(z.string()),
      added: z.string(),
      order: z.number().int(),
      orphaned: z.boolean(),
      updatedAt: z.iso.datetime(),
    }),
  ),
  progress: z.array(
    z.object({
      id: z.string().min(1),
      due: z.iso.datetime(),
      state: z.enum(CARD_STATES),
      card: SerializedCardSchema,
    }),
  ),
  reviews: z.array(
    z.object({
      id: z.string().min(1),
      reviewedAt: z.iso.datetime(),
      rating: z.enum(REVIEW_RATINGS),
      before: SerializedCardSchema,
    }),
  ),
});

export function exportSnapshot(input: {
  words: StoredWord[];
  progress: ProgressRow[];
  reviews: ReviewRow[];
  newPerDay: number | null;
  syncedAt: string | null;
  exportedAt: string;
}): Snapshot {
  return {
    version: SNAPSHOT_VERSION,
    exportedAt: input.exportedAt,
    newPerDay: input.newPerDay,
    syncedAt: input.syncedAt,
    words: input.words,
    progress: input.progress,
    reviews: input.reviews.map(toSnapshotReview),
  };
}

// A file the user picked is as much a boundary as the network, and this one is allowed to
// overwrite a schedule.
export function parseSnapshot(text: string): SnapshotParseResult {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, message: `The file is not JSON (${message}).` };
  }

  const validated = SnapshotSchema.safeParse(body);
  if (!validated.success) {
    return {
      ok: false,
      message: `The file is not a slovnyk export this version can read: ${describeIssues(validated.error)}.`,
    };
  }

  return { ok: true, snapshot: validated.data };
}

// The merge rule, in one place because this is the code that can lose history:
//
// - Reviews are a union keyed by (id, reviewedAt). The same answer written twice stays one
//   row and the local copy is the one kept, so an import can never rewrite an answer this
//   device logged. Nothing local is ever dropped.
// - The result is ordered by `reviewedAt`, with local rows ahead of imported ones on a tie,
//   so the log stays chronological and undo still rolls back the answer that came last.
// - Progress for an id comes from the side whose newest review for that id is newer. A side
//   with no review for that id never outranks one that has, and a tie keeps the local row,
//   which is what makes importing the same file twice a no-op.
// - The answers decide even where this device has none of its own schedule for a word: a
//   local schedule missing while local answers exist is a state only a half-finished
//   restore produces, and an older file must not talk its way in on the strength of it. The
//   file is taken outright only when this device has nothing for the word at all.
export function mergeSnapshot(
  current: ProgressSnapshot,
  imported: ProgressSnapshot,
): SnapshotMerge {
  const merged = mergeReviews(current.reviews, imported.reviews);
  const currentNewest = newestReviewByWord(current.reviews);
  const importedNewest = newestReviewByWord(imported.reviews);

  const progressById = new Map(current.progress.map((row) => [row.id, row]));
  let updatedProgress = 0;

  for (const row of imported.progress) {
    const nothingLocal =
      !progressById.has(row.id) && currentNewest.get(row.id) === undefined;

    if (
      nothingLocal ||
      isNewer(importedNewest.get(row.id), currentNewest.get(row.id))
    ) {
      progressById.set(row.id, row);
      updatedProgress += 1;
    }
  }

  return {
    progress: [...progressById.values()],
    reviews: merged.reviews,
    addedReviews: merged.addedReviews,
    updatedProgress,
  };
}

export async function readSnapshot(now: Date): Promise<Snapshot> {
  await db.open();

  // One read transaction over all four tables: an answer landing between two of these reads
  // would otherwise write a file whose schedule and log disagree about the same word.
  return db.transaction(
    "r",
    db.words,
    db.progress,
    db.reviews,
    db.meta,
    async (): Promise<Snapshot> => {
      const [words, progress, reviews, newPerDay, syncState] =
        await Promise.all([
          readWords(),
          readProgress(),
          db.reviews.orderBy("seq").toArray(),
          readNewPerDay(),
          readSyncState(),
        ]);

      return exportSnapshot({
        words,
        progress,
        reviews,
        newPerDay: newPerDay ?? null,
        syncedAt: syncState?.syncedAt ?? null,
        exportedAt: now.toISOString(),
      });
    },
  );
}

// Only `progress` and `reviews` are written back. The imported `newPerDay` is left alone
// because a backup from another device must not silently change this one's settings, and
// the imported words are left alone because the sheet decides what the word list is.
export async function importSnapshot(text: string): Promise<ImportResult> {
  const parsed = parseSnapshot(text);
  if (!parsed.ok) {
    return {
      ok: false,
      error: { code: "SNAPSHOT_INVALID", message: parsed.message },
    };
  }

  try {
    return await db.transaction(
      "rw",
      db.progress,
      db.reviews,
      async (): Promise<ImportResult> => {
        const [progress, reviews] = await Promise.all([
          db.progress.toArray(),
          db.reviews.orderBy("seq").toArray(),
        ]);
        const merged = mergeSnapshot({ progress, reviews }, parsed.snapshot);

        await db.progress.bulkPut(merged.progress);
        // The log is rewritten whole so its keys come out in the order the answers were
        // given: undo reads the last key, and a merged-in answer may belong before a local
        // one. The transaction is what keeps this from being a moment with no history.
        await db.reviews.clear();
        await db.reviews.bulkAdd(merged.reviews);

        return {
          ok: true,
          addedReviews: merged.addedReviews,
          updatedProgress: merged.updatedProgress,
        };
      },
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      ok: false,
      error: {
        code: "STORAGE_UNAVAILABLE",
        message: `The import was rolled back because this device would not store it (${message}). Nothing changed.`,
      },
    };
  }
}

function mergeReviews(
  current: SnapshotReview[],
  imported: SnapshotReview[],
): { reviews: SnapshotReview[]; addedReviews: number } {
  const byAnswer = new Map<string, SnapshotReview>();
  for (const row of current) {
    byAnswer.set(answerKey(row), toSnapshotReview(row));
  }

  let addedReviews = 0;
  for (const row of imported) {
    const key = answerKey(row);
    if (byAnswer.has(key)) {
      continue;
    }
    byAnswer.set(key, toSnapshotReview(row));
    addedReviews += 1;
  }

  const reviews = [...byAnswer.values()].sort(
    (left, right) => Date.parse(left.reviewedAt) - Date.parse(right.reviewedAt),
  );

  return { reviews, addedReviews };
}

function newestReviewByWord(reviews: SnapshotReview[]): Map<string, number> {
  const newest = new Map<string, number>();
  for (const row of reviews) {
    const reviewedAt = Date.parse(row.reviewedAt);
    const known = newest.get(row.id);
    if (known === undefined || reviewedAt > known) {
      newest.set(row.id, reviewedAt);
    }
  }
  return newest;
}

function isNewer(candidate: number | undefined, incumbent: number | undefined): boolean {
  return (
    (candidate ?? Number.NEGATIVE_INFINITY) >
    (incumbent ?? Number.NEGATIVE_INFINITY)
  );
}

function toSnapshotReview(row: SnapshotReview): SnapshotReview {
  // Rebuilt field by field so a local key never rides along into a file or into a merge.
  return {
    id: row.id,
    reviewedAt: row.reviewedAt,
    rating: row.rating,
    before: row.before,
  };
}

function answerKey(row: SnapshotReview): string {
  return `${row.id} ${row.reviewedAt}`;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      [issue.path.map(String).join("."), issue.message]
        .filter((part) => part.length > 0)
        .join(": "),
    )
    .join("; ");
}
