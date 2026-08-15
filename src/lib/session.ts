import {
  db,
  readNewPerDay,
  readProgress,
  readSyncState,
  readWords,
  type ProgressRow,
  type ReviewRow,
  type StoredWord,
  type SyncState,
} from "@/lib/db";
import { buildQueue } from "@/lib/queue";
import {
  REVIEW_RATINGS,
  type ReviewRating,
  type SerializedCard,
} from "@/lib/srs";
import type { SyncError } from "@/lib/sync";

// How many not-yet-due cards the "study ahead" button pulls forward.
export const STUDY_AHEAD_LIMIT = 5;

const CONFIGURED_NEW_PER_DAY = Number(
  process.env.NEXT_PUBLIC_NEW_PER_DAY?.trim() || Number.NaN,
);

// Only the starting point: the first save in Settings takes over for good.
export const DEFAULT_NEW_PER_DAY =
  Number.isFinite(CONFIGURED_NEW_PER_DAY) && CONFIGURED_NEW_PER_DAY >= 0
    ? Math.floor(CONFIGURED_NEW_PER_DAY)
    : 10;

// `ahead` is a card pulled forward by hand, counted apart from the ones that came due on
// their own so the header never claims work the schedule did not ask for.
export type QueueKind = "due" | "new" | "ahead";

export type QueueCard = {
  word: StoredWord;
  kind: QueueKind;
  // The schedule the card entered the queue with, which is what the rating buttons
  // preview their intervals from. A new card has none yet.
  card: SerializedCard | undefined;
};

export type UpcomingCard = {
  word: StoredWord;
  due: string;
  card: SerializedCard;
};

export type StudySession = {
  queue: QueueCard[];
  upcoming: UpcomingCard[];
  answersToday: number;
  newPerDay: number;
  wordCount: number;
  syncState: SyncState | undefined;
};

export type SessionResult =
  | { ok: true; session: StudySession }
  | { ok: false; error: { code: "STORAGE_UNAVAILABLE"; message: string } };

export type StudyAction =
  | { type: "flip" }
  | { type: "undo" }
  | { type: "rate"; rating: ReviewRating }
  | { type: "ignore" };

export type SyncNotice = {
  // A blocking notice stands in front of the session until the user acknowledges it; the
  // cached words stay studyable behind it.
  blocking: boolean;
  title: string;
  showHealthLink: boolean;
};

export async function loadSession(now: Date): Promise<SessionResult> {
  try {
    // Asked for explicitly so a device that refuses IndexedDB fails here, before a single
    // answer is given, instead of when the first one is saved.
    await db.open();

    const [words, progress, storedNewPerDay, syncState, todaysReviews] =
      await Promise.all([
        readWords(),
        readProgress(),
        readNewPerDay(),
        readSyncState(),
        readReviewsSince(startOfDay(now)),
      ]);

    const newPerDay = storedNewPerDay ?? DEFAULT_NEW_PER_DAY;
    // The cap is a daily one, so the cards already introduced today have to come off it or
    // a reload — or simply finishing the queue — would hand out a second helping.
    const queue = buildQueue({
      words,
      progress,
      now,
      newPerDay: newPerDay - countNewCards(todaysReviews),
    });

    const cardById = new Map(
      progress.map((row) => [row.id, row.card] as const),
    );

    return {
      ok: true,
      session: {
        queue: [
          ...queue.dueCards.map((word) =>
            queueCard(word, "due", cardById.get(word.id)),
          ),
          ...queue.newCards.map((word) => queueCard(word, "new", undefined)),
        ],
        upcoming: upcomingCards({
          words,
          progress,
          now,
          limit: STUDY_AHEAD_LIMIT,
        }),
        answersToday: todaysReviews.length,
        newPerDay,
        wordCount: words.length,
        syncState,
      },
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      ok: false,
      error: {
        code: "STORAGE_UNAVAILABLE",
        message: `This device would not open its local database (${message}). Studying now would lose every answer, so the session is stopped here.`,
      },
    };
  }
}

export function startOfDay(now: Date): Date {
  // The user's own midnight, not UTC's: "how much did I do today" is a question about the
  // day they are living in.
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start;
}

// A card leaves state New on its first answer and never goes back, so a snapshot taken
// while it was New marks the answer that introduced it.
export function countNewCards(reviews: ReviewRow[]): number {
  return reviews.filter((row) => row.before.state === "New").length;
}

