// The page itself blocks on a live, uncached fetch of the sheet, so without this the tab
// switch would sit frozen for as long as Google takes to answer.
export default function HealthLoading() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-12 font-sans">
      <h1 className="text-2xl font-semibold tracking-tight">Sheet health</h1>

      <div aria-hidden className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {["sync", "valid", "invalid"].map((placeholder) => (
          <div
            key={placeholder}
            className="h-24 rounded-lg border border-black/5 bg-black/[0.03] motion-safe:animate-pulse dark:border-white/5 dark:bg-white/[0.03]"
          />
        ))}
      </div>

      {/* Mirrors the section the loaded page always renders, so the swap stays put. */}
      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-medium">Invalid rows</h2>
        <p role="status" className="text-sm text-zinc-600 dark:text-zinc-400">
          Asking the sheet how it is doing…
        </p>
      </section>
    </main>
  );
}
