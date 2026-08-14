import { describe, expect, it } from "vitest";
import { Rating, State, createEmptyCard, fsrs } from "ts-fsrs";
import {
  REVIEW_RATINGS,
  initialCard,
  review,
  type ReviewRating,
} from "@/lib/srs";

const NOW = new Date("2026-03-01T08:00:00.000Z");

function dueAfter(rating: ReviewRating): number {
  return Date.parse(review(initialCard(NOW), rating, NOW).card.due);
}

describe("initialCard", () => {
  it("starts a word as unseen and due immediately", () => {
    const card = initialCard(NOW);

    expect(card.state).toBe("New");
    expect(card.due).toBe(NOW.toISOString());
    expect(card.last_review).toBeNull();
    expect(card.reps).toBe(0);
    expect(card.lapses).toBe(0);
  });

  it("stays plain json, so progress can be exported and imported", () => {
    const card = review(initialCard(NOW), "good", NOW).card;

    expect(JSON.parse(JSON.stringify(card))).toEqual(card);
  });
});

describe("review", () => {
  it("moves a new word out of New and schedules it ahead, whatever the rating", () => {
    for (const rating of REVIEW_RATINGS) {
      const outcome = review(initialCard(NOW), rating, NOW);

      expect(outcome.card.state).not.toBe("New");
      expect(outcome.card.reps).toBe(1);
      expect(outcome.card.last_review).toBe(NOW.toISOString());
      expect(Date.parse(outcome.card.due)).toBeGreaterThan(NOW.getTime());
      expect(outcome.reviewedAt).toBe(NOW.toISOString());
    }
  });

  it("keeps the ratings in order: again comes back soonest, easy latest", () => {
    expect(dueAfter("again")).toBeLessThanOrEqual(dueAfter("hard"));
    expect(dueAfter("hard")).toBeLessThanOrEqual(dueAfter("good"));
    expect(dueAfter("good")).toBeLessThanOrEqual(dueAfter("easy"));
    expect(dueAfter("again")).toBeLessThan(dueAfter("easy"));
  });

  it("pushes the due date further out with every answer remembered", () => {
    const first = review(initialCard(NOW), "good", NOW).card;
    const second = review(first, "good", new Date(first.due)).card;
    const third = review(second, "good", new Date(second.due)).card;

    expect(Date.parse(second.due) - Date.parse(first.due)).toBeGreaterThan(
      Date.parse(first.due) - NOW.getTime(),
    );
    expect(Date.parse(third.due)).toBeGreaterThan(Date.parse(second.due));
    expect(third.state).toBe("Review");
    expect(third.reps).toBe(3);
  });

  it("counts a forgotten word as a lapse and relearns it", () => {
    const learned = review(initialCard(NOW), "easy", NOW).card;
    const forgotten = review(learned, "again", new Date(learned.due)).card;

    expect(learned.state).toBe("Review");
    expect(learned.lapses).toBe(0);
    expect(forgotten.state).toBe("Relearning");
    expect(forgotten.lapses).toBe(1);
    expect(Date.parse(forgotten.due)).toBeLessThan(
      Date.parse(review(learned, "easy", new Date(learned.due)).card.due),
    );
  });

  it("schedules exactly what ts-fsrs schedules, inventing no intervals of its own", () => {
    const expected = fsrs().next(createEmptyCard(NOW), NOW, Rating.Good).card;
    const actual = review(initialCard(NOW), "good", NOW).card;

    expect(actual.due).toBe(expected.due.toISOString());
    expect(actual.state).toBe(State[expected.state]);
    expect(actual.stability).toBe(expected.stability);
    expect(actual.difficulty).toBe(expected.difficulty);
    expect(actual.scheduled_days).toBe(expected.scheduled_days);
    expect(actual.learning_steps).toBe(expected.learning_steps);
  });

  it("survives a phone that puts its clock back a day mid-session", () => {
    const learned = review(initialCard(NOW), "good", NOW).card;
    const clockWentBack = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);

    const outcome = review(learned, "good", clockWentBack);

    // ts-fsrs rejects a review that predates the last one; the answer is real, so it is
    // booked at the last review instead of thrown away.
    expect(outcome.reviewedAt).toBe(NOW.toISOString());
    expect(Date.parse(outcome.card.due)).toBeGreaterThan(NOW.getTime());
    expect(outcome.card.reps).toBe(2);
  });

  it("leaves the answered card untouched, so the stored snapshot can undo the answer", () => {
    const before = review(initialCard(NOW), "good", NOW).card;
    const snapshot = structuredClone(before);

    review(before, "again", new Date(before.due));

    expect(before).toEqual(snapshot);
  });
});