export function upcomingCards(input: {
  words: StoredWord[];
  progress: ProgressRow[];
  now: Date;
  limit: number;
}): UpcomingCard[] {
  const wordById = new Map(
    input.words
      .filter((word) => !word.orphaned)
      .map((word) => [word.id, word] as const),
  );

  return input.progress
    .flatMap((row) => {
      const word = wordById.get(row.id);
      return word !== undefined && Date.parse(row.due) > input.now.getTime()
        ? [{ word, due: row.due, card: row.card }]
        : [];
    })
    .sort(
      (left, right) =>
        Date.parse(left.due) - Date.parse(right.due) ||
        left.word.order - right.word.order,
    )
    .slice(0, Math.max(0, input.limit));
}

// Undo puts the card the user just took back at the front, wherever a freshly built queue
// would otherwise have placed it.
export function putInFront(queue: QueueCard[], card: QueueCard): QueueCard[] {
  return [card, ...queue.filter((entry) => entry.word.id !== card.word.id)];
}

// Plain words, and only for what is actually there: "Due 0 · New 0" over a finished
// queue read as a riddle, so an empty queue says nothing at all.
export function countsLabel(queue: QueueCard[]): string {
  const counts: Record<QueueKind, number> = { due: 0, new: 0, ahead: 0 };
  for (const card of queue) {
    counts[card.kind] += 1;
  }

  const parts: string[] = [];
  if (counts.due > 0) {
    parts.push(`${counts.due} to review`);
  }
  if (counts.new > 0) {
    parts.push(`${counts.new} new`);
  }
  if (counts.ahead > 0) {
    parts.push(`${counts.ahead} ahead of schedule`);
  }

  return parts.join(" · ");
}

// SPEC §7: Space flips the card — over to the answer and back again — `1`-`4` rate, `U`
// undoes the last answer. A rating pressed before the answer is showing would grade a
// card the user has not read yet, so it is ignored.
export function actionForKey(
  key: string,
  options: { revealed: boolean },
): StudyAction {
  if (key === " ") {
    return { type: "flip" };
  }

  if (key === "u" || key === "U") {
    return { type: "undo" };
  }

  const ratingIndex = Number(key) - 1;
  if (
    options.revealed &&
    Number.isInteger(ratingIndex) &&
    ratingIndex >= 0 &&
    ratingIndex < REVIEW_RATINGS.length
  ) {
    return { type: "rate", rating: REVIEW_RATINGS[ratingIndex] };
  }

  return { type: "ignore" };
}

// SPEC §8, one row per situation. A failed sync never costs the user the cached words, but
// only the two connection failures may call themselves "offline": telling someone their
// phone is offline when the sheet was unpublished sends them to fix the wrong thing.
export function syncNotice(error: SyncError): SyncNotice {
  return noticeByCode[error.code];
}

const noticeByCode: Record<SyncError["code"], SyncNotice> = {
  // The device's key cookie died — rotation, or a year away. The cached words are
  // untouched, and the fix is the gate, not the sheet.
  GATE_LOCKED: {
    blocking: false,
    title: "Sync failed — this device's access key is stale. Open /gate and enter it again.",
    showHealthLink: false,
  },
  OFFLINE: {
    blocking: false,
    title: "Offline — studying from the words cached on this device.",
    showHealthLink: false,
  },
  SHEET_UNREACHABLE: {
    blocking: false,
    title: "The sheet could not be reached — studying from the cached words.",
    showHealthLink: false,
  },
  // Every row the sheet answered with was rejected, so the cached list was kept. The user
  // has to see that before studying, or they study a list nobody is maintaining any more.
  EMPTY_SHEET: {
    blocking: true,
    title: "The sheet came back without a single usable word.",
    showHealthLink: true,
  },
  SHEET_NOT_PUBLISHED: {
    blocking: false,
    title: "Sync failed — the sheet is not published as CSV.",
    showHealthLink: true,
  },
  SHEET_CSV_URL_MISSING: {
    blocking: false,
    title: "Sync failed — this installation has no sheet URL configured.",
    showHealthLink: true,
  },
  SHEET_CSV_URL_INVALID: {
    blocking: false,
    title: "Sync failed — the configured sheet URL is not a usable address.",
    showHealthLink: true,
  },
  SYNC_RESPONSE_INVALID: {
    blocking: false,
    title: "Sync failed — the word list endpoint answered with something else.",
    showHealthLink: true,
  },
  STORAGE_UNAVAILABLE: {
    blocking: false,
    title: "Sync failed — the refreshed word list could not be stored.",
    showHealthLink: false,
  },
};

async function readReviewsSince(from: Date): Promise<ReviewRow[]> {
  // Every `reviewedAt` is written by `toISOString()`, so the index sorts them the same way
  // time does and the bound can be a plain string.
  return db.reviews
    .where("reviewedAt")
    .aboveOrEqual(from.toISOString())
    .toArray();
}

function queueCard(
  word: StoredWord,
  kind: QueueKind,
  card: SerializedCard | undefined,
): QueueCard {
  return { word, kind, card };
}
