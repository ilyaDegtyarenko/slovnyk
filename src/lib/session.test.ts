import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  db,
  recordReview,
  undoLastReview,
  writeNewPerDay,
  type ProgressRow,
  type ReviewRow,
  type StoredWord,
} from "@/lib/db";
import {
  actionForKey,
  countNewCards,
  countsLabel,
  loadSession,
  putInFront,
  startOfDay,
  syncNotice,
  upcomingCards,
  type QueueCard,
} from "@/lib/session";
import { initialCard, review } from "@/lib/srs";
import type { SyncError } from "@/lib/sync";

const FLIMSUM = "wa3f19c2b81";
const GORBIK = "wb7c02d4e19";
const TRELLUP = "wc51e8a0f2d";
const MURNICK = "wd8a41f6b03";

const FIRST_SEEN = new Date("2026-03-01T08:00:00.000Z");
const NOW = new Date("2026-03-10T08:00:00.000Z");

// Local wall-clock moments: the daily cap is counted from the user's own midnight.
const YESTERDAY_LATE = new Date(2026, 2, 9, 23, 30);
const TODAY_EARLY = new Date(2026, 2, 10, 0, 30);
const TODAY_MORNING = new Date(2026, 2, 10, 9, 0);

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
    updatedAt: FIRST_SEEN.toISOString(),
    ...overrides,
  };
}

function progressDueAt(id: string, due: string): ProgressRow {
  const card = { ...review(initialCard(FIRST_SEEN), "good", FIRST_SEEN).card, due };
  return { id, due, state: card.state, card };
}

function reviewRow(id: string, before: ReviewRow["before"]): ReviewRow {
  return { id, reviewedAt: NOW.toISOString(), rating: "good", before };
}

// Four invented words in sheet order, which is the order new cards are introduced in.
const SHEET = [
  storedWord(FLIMSUM, "flimsum", 0),
  storedWord(GORBIK, "gorbik", 1),
  storedWord(TRELLUP, "trellup", 2),
  storedWord(MURNICK, "murnick", 3),
];

async function seedSheet(newPerDay: number): Promise<void> {
  await db.words.bulkPut(SHEET);
  await writeNewPerDay(newPerDay);
}

async function newCardIds(now: Date): Promise<string[]> {
  const result = await loadSession(now);
  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return result.session.queue
    .filter((card) => card.kind === "new")
    .map((card) => card.word.id);
}

beforeEach(async () => {
  await Promise.all([
    db.words.clear(),
    db.progress.clear(),
    db.reviews.clear(),
    db.meta.clear(),
  ]);
});

describe("startOfDay", () => {
  it("moves back to the user's own midnight", () => {
    const start = startOfDay(new Date(2026, 2, 10, 21, 30, 15, 250));

    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(2);
    expect(start.getDate()).toBe(10);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(start.getSeconds()).toBe(0);
    expect(start.getMilliseconds()).toBe(0);
  });

  it("leaves the clock it was given alone", () => {
    const now = new Date(2026, 2, 10, 21, 30);

    startOfDay(now);

    expect(now.getHours()).toBe(21);
  });
});

describe("countNewCards", () => {
  it("counts the answers that introduced a word, not every answer", () => {
    const unseen = initialCard(FIRST_SEEN);
    const learning = review(unseen, "good", FIRST_SEEN).card;

    const introduced = countNewCards([
      reviewRow(FLIMSUM, unseen),
      reviewRow(GORBIK, unseen),
      reviewRow(FLIMSUM, learning),
      reviewRow(TRELLUP, learning),
    ]);

    expect(introduced).toBe(2);
  });

  it("counts nothing on a day with no answers", () => {
    expect(countNewCards([])).toBe(0);
  });
});

