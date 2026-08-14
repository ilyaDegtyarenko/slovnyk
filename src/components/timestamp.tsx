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
