import {
  createEmptyCard,
  fsrs,
  Rating,
  State,
  type Card,
  type Grade,
} from "ts-fsrs";

// The order the four buttons appear in, which is also the order of their `1`-`4` shortcuts.
export const REVIEW_RATINGS = ["again", "hard", "good", "easy"] as const;

export type ReviewRating = (typeof REVIEW_RATINGS)[number];

export type CardState = "New" | "Learning" | "Review" | "Relearning";

// The FSRS card as it is stored and exported: exactly the fields ts-fsrs works with, with
// the dates as ISO strings so a progress row is plain JSON and survives the round trip
// through the export file unchanged.
export type SerializedCard = Omit<Card, "due" | "last_review" | "state"> & {
  due: string;
  last_review: string | null;
  state: CardState;
};

export type ReviewOutcome = {
  card: SerializedCard;
  reviewedAt: string;
};

// Default parameters, and with them fuzz off: every interval in this app is the one
// ts-fsrs computed, never one this module adjusted.
const scheduler = fsrs();

const gradeOfRating: Record<ReviewRating, Grade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

// The enum's own reverse mapping is typed as `string`, and this app needs the four names
// to stay a closed set.
const nameOfState: Record<State, CardState> = {
  [State.New]: "New",
  [State.Learning]: "Learning",
  [State.Review]: "Review",
  [State.Relearning]: "Relearning",
};

export function initialCard(now: Date): SerializedCard {
  return serializeCard(createEmptyCard(now));
}

export type IntervalPreview = Record<ReviewRating, string>;

// What each of the four answers would schedule, worded for a button label. Computed
// through `review` itself, so the promise on the button and the interval an answer
// actually records can never disagree.
export function previewIntervals(
  card: SerializedCard | undefined,
  now: Date,
): IntervalPreview {
  const base = card ?? initialCard(now);
  return {
    again: previewOf(base, "again", now),
    hard: previewOf(base, "hard", now),
    good: previewOf(base, "good", now),
    easy: previewOf(base, "easy", now),
  };
}

function previewOf(
  card: SerializedCard,
  rating: ReviewRating,
  now: Date,
): string {
  const outcome = review(card, rating, now);
  return formatInterval(
    Date.parse(outcome.card.due) - Date.parse(outcome.reviewedAt),
  );
}

// Rounded the way a person says it, not the way a clock counts it: "10 min", "3 h",
// "45 d", "4 mo", "1.5 y". Each unit is rounded first so 59.7 minutes says "1 h",
// never "60 min".
export function formatInterval(durationMillis: number): string {
  const minutes = Math.round(durationMillis / 60_000);
  if (minutes < 60) {
    return `${Math.max(1, minutes)} min`;
  }

  const hours = Math.round(durationMillis / 3_600_000);
  if (hours < 24) {
    return `${hours} h`;
  }

  const days = Math.round(durationMillis / 86_400_000);
  if (days < 60) {
    return `${days} d`;
  }

  const months = Math.round(durationMillis / (30.437 * 86_400_000));
  if (months < 12) {
    return `${months} mo`;
  }

  const years = durationMillis / (365.25 * 86_400_000);
  return `${Math.round(years * 10) / 10} y`;
}

export function review(
  card: SerializedCard,
  rating: ReviewRating,
  now: Date,
): ReviewOutcome {
  const reviewedAt = notBefore(now, card.last_review);

  // ts-fsrs reads the serialized shape as a card input and copies it before scheduling, so
  // `card` stays untouched and remains a valid snapshot for undo.
  const scheduled = scheduler.next(card, reviewedAt, gradeOfRating[rating]);

  // The answer and the card it produced must agree on the same instant, or the review log
  // and the schedule drift apart.
  return {
    card: serializeCard(scheduled.card),
    reviewedAt: reviewedAt.toISOString(),
  };
}

// A phone that corrects its clock backwards would otherwise hand ts-fsrs a review that
// happened before the previous one, which it rejects outright. The answer is real, so it
// is booked at the moment of the last review and ts-fsrs still decides the interval.
function notBefore(now: Date, lastReview: string | null): Date {
  if (lastReview === null) {
    return now;
  }

  const lastReviewMillis = Date.parse(lastReview);
  return Number.isNaN(lastReviewMillis) || now.getTime() >= lastReviewMillis
    ? now
    : new Date(lastReviewMillis);
}

function serializeCard(card: Card): SerializedCard {
  return {
    ...card,
    due: card.due.toISOString(),
    last_review: card.last_review ? card.last_review.toISOString() : null,
    state: nameOfState[card.state],
  };
}
