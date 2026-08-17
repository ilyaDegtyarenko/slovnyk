import { describe, expect, it } from "vitest";
import { relativeTimeLabel } from "@/lib/relative-time";

const NOW = new Date("2026-03-10T12:00:00.000Z");

function ago(milliseconds: number): string {
  return new Date(NOW.getTime() - milliseconds).toISOString();
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

describe("relativeTimeLabel", () => {
  it("calls everything under a minute just now", () => {
    expect(relativeTimeLabel(ago(0), NOW)).toBe("just now");
    expect(relativeTimeLabel(ago(59_000), NOW)).toBe("just now");
  });

  it("never dates a sync in the future, whatever the clocks say", () => {
    expect(relativeTimeLabel(ago(-5 * MINUTE_MS), NOW)).toBe("just now");
  });

  it("counts minutes up to an hour", () => {
    expect(relativeTimeLabel(ago(MINUTE_MS), NOW)).toBe("1 min ago");
    expect(relativeTimeLabel(ago(59 * MINUTE_MS + 59_000), NOW)).toBe(
      "59 min ago",
    );
  });

  it("counts hours up to a day, singular and plural", () => {
    expect(relativeTimeLabel(ago(HOUR_MS), NOW)).toBe("1 hour ago");
    expect(relativeTimeLabel(ago(23 * HOUR_MS), NOW)).toBe("23 hours ago");
  });

  it("counts days beyond that, singular and plural", () => {
    expect(relativeTimeLabel(ago(DAY_MS), NOW)).toBe("1 day ago");
    expect(relativeTimeLabel(ago(3 * DAY_MS), NOW)).toBe("3 days ago");
  });

  it("does not invent an age for a timestamp it cannot read", () => {
    expect(relativeTimeLabel("not-a-date", NOW)).toBe("at an unknown time");
  });
});
