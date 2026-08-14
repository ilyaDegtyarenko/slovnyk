import { fetchSheet } from "@/lib/sheet";

// The point of this page is to show what the sheet looks like right now, so nothing about
// it may be cached.
export const dynamic = "force-dynamic";

export default async function HealthPage() {
  const result = await fetchSheet({ fresh: true });

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-12 font-sans">
      <h1 className="text-2xl font-semibold tracking-tight">Sheet health</h1>

      {!result.ok ? (
        <section className="rounded-lg border border-red-500/40 bg-red-500/5 p-4">
          <h2 className="font-medium text-red-700 dark:text-red-300">
            Last sync failed
          </h2>
          <p className="mt-2 font-mono text-sm text-zinc-600 dark:text-zinc-400">
            {result.error.code}
          </p>
          <p className="mt-2 text-sm">{result.error.message}</p>
        </section>
      ) : (
        <>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="rounded-lg border border-black/10 p-4 dark:border-white/15">
              <dt className="text-sm text-zinc-600 dark:text-zinc-400">
                Last sync
              </dt>
              <dd className="mt-1 font-mono text-sm">
                <time dateTime={result.sheet.syncedAt}>
                  {result.sheet.syncedAt}
                </time>
              </dd>
            </div>
            <div className="rounded-lg border border-black/10 p-4 dark:border-white/15">
              <dt className="text-sm text-zinc-600 dark:text-zinc-400">
                Valid words
              </dt>
              <dd className="mt-1 text-2xl font-semibold">
                {result.sheet.words.length}
              </dd>
            </div>
            <div className="rounded-lg border border-black/10 p-4 dark:border-white/15">
              <dt className="text-sm text-zinc-600 dark:text-zinc-400">
                Invalid rows
              </dt>
              <dd className="mt-1 text-2xl font-semibold">
                {result.sheet.invalid.length}
              </dd>
            </div>
          </dl>

          <section className="flex flex-col gap-4">
            <h2 className="text-lg font-medium">Invalid rows</h2>
            {result.sheet.invalid.length === 0 ? (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                Every row in the sheet parsed cleanly.
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {result.sheet.invalid.map((invalidRow) => (
                  <li
                    key={invalidRow.row}
                    className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4"
                  >
                    <p className="font-medium">Row {invalidRow.row}</p>
                    <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm">
                      {invalidRow.issues.map((issue, issueIndex) => (
                        <li key={`${invalidRow.row}-${issueIndex}`}>{issue}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}
