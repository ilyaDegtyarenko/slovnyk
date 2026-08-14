"use client";

import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import Link from "next/link";
import { Timestamp } from "@/components/timestamp";
import {
  db,
  readNewPerDay,
  readSyncState,
  readWords,
  writeNewPerDay,
  type SyncState,
} from "@/lib/db";
import { DEFAULT_NEW_PER_DAY } from "@/lib/session";
import { syncFromApi } from "@/lib/sync";
import { importSnapshot, readSnapshot } from "@/lib/transfer";

type SettingsData = {
  wordCount: number;
  orphanedCount: number;
  newPerDay: number;
  syncState: SyncState | undefined;
};

type Outcome = { ok: boolean; message: string };

const SECTION_CLASS_NAME =
  "flex flex-col gap-3 rounded-lg border border-black/10 p-4 dark:border-white/15";

export default function SettingsPage() {
  const [data, setData] = useState<SettingsData | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [newPerDayInput, setNewPerDayInput] = useState("");
  const [newPerDayOutcome, setNewPerDayOutcome] = useState<Outcome | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncOutcome, setSyncOutcome] = useState<Outcome | null>(null);
  const [transferOutcome, setTransferOutcome] = useState<Outcome | null>(null);

  const load = useCallback(async () => {
    try {
      await db.open();
      const [words, storedNewPerDay, syncState] = await Promise.all([
        readWords(),
        readNewPerDay(),
        readSyncState(),
      ]);
      const newPerDay = storedNewPerDay ?? DEFAULT_NEW_PER_DAY;

      setStorageError(null);
      setData({
        wordCount: words.length,
        orphanedCount: words.filter((word) => word.orphaned).length,
        newPerDay,
        syncState,
      });
      setNewPerDayInput(String(newPerDay));
    } catch (cause) {
      setStorageError(
        `The settings could not be read from this device (${describe(cause)}). Nothing typed here would be saved.`,
      );
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  // Committed when the field is left or Enter is pressed, not on every keystroke: typing
  // "12" over a "5" would otherwise store a "1" on the way past.
  const commitNewPerDay = async (): Promise<void> => {
    const newPerDay = Number(newPerDayInput);
    if (
      newPerDayInput.trim() === "" ||
      !Number.isInteger(newPerDay) ||
      newPerDay < 0
    ) {
      setNewPerDayOutcome({
        ok: false,
        message: "Type a whole number of cards, zero or more.",
      });
      return;
    }

    try {
      const saved = await writeNewPerDay(newPerDay);
      // What the database kept, not what was typed at it.
      setNewPerDayInput(String(saved));
      setNewPerDayOutcome({
        ok: true,
        message: `Saved. The next session introduces up to ${saved} new cards.`,
      });
    } catch (cause) {
      setNewPerDayOutcome({
        ok: false,
        message: `This device would not save the setting (${describe(cause)}).`,
      });
    }
  };

  const refreshFromSheet = async (): Promise<void> => {
    setSyncing(true);
    setSyncOutcome(null);

    const result = await syncFromApi({ fresh: true });
    setSyncOutcome(
      result.ok
        ? {
            ok: true,
            message: `Synced ${result.words.filter((word) => !word.orphaned).length} words, ${result.syncState.invalid.length} rows rejected.`,
          }
        : { ok: false, message: `${result.error.code}: ${result.error.message}` },
    );

    await load();
    setSyncing(false);
  };

  const exportProgress = async (): Promise<void> => {
    setTransferOutcome(null);
    try {
      const snapshot = await readSnapshot(new Date());
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(snapshot, null, 2)], {
          type: "application/json",
        }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `slovnyk-${snapshot.exportedAt.slice(0, 10)}.json`;
      document.body.append(anchor);
      anchor.click();
      // iOS Safari — the platform this is installed on — aborts a download whose anchor or
      // blob URL disappears while it is still starting, so both outlive the click by far
      // more than it needs.
      window.setTimeout(() => {
        anchor.remove();
        URL.revokeObjectURL(url);
      }, 10_000);

      setTransferOutcome({
        ok: true,
        message: `Exported ${snapshot.progress.length} schedules and ${snapshot.reviews.length} answers.`,
      });
    } catch (cause) {
      setTransferOutcome({
        ok: false,
        message: `The export could not be built (${describe(cause)}).`,
      });
    }
  };

  const importProgress = async (
    event: ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    const input = event.target;
    const file = input.files?.[0];
    if (file === undefined) {
      return;
    }

    setTransferOutcome(null);
    let text: string;
    try {
      text = await file.text();
    } catch (cause) {
      setTransferOutcome({
        ok: false,
        message: `The file could not be read (${describe(cause)}).`,
      });
      return;
    }

    const result = await importSnapshot(text);
    // Choosing the same file twice in a row still has to raise a change event.
    input.value = "";

    if (!result.ok) {
      setTransferOutcome({ ok: false, message: result.error.message });
      return;
    }

    setTransferOutcome({
      ok: true,
      message: `Imported: ${result.addedReviews} answers added, ${result.updatedProgress} schedules taken from the file.`,
    });
    await load();
  };

  const syncState = data?.syncState;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 py-6 font-sans">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      {storageError === null ? null : (
        <section
          role="alert"
          className="rounded-lg border border-red-500/40 bg-red-500/5 p-4 text-sm"
        >
          {storageError}
        </section>
      )}

      <section className={SECTION_CLASS_NAME}>
        <h2 className="font-medium">New cards per day</h2>
        <label className="flex items-center gap-3 text-sm">
          <input
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            value={newPerDayInput}
            onChange={(event) => {
              setNewPerDayInput(event.target.value);
              setNewPerDayOutcome(null);
            }}
            onBlur={() => void commitNewPerDay()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void commitNewPerDay();
              }
            }}
            className="h-11 w-24 rounded-lg border border-black/10 bg-transparent px-3 text-base dark:border-white/15"
          />
          cards introduced on top of everything that came due, saved when you
          leave the field
        </label>
        <Note outcome={newPerDayOutcome} />
      </section>

      <section className={SECTION_CLASS_NAME}>
        <h2 className="font-medium">Sheet</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {syncState === undefined ? (
            "This device has never synced with the sheet."
          ) : (
            <>
              Last synced <Timestamp iso={syncState.syncedAt} />,{" "}
              {syncState.invalid.length} rows rejected.
            </>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void refreshFromSheet()}
            disabled={syncing}
            className="h-11 rounded-lg bg-foreground px-4 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {syncing ? "Refreshing…" : "Refresh from sheet"}
          </button>
          <Link href="/health" className="text-sm underline underline-offset-4">
            See rejected rows
          </Link>
        </div>
        <Note outcome={syncOutcome} />
      </section>

      <section className={SECTION_CLASS_NAME}>
        <h2 className="font-medium">Progress backup</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          The export carries the schedule and the whole answer log. Importing
          merges by word id, keeping whichever side answered a word last, and
          never drops an answer this device already has.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void exportProgress()}
            className="h-11 rounded-lg border border-black/10 px-4 text-sm font-medium transition-colors hover:bg-black/[.04] dark:border-white/15 dark:hover:bg-white/[.06]"
          >
            Export JSON
          </button>
          <input
            type="file"
            accept="application/json,.json"
            aria-label="Import progress from a JSON file"
            onChange={(event) => void importProgress(event)}
            className="max-w-full text-sm text-zinc-600 file:mr-3 file:h-11 file:cursor-pointer file:rounded-lg file:border file:border-black/10 file:bg-transparent file:px-4 file:text-sm file:font-medium file:text-foreground dark:text-zinc-400 dark:file:border-white/15"
          />
        </div>
        <Note outcome={transferOutcome} />
      </section>

      <section className={SECTION_CLASS_NAME}>
        <h2 className="font-medium">Vocabulary</h2>
        {data === null ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {storageError === null ? "Loading…" : "Unavailable."}
          </p>
        ) : (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {data.wordCount} words cached, {data.orphanedCount} of them orphaned
            — no longer in the sheet, kept with their history and left out of
            the queue.
          </p>
        )}
      </section>
    </main>
  );
}

function Note({ outcome }: { outcome: Outcome | null }) {
  if (outcome === null) {
    return null;
  }

  return (
    <p
      role="status"
      className={`text-sm ${outcome.ok ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"}`}
    >
      {outcome.message}
    </p>
  );
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
