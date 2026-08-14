"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Timestamp } from "@/components/timestamp";
import { recordReview, undoLastReview } from "@/lib/db";
import {
  actionForKey,
  countsLabel,
  loadSession,
  putInFront,
  syncNotice,
  type QueueCard,
  type StudySession,
} from "@/lib/session";
import { REVIEW_RATINGS, type ReviewRating } from "@/lib/srs";
import { syncFromApi, type SyncError } from "@/lib/sync";

const CARD_CLASS_NAME =
  "flex flex-1 flex-col items-center justify-center gap-6 rounded-2xl border border-black/10 p-6 text-center dark:border-white/15";

const BUTTON_CLASS_NAME =
  "flex h-11 items-center gap-2 rounded-lg border border-black/10 px-3 text-sm transition-colors hover:bg-black/[.04] disabled:opacity-40 disabled:hover:bg-transparent dark:border-white/15 dark:hover:bg-white/[.06]";

const borderByRating: Record<ReviewRating, string> = {
  again: "border-red-500/50 hover:bg-red-500/10",
  hard: "border-amber-500/50 hover:bg-amber-500/10",
  good: "border-emerald-500/50 hover:bg-emerald-500/10",
  easy: "border-sky-500/50 hover:bg-sky-500/10",
};

const NOTHING_TO_UNDO =
  "Nothing to undo — that answer is no longer the last one in the log.";

// The answer undo would roll back, held with the log row it wrote so that a second undo —
// or a key held down — cannot reach past it into the answer before.
type Undoable = { card: QueueCard; seq: number };

