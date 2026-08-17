"use client";

import { useEffect, useState } from "react";
import { relativeTimeLabel } from "@/lib/relative-time";

// Rendered in the reader's own locale and time zone, which is only safe because every page
// that shows a timestamp gets its data after mounting.
export function Timestamp({
  iso,
  precision = "datetime",
}: {
  iso: string;
  precision?: "date" | "datetime";
}) {
  const moment = new Date(iso);

  return (
    <time dateTime={iso}>
      {precision === "date"
        ? moment.toLocaleDateString()
        : moment.toLocaleString()}
    </time>
  );
}

// A relative label left alone goes quietly stale — "5 min ago" must not still say so
// twenty minutes later on a page nobody navigated away from.
const RELATIVE_TICK_MS = 30_000;

export function RelativeTimestamp({ iso }: { iso: string }) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(
      () => setNow(new Date()),
      RELATIVE_TICK_MS,
    );
    return () => window.clearInterval(timer);
  }, []);

  // The absolute moment also stays under the pointer, for the platforms that have one —
  // unless the timestamp is unreadable, where a tooltip saying "Invalid Date" would
  // undercut the label that honestly says the time is unknown.
  const moment = new Date(iso);
  const absolute = Number.isNaN(moment.getTime())
    ? undefined
    : moment.toLocaleString();

  return (
    <time dateTime={iso} title={absolute}>
      {relativeTimeLabel(iso, now)}
    </time>
  );
}
