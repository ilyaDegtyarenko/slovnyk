import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applySync,
  db,
  recordReview,
  undoLastReview,
  writeNewPerDay,
  type ProgressRow,
  type ReviewRow,
  type StoredWord,
} from "@/lib/db";
import { initialCard, review, type ReviewRating } from "@/lib/srs";
import {
  SNAPSHOT_VERSION,
  exportSnapshot,
  importSnapshot,
  mergeSnapshot,
  parseSnapshot,
  readSnapshot,
  type ProgressSnapshot,
  type SnapshotReview,
} from "@/lib/transfer";

const FLIMSUM = "wa3f19c2b81";
const GORBIK = "wb7c02d4e19";
const TRELLUP = "wc51e8a0f2d";

const FIRST_SEEN = new Date("2026-03-01T08:00:00.000Z");
const EXPORTED_AT = "2026-03-10T08:00:00.000Z";
const SYNCED_AT = "2026-03-10T07:00:00.000Z";
// The answer this device gave, and an older one that reaches it in a file.
const LOCAL_ANSWER = "2026-03-09T08:00:00.000Z";
const IMPORTED_ANSWER = "2026-03-08T08:00:00.000Z";

function storedWord(id: string, term: string, order: number): StoredWord {
  return {
    id,
    term,
    translation: `${term} in english`,
    example: "",
    tags: ["invented"],
    added: "2026-03-01",
    order,
    orphaned: false,
    updatedAt: FIRST_SEEN.toISOString(),
  };
}

function answer(
  id: string,
  reviewedAt: string,
  rating: ReviewRating = "good",
): { progress: ProgressRow; review: SnapshotReview } {
  const before = initialCard(FIRST_SEEN);
  const outcome = review(before, rating, new Date(reviewedAt));
  return {
    progress: {
      id,
      due: outcome.card.due,
      state: outcome.card.state,
      card: outcome.card,
    },
    review: { id, reviewedAt: outcome.reviewedAt, rating, before },
  };
}

function snapshotOf(
  ...answers: { progress: ProgressRow; review: SnapshotReview }[]
): ProgressSnapshot {
  return {
    progress: answers.map((entry) => entry.progress),
    reviews: answers.map((entry) => entry.review),
  };
}

function snapshotFile(
  ...answers: { progress: ProgressRow; review: SnapshotReview }[]
): string {
  return JSON.stringify(
    exportSnapshot({
      words: [],
      ...snapshotOf(...answers),
      newPerDay: null,
      syncedAt: null,
      exportedAt: EXPORTED_AT,
    }),
  );
}

async function storedReviews(): Promise<ReviewRow[]> {
  return db.reviews.orderBy("seq").toArray();
}

