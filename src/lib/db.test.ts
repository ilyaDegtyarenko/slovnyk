import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applySync,
  db,
  readLastSyncError,
  readNewPerDay,
  readSyncState,
  recordReview,
  recordSyncFailure,
  undoLastReview,
  writeNewPerDay,
  type StoredWord,
} from "@/lib/db";
import { initialCard, review } from "@/lib/srs";

const FLIMSUM = "wa3f19c2b81";
const GORBIK = "wb7c02d4e19";

const FIRST_ANSWER = new Date("2026-03-01T08:00:00.000Z");
const SECOND_ANSWER = new Date("2026-03-02T08:00:00.000Z");
const THIRD_ANSWER = new Date("2026-03-03T08:00:00.000Z");

function storedWord(
  id: string,
  term: string,
  order: number,
  overrides: Partial<StoredWord> = {},
): StoredWord {
  return {
    id,
    term,
    translation: `${term} in english`,
    example: "",
    tags: [],
    added: "2026-03-01",
    order,
    orphaned: false,
    updatedAt: FIRST_ANSWER.toISOString(),
    ...overrides,
  };
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

describe("recordReview", () => {
  it("stores the scheduled card with its due date and state alongside it", async () => {
    const recorded = await recordReview({
      id: FLIMSUM,
      rating: "good",
      now: FIRST_ANSWER,
    });

    const stored = await db.progress.get(FLIMSUM);
    const expected = review(initialCard(FIRST_ANSWER), "good", FIRST_ANSWER).card;

    expect(stored).toEqual({
      id: FLIMSUM,
      due: expected.due,
      state: expected.state,
      card: expected,
    });
    expect(stored?.due).toBe(stored?.card.due);
    expect(stored?.state).toBe(stored?.card.state);
    expect(recorded.progress).toEqual(stored);
    expect(recorded.seq).toBeGreaterThan(0);
  });

  it("logs the card as it stood before the answer", async () => {
    await recordReview({ id: FLIMSUM, rating: "good", now: FIRST_ANSWER });
    const afterFirst = await db.progress.get(FLIMSUM);
    await recordReview({ id: FLIMSUM, rating: "hard", now: SECOND_ANSWER });

    const logged = await db.reviews.toArray();

    expect(logged.map((row) => row.rating)).toEqual(["good", "hard"]);
    expect(logged[0].before.state).toBe("New");
    expect(logged[1].before).toEqual(afterFirst?.card);
    expect(logged[1].reviewedAt).toBe(SECOND_ANSWER.toISOString());
  });

  it("writes nothing at all when the review log refuses the answer", async () => {
    vi.spyOn(db.reviews, "add").mockRejectedValue(new Error("quota exceeded"));

    await expect(
      recordReview({ id: FLIMSUM, rating: "good", now: FIRST_ANSWER }),
    ).rejects.toThrow("quota exceeded");

    // A progress row without its review row is a schedule nobody can explain or undo.
    expect(await db.progress.count()).toBe(0);
    expect(await db.reviews.count()).toBe(0);
  });
});

describe("undoLastReview", () => {
  it("takes a first answer back to a word that was never studied", async () => {
    const recorded = await recordReview({
      id: FLIMSUM,
      rating: "good",
      now: FIRST_ANSWER,
    });

    const undoneId = await undoLastReview(recorded.seq);

    expect(undoneId).toBe(FLIMSUM);
    expect(await db.progress.get(FLIMSUM)).toBeUndefined();
    expect(await db.reviews.count()).toBe(0);
  });

  it("restores the exact schedule a later answer replaced", async () => {
    await recordReview({ id: FLIMSUM, rating: "good", now: FIRST_ANSWER });
    const afterFirst = await db.progress.get(FLIMSUM);
    const second = await recordReview({
      id: FLIMSUM,
      rating: "again",
      now: SECOND_ANSWER,
    });

    const undoneId = await undoLastReview(second.seq);

    expect(undoneId).toBe(FLIMSUM);
    expect(await db.progress.get(FLIMSUM)).toEqual(afterFirst);
    expect(await db.reviews.count()).toBe(1);
  });

  it("refuses a second undo of the same answer", async () => {
    await recordReview({ id: FLIMSUM, rating: "good", now: FIRST_ANSWER });
    const second = await recordReview({
      id: FLIMSUM,
      rating: "good",
      now: SECOND_ANSWER,
    });
    await undoLastReview(second.seq);
    const afterUndo = await db.progress.get(FLIMSUM);

    const undoneAgain = await undoLastReview(second.seq);

    expect(undoneAgain).toBeNull();
    expect(await db.progress.get(FLIMSUM)).toEqual(afterUndo);
    expect(await db.reviews.count()).toBe(1);
  });

  it("has nothing to undo on an empty log", async () => {
    expect(await undoLastReview(1)).toBeNull();
  });

  it("keeps schedule and log agreeing when the log refuses to give up its row", async () => {
    await recordReview({ id: FLIMSUM, rating: "good", now: FIRST_ANSWER });
    const second = await recordReview({
      id: FLIMSUM,
      rating: "again",
      now: SECOND_ANSWER,
    });
    const beforeUndo = await db.progress.get(FLIMSUM);
    vi.spyOn(db.reviews, "delete").mockRejectedValue(new Error("io error"));

    await expect(undoLastReview(second.seq)).rejects.toThrow("io error");

    // A restored schedule beside a surviving review row would disagree about history.
    expect(await db.progress.get(FLIMSUM)).toEqual(beforeUndo);
    expect(await db.reviews.count()).toBe(2);
  });

  it("lets a fresh answer be undone after an earlier undo", async () => {
    await recordReview({ id: FLIMSUM, rating: "good", now: FIRST_ANSWER });
    const second = await recordReview({
      id: FLIMSUM,
      rating: "again",
      now: SECOND_ANSWER,
    });
    await undoLastReview(second.seq);
    const afterUndo = await db.progress.get(FLIMSUM);

    const third = await recordReview({
      id: FLIMSUM,
      rating: "hard",
      now: THIRD_ANSWER,
    });

    expect(third.seq).not.toBe(second.seq);
    expect(await undoLastReview(third.seq)).toBe(FLIMSUM);
    expect(await db.progress.get(FLIMSUM)).toEqual(afterUndo);
    expect(await db.reviews.count()).toBe(1);
  });

  it("undoes the newest answer, not the newest one it happens to read first", async () => {
    const recorded = [];
    for (let index = 0; index < 12; index += 1) {
      recorded.push(
        await recordReview({
          id: `w${index}`,
          rating: "good",
          now: new Date(FIRST_ANSWER.getTime() + index * 60_000),
        }),
      );
    }
    const last = recorded[recorded.length - 1];

    expect(await undoLastReview(recorded[0].seq)).toBeNull();
    expect(await undoLastReview(last.seq)).toBe("w11");
    expect(await db.reviews.count()).toBe(11);
    expect(await db.progress.get("w11")).toBeUndefined();
    expect(await db.progress.count()).toBe(11);
  });
});

describe("applySync", () => {
  it("replaces the word list and leaves every review untouched", async () => {
    await recordReview({ id: FLIMSUM, rating: "good", now: FIRST_ANSWER });
    await recordReview({ id: GORBIK, rating: "easy", now: FIRST_ANSWER });
    const progressBefore = await db.progress.toArray();
    const reviewsBefore = await db.reviews.toArray();

    await applySync({
      words: [
        storedWord(FLIMSUM, "flimsúm", 0, { updatedAt: "2026-03-05T08:00:00.000Z" }),
        storedWord(GORBIK, "gorbik", 1, { orphaned: true }),
      ],
      syncState: {
        syncedAt: "2026-03-05T08:00:00.000Z",
        invalid: [{ row: 7, issues: ["term: too small"] }],
      },
    });

    expect(await db.progress.toArray()).toEqual(progressBefore);
    expect(await db.reviews.toArray()).toEqual(reviewsBefore);
    expect((await db.words.get(FLIMSUM))?.term).toBe("flimsúm");
    expect((await db.words.get(GORBIK))?.orphaned).toBe(true);
    expect(await readSyncState()).toEqual({
      syncedAt: "2026-03-05T08:00:00.000Z",
      invalid: [{ row: 7, issues: ["term: too small"] }],
    });
  });

  it("clears a remembered failure once a sync gets through", async () => {
    await recordSyncFailure({
      code: "OFFLINE",
      message: "no network",
      at: FIRST_ANSWER.toISOString(),
    });
    expect(await readLastSyncError()).toBeDefined();

    await applySync({
      words: [],
      syncState: { syncedAt: SECOND_ANSWER.toISOString(), invalid: [] },
    });

    expect(await readLastSyncError()).toBeUndefined();
  });
});

describe("meta", () => {
  it("remembers a failed sync without touching the last good one", async () => {
    await applySync({
      words: [],
      syncState: { syncedAt: FIRST_ANSWER.toISOString(), invalid: [] },
    });

    await recordSyncFailure({
      code: "SHEET_NOT_PUBLISHED",
      message: "publish the sheet",
      at: SECOND_ANSWER.toISOString(),
    });

    expect(await readSyncState()).toEqual({
      syncedAt: FIRST_ANSWER.toISOString(),
      invalid: [],
    });
    expect(await readLastSyncError()).toEqual({
      code: "SHEET_NOT_PUBLISHED",
      message: "publish the sheet",
      at: SECOND_ANSWER.toISOString(),
    });
  });

  it("has no answer about a sync that never happened", async () => {
    expect(await readSyncState()).toBeUndefined();
    expect(await readLastSyncError()).toBeUndefined();
    expect(await readNewPerDay()).toBeUndefined();
  });

  it("stores a daily cap that can never empty the queue by accident", async () => {
    expect(await writeNewPerDay(15)).toBe(15);
    expect(await readNewPerDay()).toBe(15);

    expect(await writeNewPerDay(Number.NaN)).toBe(0);
    expect(await readNewPerDay()).toBe(0);

    expect(await writeNewPerDay(-3)).toBe(0);
    expect(await readNewPerDay()).toBe(0);

    expect(await writeNewPerDay(7.9)).toBe(7);
    expect(await readNewPerDay()).toBe(7);
  });
});
