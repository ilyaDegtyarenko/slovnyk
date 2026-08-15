"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Timestamp } from "@/components/timestamp";
import {
  db,
  readProgress,
  readWords,
  type ProgressRow,
  type StoredWord,
} from "@/lib/db";

type WordState = "new" | "learning" | "review" | "orphaned";

type WordList = {
  words: StoredWord[];
  progressById: Map<string, ProgressRow>;
};

const ALL_TAGS = "";

// The state is a fact, not an alarm: color stays on the word, the border stays quiet.
const chipByState: Record<WordState, string> = {
  new: "text-zinc-500 dark:text-zinc-400",
  learning: "text-amber-600 dark:text-amber-300",
  review: "text-emerald-600 dark:text-emerald-300",
  orphaned: "text-red-600 dark:text-red-300",
};

// Editing happens in the sheet, so the list only points at it. An installation without the
// link configured simply does not offer one.
const sheetEditUrl = process.env.NEXT_PUBLIC_SHEET_EDIT_URL;

export default function ListPage() {
  const [list, setList] = useState<WordList | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [tag, setTag] = useState(ALL_TAGS);

  useEffect(() => {
    void (async () => {
      try {
        await db.open();
        const [words, progress] = await Promise.all([
          readWords(),
          readProgress(),
        ]);
        setList({
          words: [...words].sort((left, right) => left.order - right.order),
          progressById: new Map(progress.map((row) => [row.id, row])),
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setStorageError(
          `The word list could not be read from this device (${message}).`,
        );
      }
    })();
  }, []);

  const tags = useMemo(() => {
    const known = new Set<string>();
    for (const word of list?.words ?? []) {
      for (const wordTag of word.tags) {
        known.add(wordTag);
      }
    }
    return [...known].sort((left, right) => left.localeCompare(right));
  }, [list]);

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (list?.words ?? []).filter(
      (word) =>
        (tag === ALL_TAGS || word.tags.includes(tag)) &&
        (needle === "" ||
          word.term.toLowerCase().includes(needle) ||
          word.translation.toLowerCase().includes(needle)),
    );
  }, [list, search, tag]);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 py-6 font-sans">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Words</h1>
        {sheetEditUrl ? (
          <a
            href={sheetEditUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm underline underline-offset-4 active:opacity-60"
          >
            Edit in the sheet
          </a>
        ) : null}
      </div>

      {storageError === null ? null : (
        <section
          role="alert"
          className="rounded-lg border border-red-500/40 bg-red-500/5 p-4 text-sm"
        >
          {storageError}
        </section>
      )}

      <div className="flex flex-col gap-3">
        <div className="relative">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden
            className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-zinc-400 dark:text-zinc-500"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.2-3.2" />
          </svg>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search term or translation"
            aria-label="Search term or translation"
            className="h-11 w-full rounded-full border border-black/10 bg-black/[.03] pl-11 pr-4 text-base transition-colors placeholder:text-zinc-400 dark:border-white/10 dark:bg-white/[.04] dark:placeholder:text-zinc-500"
          />
        </div>

        {/* Toggle chips instead of a native select: every option is one tap, and nothing
            here looks like the platform's form chrome. */}
        {tags.length === 0 ? null : (
          <div
            role="group"
            aria-label="Filter by tag"
            className="flex flex-wrap items-center gap-1.5"
          >
            <TagChip active={tag === ALL_TAGS} onSelect={() => setTag(ALL_TAGS)}>
              All tags
            </TagChip>
            {tags.map((known) => (
              <TagChip
                key={known}
                active={tag === known}
                onSelect={() => setTag(known)}
              >
                {known}
              </TagChip>
            ))}
          </div>
        )}
      </div>

      {list === null ? (
        storageError === null ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Loading the cached word list…
          </p>
        ) : null
      ) : (
        <>
          {list.words.length === 0 ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              No words are cached on this device yet.{" "}
              <Link
                href="/settings"
                className="underline underline-offset-4 active:opacity-60"
              >
                Refresh from the sheet in Settings
              </Link>{" "}
              to fetch them.
            </p>
          ) : (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {shown.length} of {list.words.length} words
            </p>
          )}

          <ul className="flex flex-col gap-2">
            {shown.map((word) => {
              const progress = list.progressById.get(word.id);
              const state = stateOf(word, progress);
              return (
                <li
                  key={word.id}
                  className="flex flex-col gap-1 rounded-2xl border border-black/10 p-4 dark:border-white/10"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium">{word.term}</span>
                    <span
                      className={`shrink-0 rounded-full border border-black/10 px-2 py-0.5 text-xs dark:border-white/10 ${chipByState[state]}`}
                    >
                      {state}
                    </span>
                  </div>
                  <span className="text-sm text-zinc-600 dark:text-zinc-400">
                    {word.translation}
                  </span>
                  {word.example === "" ? null : (
                    <span className="text-sm italic text-zinc-500">
                      {word.example}
                    </span>
                  )}
                  <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
                    {progress === undefined ? null : (
                      <span>
                        due <Timestamp iso={progress.due} precision="date" />
                      </span>
                    )}
                    {word.tags.map((wordTag) => (
                      <span
                        key={wordTag}
                        className="rounded bg-black/[.06] px-1.5 py-0.5 dark:bg-white/[.08]"
                      >
                        {wordTag}
                      </span>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>

          {shown.length === 0 && list.words.length > 0 ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              No word matches this search.
            </p>
          ) : null}
        </>
      )}
    </main>
  );
}

function TagChip({
  active,
  onSelect,
  children,
}: {
  active: boolean;
  onSelect: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      className={`flex h-11 items-center rounded-full px-4 text-sm transition-[background-color,color,transform] duration-150 active:scale-[0.97] ${
        active
          ? "bg-foreground font-medium text-background"
          : "border border-black/10 text-zinc-600 hover:bg-black/[.04] dark:border-white/15 dark:text-zinc-400 dark:hover:bg-white/[.06]"
      }`}
    >
      {children}
    </button>
  );
}

function stateOf(word: StoredWord, progress: ProgressRow | undefined): WordState {
  if (word.orphaned) {
    return "orphaned";
  }
  if (progress === undefined || progress.state === "New") {
    return "new";
  }
  return progress.state === "Review" ? "review" : "learning";
}