export default function StudyPage() {
  const [session, setSession] = useState<StudySession | null>(null);
  const [queue, setQueue] = useState<QueueCard[]>([]);
  const [revealed, setRevealed] = useState(false);
  const [undoable, setUndoable] = useState<Undoable | null>(null);
  const [undoNotice, setUndoNotice] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<SyncError | null>(null);
  const [syncErrorSeen, setSyncErrorSeen] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const answering = useRef(false);
  const hasAnswered = useRef(false);
  // React has not re-rendered by the time an answer finishes, so the queue still shows the
  // card that was just answered. The id of that card outlives the render and is what turns
  // a second key press in the same tick away.
  const answeredCardId = useRef<string | null>(null);

  const refresh = useCallback(async (): Promise<StudySession | null> => {
    const result = await loadSession(new Date());
    if (!result.ok) {
      setStorageError(result.error.message);
      return null;
    }

    setStorageError(null);
    setSession(result.session);
    return result.session;
  }, []);

  // Takes the freshly built daily queue as well, which is what starting or finishing a
  // session means. Undo deliberately does not do this: see below.
  const restart = useCallback(async (): Promise<void> => {
    const loaded = await refresh();
    if (loaded === null) {
      return;
    }

    setQueue(loaded.queue);
    setRevealed(false);
    answeredCardId.current = null;
  }, [refresh]);

  useEffect(() => {
    void (async () => {
      await restart();

      // The cached list is on screen by now, so the sheet is only ever a refinement of it.
      const synced = await syncFromApi({ fresh: false });
      if (!synced.ok) {
        setSyncError(synced.error);
        setSyncErrorSeen(false);
        return;
      }

      setSyncError(null);
      // Rebuilding under a session already in progress would shuffle the cards out from
      // under the user; the next queue picks the edits up anyway.
      if (!hasAnswered.current) {
        await restart();
      }
    })();
  }, [restart]);

  const answer = useCallback(
    async (rating: ReviewRating) => {
      setUndoNotice(null);
      const current = queue[0];
      if (
        current === undefined ||
        answering.current ||
        answeredCardId.current === current.word.id
      ) {
        return;
      }

      answering.current = true;
      answeredCardId.current = current.word.id;
      try {
        const recorded = await recordReview({
          id: current.word.id,
          rating,
          now: new Date(),
        });
        hasAnswered.current = true;
        setUndoable({ card: current, seq: recorded.seq });
        setRevealed(false);

        const rest = queue.slice(1);
        setQueue(rest);
        // The queue is spent: ask the database what is left, which is also what the
        // finished screen reports.
        if (rest.length === 0) {
          await restart();
        }
      } catch (cause) {
        // The answer never landed, so the card has to stay answerable.
        answeredCardId.current = null;
        setStorageError(saveFailureMessage(cause));
      } finally {
        answering.current = false;
      }
    },
    [queue, restart],
  );

  const undo = useCallback(async () => {
    if (undoable === null || answering.current) {
      return;
    }

    answering.current = true;
    setUndoNotice(null);
    try {
      const undoneId = await undoLastReview(undoable.seq);
      // Undo reaches back one answer and no further, so the offer is spent either way.
      setUndoable(null);
      if (undoneId === null) {
        setUndoNotice(NOTHING_TO_UNDO);
        return;
      }

      // The queue in hand is kept rather than rebuilt: a queue of cards pulled forward is
      // not the daily one, and rebuilding would throw the rest of them away.
      setQueue((current) => putInFront(current, undoable.card));
      setRevealed(false);
      answeredCardId.current = null;
      // The counts and the next-due line come from the database, and the answer just
      // rolled back was in them.
      await refresh();
    } catch (cause) {
      setStorageError(saveFailureMessage(cause));
    } finally {
      answering.current = false;
    }
  }, [refresh, undoable]);

  const studyAhead = useCallback(() => {
    if (session === null) {
      return;
    }

    setQueue(
      session.upcoming.map((entry) => ({ word: entry.word, kind: "ahead" })),
    );
    setRevealed(false);
    // A card pulled forward may well be the one just answered, and it is fair game again.
    answeredCardId.current = null;
  }, [session]);

  const current = queue[0];
  const syncedAt = session?.syncState?.syncedAt;
  const notice = syncError === null ? null : syncNotice(syncError);
  const blocked = notice !== null && notice.blocking && !syncErrorSeen;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // While an error screen withholds the session, the queue behind it is live; a key
      // reaching it would rate a card the user was never shown.
      if (blocked || storageError !== null) {
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event)) {
        return;
      }

      const action = actionForKey(event.key, { revealed });
      if (action.type === "ignore") {
        return;
      }

      // A focused button belongs to the browser: Space has to press it rather than reveal
      // the card behind it.
      if (action.type === "reveal" && event.target instanceof HTMLButtonElement) {
        return;
      }

      event.preventDefault();
      if (action.type === "reveal") {
        setRevealed(true);
        return;
      }
      if (action.type === "undo") {
        void undo();
        return;
      }
      void answer(action.rating);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [answer, blocked, revealed, storageError, undo]);

  const lastSyncedLine =
    syncedAt === undefined ? (
      "This device has never synced with the sheet."
    ) : (
      <>
        Last synced <Timestamp iso={syncedAt} />.
      </>
    );

  const renderBody = (): ReactNode => {
    if (session === null) {
      return (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Loading the cached word list…
        </p>
      );
    }

    if (session.wordCount === 0) {
      return (
        <section className={CARD_CLASS_NAME}>
          <h2 className="text-xl font-semibold">No words on this device yet</h2>
          <p className="max-w-sm text-sm text-zinc-600 dark:text-zinc-400">
            Nothing has been synced from the sheet. Try “Refresh from sheet” in
            Settings, and open Health to see what the sheet is answering.
          </p>
        </section>
      );
    }

    if (current === undefined) {
      const next = session.upcoming[0];
      return (
        <section className={CARD_CLASS_NAME}>
          <h2 className="text-2xl font-semibold tracking-tight">
            Done for today
          </h2>
          <p className="text-sm">
            {session.answersToday === 1
              ? "1 answer today"
              : `${session.answersToday} answers today`}
          </p>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {next === undefined ? (
              "Nothing is scheduled ahead."
            ) : (
              <>
                Next card is due <Timestamp iso={next.due} />.
              </>
            )}
          </p>
          <button
            type="button"
            onClick={studyAhead}
            disabled={session.upcoming.length === 0}
            className="h-14 rounded-xl border border-black/10 px-6 text-base font-medium transition-colors hover:bg-black/[.04] disabled:opacity-40 disabled:hover:bg-transparent dark:border-white/15 dark:hover:bg-white/[.06]"
          >
            Study ahead ({session.upcoming.length})
          </button>
        </section>
      );
    }

    // The answer is in the tree whether or not it is showing, so revealing it moves nothing.
    const cardContent = (
      <>
        <span className="block text-3xl font-semibold tracking-tight">
          {current.word.term}
        </span>
        <span className={`flex flex-col gap-3 ${revealed ? "" : "invisible"}`}>
          <span className="block text-xl">{current.word.translation}</span>
          <span className="block text-sm italic text-zinc-600 dark:text-zinc-400">
            {current.word.example}
          </span>
        </span>
      </>
    );

    return (
      <>
        {revealed ? (
          <div className={CARD_CLASS_NAME}>{cardContent}</div>
        ) : (
          <button
            type="button"
            onClick={() => setRevealed(true)}
            className={CARD_CLASS_NAME}
          >
            {cardContent}
          </button>
        )}

        {revealed ? (
          <div className="grid grid-cols-4 gap-2">
            {REVIEW_RATINGS.map((rating, index) => (
              <button
                key={rating}
                type="button"
                onClick={() => void answer(rating)}
                className={`flex h-14 flex-col items-center justify-center rounded-xl border capitalize transition-colors ${borderByRating[rating]}`}
              >
                {rating}
                <span className="font-mono text-xs opacity-60">
                  {index + 1}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setRevealed(true)}
            className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-foreground text-base font-medium text-background transition-opacity hover:opacity-90"
          >
            Show answer
            <span className="font-mono text-xs opacity-60">Space</span>
          </button>
        )}
      </>
    );
  };

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 py-4 font-sans">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-sm font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
          Study
        </h1>
        <div className="flex items-center gap-3">
          {session === null ? null : (
            <p aria-live="polite" className="font-mono text-sm">
              {countsLabel(queue)}
            </p>
          )}
          <button
            type="button"
            onClick={() => void undo()}
            disabled={undoable === null}
            className={BUTTON_CLASS_NAME}
          >
            Undo
            <span className="font-mono text-xs opacity-60">U</span>
          </button>
        </div>
      </header>

      {undoNotice === null ? null : (
        <p role="status" className="text-sm text-zinc-600 dark:text-zinc-400">
          {undoNotice}
        </p>
      )}

      {notice === null || blocked ? null : (
        <section
          role="status"
          className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
        >
          <p className="font-medium">{notice.title}</p>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            {lastSyncedLine}
          </p>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            {syncError?.message}
          </p>
          {notice.showHealthLink ? (
            <Link
              href="/health"
              className="mt-1 inline-block underline underline-offset-4"
            >
              See what the sheet answered
            </Link>
          ) : null}
        </section>
      )}

      {storageError !== null ? (
        <section
          role="alert"
          className="rounded-lg border border-red-500/40 bg-red-500/5 p-4"
        >
          <h2 className="font-medium text-red-700 dark:text-red-300">
            Progress cannot be saved on this device
          </h2>
          <p className="mt-2 text-sm">{storageError}</p>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            Private browsing and blocked site data are the usual causes. Studying
            stays switched off until the local database opens, because answers
            given now would be thrown away.
          </p>
        </section>
      ) : blocked && notice !== null ? (
        <section
          role="alert"
          className="rounded-lg border border-red-500/40 bg-red-500/5 p-4"
        >
          <h2 className="font-medium text-red-700 dark:text-red-300">
            {notice.title}
          </h2>
          <p className="mt-2 text-sm">{syncError?.message}</p>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            {lastSyncedLine}{" "}
            {(session?.wordCount ?? 0) > 0
              ? "The words already on this device were kept and can still be studied."
              : "This device has no cached words yet, so there is nothing to study until the sheet is fixed."}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Link
              href="/health"
              className={`${BUTTON_CLASS_NAME} font-medium underline underline-offset-4`}
            >
              See which rows the sheet rejected
            </Link>
            <button
              type="button"
              onClick={() => setSyncErrorSeen(true)}
              className={BUTTON_CLASS_NAME}
            >
              Study the cached words
            </button>
          </div>
        </section>
      ) : (
        renderBody()
      )}
    </main>
  );
}

function isTyping(event: KeyboardEvent): boolean {
  const target = event.target;
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement)
  );
}

function saveFailureMessage(cause: unknown): string {
  return `The last answer could not be written to this device (${cause instanceof Error ? cause.message : String(cause)}).`;
}