describe("upcomingCards", () => {
  it("names the cards that come back soonest, in the order they return", () => {
    const upcoming = upcomingCards({
      words: [
        storedWord(FLIMSUM, "flimsum", 0),
        storedWord(GORBIK, "gorbik", 1),
        storedWord(TRELLUP, "trellup", 2),
      ],
      progress: [
        progressDueAt(FLIMSUM, "2026-03-12T08:00:00.000Z"),
        progressDueAt(GORBIK, "2026-03-11T08:00:00.000Z"),
        progressDueAt(TRELLUP, "2026-03-13T08:00:00.000Z"),
      ],
      now: NOW,
      limit: 5,
    });

    expect(upcoming.map((entry) => entry.word.term)).toEqual([
      "gorbik",
      "flimsum",
      "trellup",
    ]);
    // Each entry carries its own schedule, so studying ahead can preview intervals.
    expect(upcoming.map((entry) => entry.card.due)).toEqual(
      upcoming.map((entry) => entry.due),
    );
  });

  it("offers only cards that are not due yet, since the due ones are the queue", () => {
    const upcoming = upcomingCards({
      words: [storedWord(FLIMSUM, "flimsum", 0), storedWord(GORBIK, "gorbik", 1)],
      progress: [
        progressDueAt(FLIMSUM, NOW.toISOString()),
        progressDueAt(GORBIK, "2026-03-11T08:00:00.000Z"),
      ],
      now: NOW,
      limit: 5,
    });

    expect(upcoming.map((entry) => entry.word.term)).toEqual(["gorbik"]);
  });

  it("stops at the limit it was given", () => {
    const upcoming = upcomingCards({
      words: [storedWord(FLIMSUM, "flimsum", 0), storedWord(GORBIK, "gorbik", 1)],
      progress: [
        progressDueAt(FLIMSUM, "2026-03-11T08:00:00.000Z"),
        progressDueAt(GORBIK, "2026-03-12T08:00:00.000Z"),
      ],
      now: NOW,
      limit: 1,
    });

    expect(upcoming.map((entry) => entry.word.term)).toEqual(["flimsum"]);
  });

  it("never offers a word the tutor took out of the sheet", () => {
    const upcoming = upcomingCards({
      words: [storedWord(FLIMSUM, "flimsum", 0, { orphaned: true })],
      progress: [progressDueAt(FLIMSUM, "2026-03-11T08:00:00.000Z")],
      now: NOW,
      limit: 5,
    });

    expect(upcoming).toEqual([]);
  });

  it("ignores a schedule whose word is not in the list", () => {
    const upcoming = upcomingCards({
      words: [storedWord(FLIMSUM, "flimsum", 0)],
      progress: [
        progressDueAt(FLIMSUM, "2026-03-11T08:00:00.000Z"),
        progressDueAt(GORBIK, "2026-03-11T08:00:00.000Z"),
      ],
      now: NOW,
      limit: 5,
    });

    expect(upcoming.map((entry) => entry.word.id)).toEqual([FLIMSUM]);
  });
});

describe("putInFront", () => {
  it("puts the undone card back at the head of the queue", () => {
    const undone: QueueCard = {
      word: storedWord(TRELLUP, "trellup", 2),
      kind: "due",
      card: undefined,
    };
    const queue: QueueCard[] = [
      { word: storedWord(FLIMSUM, "flimsum", 0), kind: "due", card: undefined },
      { word: storedWord(GORBIK, "gorbik", 1), kind: "new", card: undefined },
    ];

    expect(putInFront(queue, undone).map((entry) => entry.word.term)).toEqual([
      "trellup",
      "flimsum",
      "gorbik",
    ]);
  });

  it("does not ask the same card twice when the rebuilt queue already has it", () => {
    const undone: QueueCard = {
      word: storedWord(FLIMSUM, "flimsum", 0),
      kind: "due",
      card: undefined,
    };
    const queue: QueueCard[] = [
      { word: storedWord(FLIMSUM, "flimsum", 0), kind: "due", card: undefined },
      { word: storedWord(GORBIK, "gorbik", 1), kind: "new", card: undefined },
    ];

    expect(putInFront(queue, undone).map((entry) => entry.word.term)).toEqual([
      "flimsum",
      "gorbik",
    ]);
  });
});

describe("countsLabel", () => {
  it("says what is left of the day in plain words, due and new apart", () => {
    const queue: QueueCard[] = [
      { word: storedWord(FLIMSUM, "flimsum", 0), kind: "due", card: undefined },
      { word: storedWord(GORBIK, "gorbik", 1), kind: "new", card: undefined },
      { word: storedWord(TRELLUP, "trellup", 2), kind: "new", card: undefined },
    ];

    expect(countsLabel(queue)).toBe("1 to review · 2 new");
  });

  it("says nothing at all about an empty queue", () => {
    expect(countsLabel([])).toBe("");
  });

  it("names only the kinds that are actually there", () => {
    const queue: QueueCard[] = [
      { word: storedWord(FLIMSUM, "flimsum", 0), kind: "ahead", card: undefined },
    ];

    expect(countsLabel(queue)).toBe("1 ahead of schedule");
  });
});

describe("actionForKey", () => {
  it("flips on Space, whichever face is up", () => {
    expect(actionForKey(" ", { revealed: false })).toEqual({ type: "flip" });
    expect(actionForKey(" ", { revealed: true })).toEqual({ type: "flip" });
  });

  it("undoes on U, in either case", () => {
    expect(actionForKey("u", { revealed: false })).toEqual({ type: "undo" });
    expect(actionForKey("U", { revealed: true })).toEqual({ type: "undo" });
  });

  it("maps 1 to 4 onto the ratings in the order they are shown", () => {
    expect(actionForKey("1", { revealed: true })).toEqual({
      type: "rate",
      rating: "again",
    });
    expect(actionForKey("2", { revealed: true })).toEqual({
      type: "rate",
      rating: "hard",
    });
    expect(actionForKey("3", { revealed: true })).toEqual({
      type: "rate",
      rating: "good",
    });
    expect(actionForKey("4", { revealed: true })).toEqual({
      type: "rate",
      rating: "easy",
    });
  });

  it("refuses to grade a card whose answer is still hidden", () => {
    expect(actionForKey("3", { revealed: false })).toEqual({ type: "ignore" });
  });

  it("ignores every other key", () => {
    for (const key of ["0", "5", "Enter", "Escape", "a", "ArrowLeft"]) {
      expect(actionForKey(key, { revealed: true })).toEqual({ type: "ignore" });
    }
  });
});

