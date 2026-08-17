// The user tells stale from broken by the age of the last sync (SPEC §3.1), and an age
// reads faster than an absolute stamp. Everything under a minute — including a timestamp
// a skewed clock put in the future — is "just now", so the label can never claim a sync
// that has not happened yet.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function relativeTimeLabel(iso: string, now: Date): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return "at an unknown time";
  }

  const elapsed = now.getTime() - then;
  if (elapsed < MINUTE_MS) {
    return "just now";
  }
  if (elapsed < HOUR_MS) {
    return `${Math.floor(elapsed / MINUTE_MS)} min ago`;
  }
  if (elapsed < DAY_MS) {
    const hours = Math.floor(elapsed / HOUR_MS);
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }

  const days = Math.floor(elapsed / DAY_MS);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}
