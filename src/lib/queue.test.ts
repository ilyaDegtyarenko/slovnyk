import { describe, expect, it } from "vitest";
import type { ProgressRow, StoredWord } from "@/lib/db";
import { buildQueue } from "@/lib/queue";
import { initialCard, review } from "@/lib/srs";

const NOW = new Date("2026-03-10T08:00:00.000Z");
const FIRST_SEEN = new Date("2026-03-01T08:00:00.000Z");

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
  // A real scheduled card, with only its due date moved: the queue reads nothing else.
  const card = { ...review(initialCard(FIRST_SEEN), "good", FIRST_SEEN).card, due };
  return { id, due, state: card.state, card };
}

describe("buildQueue", () => {
  it("asks for the cards that came due, oldest first", () => {
    const words = [
      storedWord("wa3f19c2b81", "flimsum", 0),
      storedWord("wb7c02d4e19", "gorbik", 1),
      storedWord("wc51e8a0f2d", "trellup", 2),
    ];

    const queue = buildQueue({
      words,
      progress: [
        progressDueAt("wa3f19c2b81", "2026-03-09T08:00:00.000Z"),
        progressDueAt("wb7c02d4e19", "2026-03-05T08:00:00.000Z"),
        progressDueAt("wc51e8a0f2d", "2026-03-10T07:59:59.000Z"),
      ],
      now: NOW,
      newPerDay: 10,
    });

    expect(queue.dueCards.map((word) => word.term)).toEqual([
      "gorbik",
      "flimsum",
      "trellup",
    ]);
    expect(queue.newCards).toEqual([]);
  });

  it("leaves out cards that are not due yet", () => {
    const queue = buildQueue({
      words: [
        storedWord("wa3f19c2b81", "flimsum", 0),
        storedWord("wb7c02d4e19", "gorbik", 1),
      ],
      progress: [
        progressDueAt("wa3f19c2b81", NOW.toISOString()),
        progressDueAt("wb7c02d4e19", "2026-03-10T08:00:01.000Z"),
      ],
      now: NOW,
      newPerDay: 10,
    });

    expect(queue.dueCards.map((word) => word.term)).toEqual(["flimsum"]);
    expect(queue.newCards).toEqual([]);
  });

  it("introduces unseen words in sheet order, up to the daily cap", () => {
    const queue = buildQueue({
      words: [
        storedWord("wc51e8a0f2d", "trellup", 2),
        storedWord("wa3f19c2b81", "flimsum", 0),
        storedWord("wd8a41f6b03", "murnick", 3),
        storedWord("wb7c02d4e19", "gorbik", 1),
      ],
      progress: [],
      now: NOW,
      newPerDay: 2,
    });

    expect(queue.dueCards).toEqual([]);
    expect(queue.newCards.map((word) => word.term)).toEqual([
      "flimsum",
      "gorbik",
    ]);
  });

  it("introduces nothing when the daily cap is zero", () => {
    const queue = buildQueue({
      words: [storedWord("wa3f19c2b81", "flimsum", 0)],
      progress: [],
      now: NOW,
      newPerDay: 0,
    });

    expect(queue.newCards).toEqual([]);
  });

  it("keeps a nonsensical negative cap from letting words through", () => {
    const queue = buildQueue({
      words: [
        storedWord("wa3f19c2b81", "flimsum", 0),
        storedWord("wb7c02d4e19", "gorbik", 1),
      ],
      progress: [],
      now: NOW,
      newPerDay: -1,
    });

    expect(queue.newCards).toEqual([]);
  });

  it("introduces nothing rather than everything when the cap is not a number", () => {
    const queue = buildQueue({
      words: [
        storedWord("wa3f19c2b81", "flimsum", 0),
        storedWord("wb7c02d4e19", "gorbik", 1),
      ],
      progress: [],
      now: NOW,
      newPerDay: Number.NaN,
    });

    expect(queue.newCards).toEqual([]);
  });

  it("treats an infinite cap as corrupt, not as unlimited", () => {
    const queue = buildQueue({
      words: [
        storedWord("wa3f19c2b81", "flimsum", 0),
        storedWord("wb7c02d4e19", "gorbik", 1),
      ],
      progress: [],
      now: NOW,
      newPerDay: Number.POSITIVE_INFINITY,
    });

    expect(queue.newCards).toEqual([]);
  });

  it("asks about a card whose due date it cannot read instead of losing it", () => {
    const queue = buildQueue({
      words: [storedWord("wa3f19c2b81", "flimsum", 0)],
      progress: [progressDueAt("wa3f19c2b81", "not a date")],
      now: NOW,
      newPerDay: 10,
    });

    expect(queue.dueCards.map((word) => word.id)).toEqual(["wa3f19c2b81"]);
    expect(queue.newCards).toEqual([]);
  });

  it("never asks about an orphaned word, due or unseen", () => {
    const queue = buildQueue({
      words: [
        storedWord("wa3f19c2b81", "flimsum", 0, { orphaned: true }),
        storedWord("wb7c02d4e19", "gorbik", 1, { orphaned: true }),
        storedWord("wc51e8a0f2d", "trellup", 2),
      ],
      progress: [progressDueAt("wa3f19c2b81", "2026-03-05T08:00:00.000Z")],
      now: NOW,
      newPerDay: 10,
    });

    expect(queue.dueCards).toEqual([]);
    expect(queue.newCards.map((word) => word.term)).toEqual(["trellup"]);
  });

  it("ignores progress rows whose word is no longer in the list", () => {
    const queue = buildQueue({
      words: [storedWord("wa3f19c2b81", "flimsum", 0)],
      progress: [
        progressDueAt("wa3f19c2b81", "2026-03-05T08:00:00.000Z"),
        progressDueAt("we62b90c7a4", "2026-03-05T08:00:00.000Z"),
      ],
      now: NOW,
      newPerDay: 10,
    });

    expect(queue.dueCards.map((word) => word.id)).toEqual(["wa3f19c2b81"]);
    expect(queue.newCards).toEqual([]);
  });

  it("puts the same data in the same order however the rows arrive", () => {
    const sameDue = "2026-03-09T08:00:00.000Z";
    const words = [
      storedWord("wb7c02d4e19", "gorbik", 1),
      storedWord("wa3f19c2b81", "flimsum", 0),
    ];

    const queue = buildQueue({
      words,
      progress: [
        progressDueAt("wb7c02d4e19", sameDue),
        progressDueAt("wa3f19c2b81", sameDue),
      ],
      now: NOW,
      newPerDay: 10,
    });

    expect(queue.dueCards.map((word) => word.term)).toEqual([
      "flimsum",
      "gorbik",
    ]);
  });
});