describe("syncNotice", () => {
  it("keeps studying and says offline only when the connection is the problem", () => {
    for (const code of ["OFFLINE", "SHEET_UNREACHABLE"] as const) {
      const notice = syncNotice({ code, message: "…" });

      expect(notice.blocking).toBe(false);
      expect(notice.title.toLowerCase()).toMatch(/offline|not be reached/);
    }
  });

  it("blocks on a sheet that came back with nothing usable, and points at health", () => {
    const notice = syncNotice({ code: "EMPTY_SHEET", message: "…" });

    expect(notice.blocking).toBe(true);
    expect(notice.showHealthLink).toBe(true);
  });

  it("never calls a broken sheet an offline device", () => {
    const codes = [
      "SHEET_NOT_PUBLISHED",
      "SHEET_CSV_URL_MISSING",
      "SHEET_CSV_URL_INVALID",
      "SYNC_RESPONSE_INVALID",
    ] as const satisfies readonly SyncError["code"][];

    for (const code of codes) {
      const notice = syncNotice({ code, message: "…" });

      expect(notice.blocking).toBe(false);
      expect(notice.showHealthLink).toBe(true);
      expect(notice.title.toLowerCase()).not.toContain("offline");
    }
  });

  it("reports a sync that could not be stored as a failed sync, not as an outage", () => {
    const notice = syncNotice({ code: "STORAGE_UNAVAILABLE", message: "…" });

    expect(notice.blocking).toBe(false);
    expect(notice.title.toLowerCase()).not.toContain("offline");
  });
});

describe("loadSession", () => {
  it("introduces the day's cap minus the new cards already answered today", async () => {
    await seedSheet(3);
    await recordReview({ id: FLIMSUM, rating: "good", now: TODAY_MORNING });

    const result = await loadSession(TODAY_MORNING);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(
      result.session.queue
        .filter((card) => card.kind === "new")
        .map((card) => card.word.id),
    ).toEqual([GORBIK, TRELLUP]);
    expect(result.session.answersToday).toBe(1);
    expect(result.session.wordCount).toBe(SHEET.length);
  });

  it("counts the day from the user's own midnight, not the last 24 hours", async () => {
    await seedSheet(3);
    await recordReview({ id: FLIMSUM, rating: "good", now: YESTERDAY_LATE });
    await recordReview({ id: GORBIK, rating: "good", now: TODAY_EARLY });

    const result = await loadSession(TODAY_MORNING);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Yesterday's answer is spent history: only today's costs the cap a card.
    expect(result.session.answersToday).toBe(1);
    expect(
      result.session.queue
        .filter((card) => card.kind === "new")
        .map((card) => card.word.id),
    ).toEqual([TRELLUP, MURNICK]);
  });

  it("gives the allowance back when the answer that spent it is undone", async () => {
    await seedSheet(1);
    const recorded = await recordReview({
      id: FLIMSUM,
      rating: "good",
      now: TODAY_MORNING,
    });

    expect(await newCardIds(TODAY_MORNING)).toEqual([]);

    const undone = await undoLastReview(recorded.seq);

    expect(undone).toBe(FLIMSUM);
    expect(await newCardIds(TODAY_MORNING)).toEqual([FLIMSUM]);
  });

  it("hands a due card its schedule and a new card none", async () => {
    await seedSheet(3);
    const due = progressDueAt(FLIMSUM, "2026-03-09T08:00:00.000Z");
    await db.progress.put(due);

    const result = await loadSession(TODAY_MORNING);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const [first, ...introduced] = result.session.queue;
    expect(first.kind).toBe("due");
    expect(first.card).toEqual(due.card);
    expect(introduced.length).toBeGreaterThan(0);
    for (const card of introduced) {
      expect(card.kind).toBe("new");
      expect(card.card).toBeUndefined();
    }
  });

  it("introduces nothing once the day has run past its cap", async () => {
    await seedSheet(1);
    for (const id of [FLIMSUM, GORBIK, TRELLUP]) {
      await recordReview({ id, rating: "good", now: TODAY_MORNING });
    }

    expect(await newCardIds(TODAY_MORNING)).toEqual([]);
  });
});