beforeEach(async () => {
  await Promise.all([
    db.words.clear(),
    db.progress.clear(),
    db.reviews.clear(),
    db.meta.clear(),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("exportSnapshot", () => {
  it("writes a versioned file that carries every table it can restore", () => {
    const answered = answer(FLIMSUM, "2026-03-09T08:00:00.000Z");
    const logged: ReviewRow = { ...answered.review, seq: 7 };

    const snapshot = exportSnapshot({
      words: [storedWord(FLIMSUM, "flimsum", 0)],
      progress: [answered.progress],
      reviews: [logged],
      newPerDay: 12,
      syncedAt: "2026-03-10T07:00:00.000Z",
      exportedAt: EXPORTED_AT,
    });

    expect(snapshot.version).toBe(SNAPSHOT_VERSION);
    expect(snapshot.exportedAt).toBe(EXPORTED_AT);
    expect(snapshot.newPerDay).toBe(12);
    expect(snapshot.syncedAt).toBe("2026-03-10T07:00:00.000Z");
    expect(snapshot.words).toHaveLength(1);
    expect(snapshot.progress).toEqual([answered.progress]);
    expect(snapshot.reviews).toEqual([answered.review]);
  });

  it("leaves the local review keys behind, since they mean nothing elsewhere", () => {
    const answered = answer(FLIMSUM, "2026-03-09T08:00:00.000Z");

    const snapshot = exportSnapshot({
      words: [],
      progress: [],
      reviews: [{ ...answered.review, seq: 41 }],
      newPerDay: null,
      syncedAt: null,
      exportedAt: EXPORTED_AT,
    });

    expect(snapshot.reviews[0]).not.toHaveProperty("seq");
  });

  it("survives the round trip through a file unchanged", () => {
    const answered = answer(FLIMSUM, "2026-03-09T08:00:00.000Z");
    const snapshot = exportSnapshot({
      words: [storedWord(FLIMSUM, "flimsum", 0)],
      progress: [answered.progress],
      reviews: [{ ...answered.review, seq: 1 }],
      newPerDay: 10,
      syncedAt: "2026-03-10T07:00:00.000Z",
      exportedAt: EXPORTED_AT,
    });

    const parsed = parseSnapshot(JSON.stringify(snapshot));

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.snapshot).toEqual(snapshot);
  });
});

describe("parseSnapshot", () => {
  it("refuses a file that is not JSON at all", () => {
    const parsed = parseSnapshot("not a backup, just a sentence");

    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toMatch(/not JSON/);
  });

  it("refuses a file that is JSON but not a snapshot", () => {
    const parsed = parseSnapshot(JSON.stringify({ hello: "there" }));

    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toMatch(/version/);
  });

  it("refuses a snapshot written by a shape this version does not know", () => {
    const parsed = parseSnapshot(
      JSON.stringify({
        version: SNAPSHOT_VERSION + 1,
        exportedAt: EXPORTED_AT,
        newPerDay: null,
        syncedAt: null,
        words: [],
        progress: [],
        reviews: [],
      }),
    );

    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toMatch(/version/);
  });

  it("refuses a progress row whose card is not a card", () => {
    const answered = answer(FLIMSUM, "2026-03-09T08:00:00.000Z");
    const broken = {
      version: SNAPSHOT_VERSION,
      exportedAt: EXPORTED_AT,
      newPerDay: null,
      syncedAt: null,
      words: [],
      progress: [
        {
          ...answered.progress,
          card: { ...answered.progress.card, stability: "quite stable" },
        },
      ],
      reviews: [],
    };

    const parsed = parseSnapshot(JSON.stringify(broken));

    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toMatch(
      /progress\.0\.card\.stability/,
    );
  });

  it("refuses a review whose rating is not one of the four", () => {
    const answered = answer(FLIMSUM, "2026-03-09T08:00:00.000Z");
    const broken = {
      version: SNAPSHOT_VERSION,
      exportedAt: EXPORTED_AT,
      newPerDay: null,
      syncedAt: null,
      words: [],
      progress: [],
      reviews: [{ ...answered.review, rating: "brilliant" }],
    };

    const parsed = parseSnapshot(JSON.stringify(broken));

    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toMatch(/reviews\.0\.rating/);
  });

  it("refuses a word row with an empty id, which would key a schedule to nothing", () => {
    const broken = {
      version: SNAPSHOT_VERSION,
      exportedAt: EXPORTED_AT,
      newPerDay: null,
      syncedAt: null,
      words: [{ ...storedWord(FLIMSUM, "flimsum", 0), id: "" }],
      progress: [],
      reviews: [],
    };

    const parsed = parseSnapshot(JSON.stringify(broken));

    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toMatch(/words\.0\.id/);
  });
});

describe("mergeSnapshot", () => {
  it("keeps every local review, whatever the file says", () => {
    const mine = answer(FLIMSUM, "2026-03-09T08:00:00.000Z");
    const alsoMine = answer(GORBIK, "2026-03-09T09:00:00.000Z");
    const theirs = answer(TRELLUP, "2026-03-08T08:00:00.000Z");

    const merged = mergeSnapshot(
      snapshotOf(mine, alsoMine),
      snapshotOf(theirs),
    );

    expect(merged.reviews).toEqual(
      expect.arrayContaining([mine.review, alsoMine.review, theirs.review]),
    );
    expect(merged.reviews).toHaveLength(3);
    expect(merged.addedReviews).toBe(1);
  });

  it("stores an answer both sides logged once, and keeps the local copy", () => {
    const mine = answer(FLIMSUM, "2026-03-09T08:00:00.000Z", "good");
    const theirs = answer(FLIMSUM, "2026-03-09T08:00:00.000Z", "easy");

    const merged = mergeSnapshot(snapshotOf(mine), snapshotOf(theirs));

    expect(merged.reviews).toEqual([mine.review]);
    expect(merged.addedReviews).toBe(0);
  });

  it("leaves the log in the order the answers were given", () => {
    const first = answer(FLIMSUM, "2026-03-07T08:00:00.000Z");
    const second = answer(GORBIK, "2026-03-08T08:00:00.000Z");
    const third = answer(TRELLUP, "2026-03-09T08:00:00.000Z");

    const merged = mergeSnapshot(snapshotOf(second), snapshotOf(third, first));

    expect(merged.reviews.map((row) => row.reviewedAt)).toEqual([
      first.review.reviewedAt,
      second.review.reviewedAt,
      third.review.reviewedAt,
    ]);
  });

  it("takes the schedule from the side that answered the word last", () => {
    const older = answer(FLIMSUM, "2026-03-05T08:00:00.000Z", "again");
    const newer = answer(FLIMSUM, "2026-03-09T08:00:00.000Z", "easy");

    const merged = mergeSnapshot(snapshotOf(older), snapshotOf(newer));

    expect(merged.progress).toEqual([newer.progress]);
    expect(merged.updatedProgress).toBe(1);
  });

  it("keeps the local schedule when the file is the older side", () => {
    const older = answer(FLIMSUM, "2026-03-05T08:00:00.000Z", "again");
    const newer = answer(FLIMSUM, "2026-03-09T08:00:00.000Z", "easy");

    const merged = mergeSnapshot(snapshotOf(newer), snapshotOf(older));

    expect(merged.progress).toEqual([newer.progress]);
    expect(merged.updatedProgress).toBe(0);
    expect(merged.reviews).toHaveLength(2);
  });

  it("adopts a schedule for a word this device has never answered", () => {
    const mine = answer(FLIMSUM, "2026-03-09T08:00:00.000Z");
    const theirs = answer(GORBIK, "2026-03-08T08:00:00.000Z");

    const merged = mergeSnapshot(snapshotOf(mine), snapshotOf(theirs));

    expect(merged.progress).toEqual([mine.progress, theirs.progress]);
    expect(merged.updatedProgress).toBe(1);
  });

  it("changes nothing when the same file is imported twice", () => {
    const mine = answer(FLIMSUM, "2026-03-09T08:00:00.000Z");
    const theirs = answer(GORBIK, "2026-03-08T08:00:00.000Z");
    const once = mergeSnapshot(snapshotOf(mine), snapshotOf(theirs));

    const twice = mergeSnapshot(once, snapshotOf(theirs));

    expect(twice.progress).toEqual(once.progress);
    expect(twice.reviews).toEqual(once.reviews);
    expect(twice.addedReviews).toBe(0);
    expect(twice.updatedProgress).toBe(0);
  });

  it("never lets a file without history overrule a schedule that has some", () => {
    const mine = answer(FLIMSUM, "2026-03-09T08:00:00.000Z", "easy");
    const historyless = answer(FLIMSUM, "2026-03-09T08:00:00.000Z", "again");

    const merged = mergeSnapshot(snapshotOf(mine), {
      progress: [historyless.progress],
      reviews: [],
    });

    expect(merged.progress).toEqual([mine.progress]);
    expect(merged.reviews).toEqual([mine.review]);
    expect(merged.updatedProgress).toBe(0);
  });

  it("keeps an older file from scheduling a word this device answered later", () => {
    const mine = answer(FLIMSUM, LOCAL_ANSWER, "easy");
    const theirs = answer(FLIMSUM, IMPORTED_ANSWER, "again");

    // Answers without the schedule they produced: only a half-finished restore leaves this.
    const merged = mergeSnapshot(
      { progress: [], reviews: [mine.review] },
      snapshotOf(theirs),
    );

    expect(merged.progress).toEqual([]);
    expect(merged.updatedProgress).toBe(0);
    expect(merged.reviews).toHaveLength(2);
  });

  it("takes the file's schedule when its answers are the newer ones", () => {
    const mine = answer(FLIMSUM, IMPORTED_ANSWER, "again");
    const theirs = answer(FLIMSUM, LOCAL_ANSWER, "easy");

    const merged = mergeSnapshot(
      { progress: [], reviews: [mine.review] },
      snapshotOf(theirs),
    );

    expect(merged.progress).toEqual([theirs.progress]);
    expect(merged.updatedProgress).toBe(1);
  });

  it("merges a word the local list has never heard of", () => {
    const theirs = answer(TRELLUP, IMPORTED_ANSWER);

    // The merge is keyed by id alone and never consults the word list: a schedule for a
    // word this device has not synced yet waits for the sheet to bring the word back.
    const merged = mergeSnapshot({ progress: [], reviews: [] }, snapshotOf(theirs));

    expect(merged.progress).toEqual([theirs.progress]);
    expect(merged.reviews).toEqual([theirs.review]);
  });

  it("merges into an empty install without losing anything from the file", () => {
    const theirs = answer(FLIMSUM, "2026-03-09T08:00:00.000Z");
    const alsoTheirs = answer(GORBIK, "2026-03-08T08:00:00.000Z");

    const merged = mergeSnapshot(
      { progress: [], reviews: [] },
      snapshotOf(theirs, alsoTheirs),
    );

    expect(merged.progress).toEqual([theirs.progress, alsoTheirs.progress]);
    expect(merged.addedReviews).toBe(2);
    expect(merged.updatedProgress).toBe(2);
  });
});

describe("readSnapshot", () => {
  it("writes a file the parser takes back, settings and last sync included", async () => {
    await applySync({
      words: [storedWord(FLIMSUM, "flimsum", 0)],
      syncState: { syncedAt: SYNCED_AT, invalid: [] },
    });
    await writeNewPerDay(7);
    await recordReview({
      id: FLIMSUM,
      rating: "good",
      now: new Date(LOCAL_ANSWER),
    });

    const snapshot = await readSnapshot(new Date(EXPORTED_AT));
    const parsed = parseSnapshot(JSON.stringify(snapshot));

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.snapshot).toEqual(snapshot);
    expect(snapshot.exportedAt).toBe(EXPORTED_AT);
    expect(snapshot.newPerDay).toBe(7);
    expect(snapshot.syncedAt).toBe(SYNCED_AT);
    expect(snapshot.words.map((word) => word.id)).toEqual([FLIMSUM]);
    expect(snapshot.progress.map((row) => row.id)).toEqual([FLIMSUM]);
    expect(snapshot.reviews.map((row) => row.reviewedAt)).toEqual([
      LOCAL_ANSWER,
    ]);
    expect(snapshot.reviews[0]).not.toHaveProperty("seq");
  });

  it("carries nothing rather than something invented when the store is empty", async () => {
    const snapshot = await readSnapshot(new Date(EXPORTED_AT));

    expect(snapshot.newPerDay).toBeNull();
    expect(snapshot.syncedAt).toBeNull();
    expect(snapshot.words).toEqual([]);
    expect(parseSnapshot(JSON.stringify(snapshot)).ok).toBe(true);
  });
});

describe("importSnapshot", () => {
  it("leaves the schedule and the log untouched when the write fails", async () => {
    await recordReview({
      id: FLIMSUM,
      rating: "good",
      now: new Date(LOCAL_ANSWER),
    });
    const progressBefore = await db.progress.toArray();
    const reviewsBefore = await storedReviews();
    expect(progressBefore).toHaveLength(1);
    expect(reviewsBefore).toHaveLength(1);
    // The one path in the app that empties the review log: if the refill cannot land, the
    // emptying must not survive it either.
    const bulkAdd = vi
      .spyOn(db.reviews, "bulkAdd")
      .mockRejectedValue(new Error("this device said no"));

    const result = await importSnapshot(
      snapshotFile(answer(GORBIK, IMPORTED_ANSWER)),
    );

    expect(bulkAdd).toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe(
      "STORAGE_UNAVAILABLE",
    );
    expect(await db.progress.toArray()).toEqual(progressBefore);
    expect(await storedReviews()).toEqual(reviewsBefore);
  });

  it("re-keys the log in answer order and leaves a stale undo with nothing to do", async () => {
    const recorded = await recordReview({
      id: FLIMSUM,
      rating: "good",
      now: new Date(LOCAL_ANSWER),
    });

    const result = await importSnapshot(
      snapshotFile(answer(GORBIK, IMPORTED_ANSWER)),
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.addedReviews).toBe(1);

    const rows = await storedReviews();
    expect(rows.map((row) => row.id)).toEqual([GORBIK, FLIMSUM]);
    expect(rows.map((row) => row.reviewedAt)).toEqual([
      IMPORTED_ANSWER,
      LOCAL_ANSWER,
    ]);
    expect((await db.progress.toArray()).map((row) => row.id).sort()).toEqual(
      [FLIMSUM, GORBIK].sort(),
    );

    // The row the session remembered is no longer the last one, so undo refuses it.
    await expect(undoLastReview(recorded.seq)).resolves.toBeNull();
    expect(await db.reviews.count()).toBe(2);
  });

  it("refuses a file that is not a snapshot and writes nothing", async () => {
    await recordReview({
      id: FLIMSUM,
      rating: "good",
      now: new Date(LOCAL_ANSWER),
    });
    const progressBefore = await db.progress.toArray();
    const reviewsBefore = await storedReviews();

    const result = await importSnapshot('{"version":1,"reviews":"all of them"}');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe("SNAPSHOT_INVALID");
    expect(await db.progress.toArray()).toEqual(progressBefore);
    expect(await storedReviews()).toEqual(reviewsBefore);
  });

  it("refuses text that is not JSON at all and writes nothing", async () => {
    const result = await importSnapshot("progress: quite good actually");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe("SNAPSHOT_INVALID");
    expect(await db.reviews.count()).toBe(0);
    expect(await db.progress.count()).toBe(0);
  });

  it("keeps every local answer when a file arrives with its own", async () => {
    await recordReview({
      id: FLIMSUM,
      rating: "good",
      now: new Date(LOCAL_ANSWER),
    });

    const result = await importSnapshot(
      snapshotFile(
        answer(GORBIK, IMPORTED_ANSWER),
        answer(TRELLUP, "2026-03-07T08:00:00.000Z"),
      ),
    );

    expect(result.ok).toBe(true);
    expect((await storedReviews()).map((row) => row.id)).toEqual([
      TRELLUP,
      GORBIK,
      FLIMSUM,
    ]);
  });
});
