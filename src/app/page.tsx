"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import Link from "next/link";
import { Timestamp } from "@/components/timestamp";
import { useRovingFocus } from "@/components/use-roving-focus";
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
import { pronounce, speechAvailable, stopPronunciation } from "@/lib/speech";
import {
  previewIntervals,
  REVIEW_RATINGS,
  type ReviewRating,
} from "@/lib/srs";
import { syncFromApi, type SyncError } from "@/lib/sync";

const CARD_FACE_CLASS_NAME =
  "absolute inset-0 flex flex-col items-center overflow-y-auto rounded-3xl border border-black/10 bg-white px-8 py-10 text-center shadow-[0_1px_2px_rgba(0,0,0,0.04),0_16px_40px_-20px_rgba(0,0,0,0.25)] backface-hidden dark:border-white/10 dark:bg-white/[0.04] dark:shadow-none";

// Centered with auto margins rather than `justify-center`: a centered flex container clips
// overflowing content on both edges with no way to scroll to the start, while auto margins
// collapse to zero and leave the whole answer reachable.
const CARD_FACE_CONTENT_CLASS_NAME =
  "my-auto flex w-full flex-col items-center gap-5";

// One flip, two axes: a phone turns the card over sideways, a desktop turns it end over
// end (the owner's ask). The pointer-fine pair swaps the axis and nothing else, and the
// same three utilities also pre-turn the back face and its speaker.
const FLIP_ROTATION_CLASS_NAME =
  "rotate-y-180 pointer-fine:rotate-x-180 pointer-fine:rotate-y-0";

const PILL_BUTTON_CLASS_NAME =
  "flex h-11 items-center gap-2 rounded-full border border-black/10 px-4 text-sm transition-[background-color,transform] duration-150 hover:bg-black/[.04] active:scale-[0.97] disabled:opacity-40 disabled:hover:bg-transparent disabled:active:scale-100 dark:border-white/15 dark:hover:bg-white/[.06]";

const PRIMARY_BUTTON_CLASS_NAME =
  "flex h-12 items-center justify-center rounded-full bg-foreground px-6 text-base font-medium text-background transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100";

// Shortcut hints drawn as keycaps: a bare digit next to an interval reads as one more
// number, and the little key shape is what says this one is pressed, not read.
const KEYCAP_CLASS_NAME =
  "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-black/15 bg-black/[.03] px-1 font-mono text-[10px] text-zinc-500 dark:border-white/20 dark:bg-white/[.06] dark:text-zinc-400";

// Color stays on the words alone; four differently colored boxes shouted louder than
// the card they rate.
const colorByRating: Record<ReviewRating, string> = {
  again: "text-red-600 dark:text-red-400",
  hard: "text-amber-600 dark:text-amber-400",
  good: "text-emerald-600 dark:text-emerald-400",
  easy: "text-sky-600 dark:text-sky-400",
};

const NOTHING_TO_UNDO =
  "Nothing to undo — that answer is no longer the last one in the log.";

// Speech support never changes within a page's lifetime; the store subscribes to nothing
// and only exists so the server render (no `window`) agrees with the first client one.
const subscribeToNothing = () => () => {};
const noSpeechOnTheServer = () => false;

// The answer undo would roll back, held with the log row it wrote so that a second undo —
// or a key held down — cannot reach past it into the answer before.
type Undoable = { card: QueueCard; seq: number };

export default function StudyPage() {
  const [session, setSession] = useState<StudySession | null>(null);
  const [queue, setQueue] = useState<QueueCard[]>([]);
  // True for the moment between spending the queue and hearing what came due meanwhile;
  // it keeps "Done for today" from flashing when the sitting is in fact continuing.
  const [refilling, setRefilling] = useState(false);
  // Progress counts this sitting only: answered plus what is still in hand is the total
  // the bar runs to. Undo gives the card back and takes the tick with it.
  const [answeredThisSession, setAnsweredThisSession] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [undoable, setUndoable] = useState<Undoable | null>(null);
  const [undoNotice, setUndoNotice] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<SyncError | null>(null);
  const [syncErrorSeen, setSyncErrorSeen] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const speechReady = useSyncExternalStore(
    subscribeToNothing,
    speechAvailable,
    noSpeechOnTheServer,
  );
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
    setAnsweredThisSession(0);
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
        setAnsweredThisSession((answered) => answered + 1);
        setRevealed(false);

        const rest = queue.slice(1);
        setQueue(rest);
        // The queue is spent: whatever has come due meanwhile — above all a card rated
        // Again earlier in this sitting — joins the same run, so the bar's total grows
        // instead of the count starting over from nothing. The just-answered id stays
        // barred, which is safe: ts-fsrs' shortest step is a minute, so the refill
        // cannot hand that card straight back.
        if (rest.length === 0) {
          setRefilling(true);
          try {
            const refilled = await refresh();
            if (refilled !== null) {
              setQueue(refilled.queue);
            }
            // A Space pressed during the wait above must not put the next card face up.
            setRevealed(false);
          } finally {
            setRefilling(false);
          }
        }
      } catch (cause) {
        // The answer never landed, so the card has to stay answerable.
        answeredCardId.current = null;
        setStorageError(saveFailureMessage(cause));
      } finally {
        answering.current = false;
      }
    },
    [queue, refresh],
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
      setAnsweredThisSession((answered) => Math.max(0, answered - 1));
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
      session.upcoming.map((entry) => ({
        word: entry.word,
        kind: "ahead",
        card: entry.card,
      })),
    );
    setAnsweredThisSession(0);
    setRevealed(false);
    // A card pulled forward may well be the one just answered, and it is fair game again.
    answeredCardId.current = null;
  }, [session]);

  const current = queue[0];

  // A voice reading the previous word over the next card would be worse than silence.
  const currentWordId = current?.word.id;
  useEffect(() => stopPronunciation, [currentWordId]);

  const syncedAt = session?.syncState?.syncedAt;
  const notice = syncError === null ? null : syncNotice(syncError);
  const blocked = notice !== null && notice.blocking && !syncErrorSeen;

  // Answered plus still in hand is the total the bar runs to; a refill mid-sitting grows
  // it, undo shrinks the answered side back.
  const sessionTotal = answeredThisSession + queue.length;
  // Refilling counts as studying: the bar staying put is the whole point of the refill.
  const studying =
    session !== null &&
    storageError === null &&
    !blocked &&
    (current !== undefined || refilling);

  // Tab lands on Good, the answer most sittings reach for; one Tab-and-Enter must not
  // accidentally mean Again.
  const ratingRovingFocus = useRovingFocus(
    REVIEW_RATINGS.length,
    REVIEW_RATINGS.indexOf("good"),
  );

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

      // A focused button belongs to the browser: Space has to press it rather than flip
      // the card behind it.
      if (action.type === "flip" && event.target instanceof HTMLButtonElement) {
        return;
      }

      event.preventDefault();
      if (action.type === "flip") {
        setRevealed((facingUp) => !facingUp);
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
        <div className="flex flex-1 flex-col justify-center gap-4">
          <div
            aria-hidden
            className="h-[clamp(320px,58dvh,520px)] rounded-3xl border border-black/5 bg-black/[0.03] motion-safe:animate-pulse dark:border-white/5 dark:bg-white/[0.03]"
          />
          <div className="h-20" />
          <p className="sr-only">Loading the cached word list…</p>
        </div>
      );
    }

    if (session.wordCount === 0) {
      return (
        <section className="flex flex-1 flex-col items-center justify-center gap-4 text-center motion-safe:animate-card-in">
          <h2 className="text-2xl font-semibold tracking-tight">
            No words on this device yet
          </h2>
          <p className="max-w-sm text-sm text-zinc-600 dark:text-zinc-400">
            Nothing has been synced from the sheet. Try “Refresh from sheet” in
            Settings, and open Health to see what the sheet is answering.
          </p>
          <div className="mt-2 flex items-center gap-3">
            <Link href="/settings" className={PILL_BUTTON_CLASS_NAME}>
              Open Settings
            </Link>
            <Link href="/health" className={PILL_BUTTON_CLASS_NAME}>
              Open Health
            </Link>
          </div>
        </section>
      );
    }

    // Between the last card and the refill's answer there is nothing to show yet — and
    // nothing to celebrate: a quiet placeholder the size of the card keeps "Done for
    // today" honest and the layout still.
    if (current === undefined && refilling) {
      return (
        <div aria-hidden className="flex flex-col gap-4">
          <div className="h-[clamp(320px,58dvh,520px)] rounded-3xl border border-black/5 bg-black/[0.03] dark:border-white/5 dark:bg-white/[0.03]" />
          <div className="h-20" />
        </div>
      );
    }

    if (current === undefined) {
      const next = session.upcoming[0];
      return (
        <section className="flex flex-1 flex-col items-center justify-center gap-4 text-center motion-safe:animate-card-in">
          <span
            aria-hidden
            className="flex size-16 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="size-8"
            >
              <path d="M4 12.5l5 5L20 6.5" />
            </svg>
          </span>
          <h2 className="text-3xl font-semibold tracking-tight">
            Done for today
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
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
            className={`mt-2 ${PRIMARY_BUTTON_CLASS_NAME}`}
          >
            Study ahead ({session.upcoming.length})
          </button>
        </section>
      );
    }

    const intervalByRating = previewIntervals(current.card, new Date());
    return (
      <div className="flex flex-col gap-4">
        {/* The key remounts the card face down for every word, which is also what plays
            the entrance animation between cards. */}
        <section
          key={current.word.id}
          className="relative flex h-[clamp(320px,58dvh,520px)] flex-col [perspective:1600px] motion-safe:animate-card-in"
        >
          {/* The rotation lives on this wrapper rather than on the flip button itself, so
              the speaker buttons — siblings of the button, buttons do not nest — turn
              over together with the card instead of hanging in front of it. */}
          <div
            className={`relative min-h-72 flex-1 transform-3d motion-safe:transition-transform motion-safe:duration-500 ${
              revealed ? FLIP_ROTATION_CLASS_NAME : ""
            }`}
          >
            {/* The face-down name carries the word itself, so a screen reader hears what it
                is being asked to recall, not just that an answer exists. */}
            <button
              type="button"
              aria-label={
                revealed ? undefined : `${current.word.term} — show answer`
              }
              onClick={() => setRevealed((facingUp) => !facingUp)}
              className="absolute inset-0 cursor-pointer rounded-3xl transform-3d"
            >
              {/* tabIndex -1: Chromium otherwise makes an overflowing face its own tab stop,
                  including the aria-hidden one. */}
              <span
                aria-hidden={revealed}
                tabIndex={-1}
                className={CARD_FACE_CLASS_NAME}
              >
                {current.kind === "new" ? (
                  <span className="absolute top-5 rounded-full border border-sky-500/40 px-2.5 py-0.5 text-xs font-medium text-sky-600 dark:text-sky-400">
                    New word
                  </span>
                ) : null}
                <span className={CARD_FACE_CONTENT_CLASS_NAME}>
                  <span className="block max-w-full break-words text-balance text-4xl font-semibold tracking-tight">
                    {current.word.term}
                  </span>
                </span>
              </span>

              <span
                aria-hidden={!revealed}
                tabIndex={-1}
                className={`${CARD_FACE_CLASS_NAME} ${FLIP_ROTATION_CLASS_NAME}`}
              >
                <span className={CARD_FACE_CONTENT_CLASS_NAME}>
                  <span className="block text-sm text-zinc-500 dark:text-zinc-400">
                    {current.word.term}
                  </span>
                  <span className="block max-w-full break-words text-balance text-3xl font-semibold tracking-tight">
                    {current.word.translation}
                  </span>
                  {current.word.example === "" ? null : (
                    <span className="block max-w-[min(28rem,100%)] break-words text-balance text-base italic text-zinc-600 dark:text-zinc-400">
                      {current.word.example}
                    </span>
                  )}
                  {current.word.tags.length === 0 ? null : (
                    <span className="flex flex-wrap justify-center gap-1.5">
                      {current.word.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-full bg-black/[0.05] px-2.5 py-0.5 text-xs text-zinc-600 dark:bg-white/10 dark:text-zinc-300"
                        >
                          {tag}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
              </span>
            </button>

            {/* One speaker per face: each turns over with its own side of the card, and
                only the face-up copy is offered to the ear or the Tab key. The back one
                sits inside a full-size counter-rotated layer, whose rotation cancels the
                card's and puts it — unmirrored — in the same corner. */}
            {speechReady ? (
              <>
                <PronounceButton
                  term={current.word.term}
                  offstage={revealed}
                  className="absolute right-2.5 top-2.5 z-10 backface-hidden"
                />
                <span
                  className={`pointer-events-none absolute inset-0 backface-hidden ${FLIP_ROTATION_CLASS_NAME}`}
                >
                  <PronounceButton
                    term={current.word.term}
                    offstage={!revealed}
                    className="absolute right-2.5 top-2.5 z-10"
                  />
                </span>
              </>
            ) : null}
          </div>
        </section>

        {/* Fixed height, so trading the hint for the rating buttons moves nothing. */}
        <div className="h-20">
          {revealed ? (
            <div
              role="toolbar"
              aria-label="Rate this card"
              {...ratingRovingFocus.groupProps}
              className="grid h-full grid-cols-4 gap-2"
            >
              {REVIEW_RATINGS.map((rating, index) => (
                <button
                  key={rating}
                  type="button"
                  {...ratingRovingFocus.itemProps(index)}
                  onClick={() => void answer(rating)}
                  /* The buttons arrive as a chain, each a beat behind its neighbor;
                     the keyframe's `both` fill keeps every one invisible until its
                     turn. Late arrivals are still live — a fast `3` never waits. */
                  style={{ animationDelay: `${index * 60}ms` }}
                  className="relative flex h-full flex-col items-center justify-center gap-0.5 rounded-2xl border border-black/10 text-sm font-medium capitalize transition-[background-color,transform] duration-150 hover:bg-black/[.04] active:scale-[0.97] motion-safe:animate-rise-in dark:border-white/10 dark:hover:bg-white/[.06]"
                >
                  <span className={colorByRating[rating]}>{rating}</span>
                  {/* `normal-case` shields the interval from the button's capitalize —
                      "10 Min" is nobody's unit. */}
                  <span className="font-mono text-[11px] normal-case text-zinc-400 dark:text-zinc-500">
                    {intervalByRating[rating]}
                  </span>
                  {/* Out of the reading line, into the corner: the key is a hint about
                      the button, not part of what the button says. Last in the DOM so
                      the accessible name still starts with the rating. */}
                  <kbd
                    className={`${KEYCAP_CLASS_NAME} absolute right-2 top-2 normal-case pointer-coarse:hidden`}
                  >
                    {index + 1}
                  </kbd>
                </button>
              ))}
            </div>
          ) : (
            <p className="flex h-full items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
              {/* The keyboard half disappears on touch screens, so the spaces live in the
                  text itself — flex gaps between text runs collapse once the span's box
                  is gone, which once shipped as “Tap the cardto flip it”. */}
              <span>
                Tap the card{" "}
                <span className="hidden pointer-fine:inline">
                  or press <kbd className={KEYCAP_CLASS_NAME}>Space</kbd>{" "}
                </span>
                to flip it
              </span>
            </p>
          )}
        </div>
      </div>
    );
  };

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6">
      {/* Counts on their own line, the full-width bar under them running to its label.
          Undo moved out to the bottom of the screen — a pill up here kept shouldering
          the bar aside. While a card is up, this zone and the undo footer take equal
          shares of the free space, so the status floats centered between the nav and
          the card and the card itself stays put. */}
      <header
        className={`flex min-h-5 flex-col gap-2 ${studying ? "flex-1 justify-center" : ""}`}
      >
        <h1 className="sr-only">Study</h1>
        {/* Mounted even while it says nothing: a live region announces changes only
            if it already existed, and a refill mid-sitting is such a change. */}
        {session === null ? null : (
          <p
            aria-live="polite"
            className="text-sm font-medium tabular-nums text-zinc-500 dark:text-zinc-400"
          >
            {countsLabel(queue)}
          </p>
        )}
        {studying ? (
          <div className="flex items-center gap-3">
            <div
              role="progressbar"
              aria-label="Session progress"
              aria-valuemin={0}
              aria-valuemax={sessionTotal}
              aria-valuenow={answeredThisSession}
              className="h-1 flex-1 overflow-hidden rounded-full bg-black/[.05] dark:bg-white/[.06]"
            >
              <div
                className="h-full rounded-full bg-foreground motion-safe:transition-[width] motion-safe:duration-300"
                style={{
                  width: `${sessionTotal === 0 ? 0 : (answeredThisSession / sessionTotal) * 100}%`,
                }}
              />
            </div>
            <span className="text-xs font-medium tabular-nums text-zinc-500 dark:text-zinc-400">
              {answeredThisSession}/{sessionTotal}
            </span>
          </div>
        ) : null}
      </header>

      {undoNotice === null ? null : (
        <p
          role="status"
          className="text-sm text-zinc-600 motion-safe:animate-rise-in dark:text-zinc-400"
        >
          {undoNotice}
        </p>
      )}

      {notice === null || blocked ? null : (
        <section
          role="status"
          className="rounded-2xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm motion-safe:animate-rise-in"
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
              className="mt-1 inline-block underline underline-offset-4 active:opacity-60"
            >
              See what the sheet answered
            </Link>
          ) : null}
        </section>
      )}

      {storageError !== null ? (
        <section
          role="alert"
          className="rounded-2xl border border-red-500/40 bg-red-500/5 p-5"
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
          className="rounded-2xl border border-red-500/40 bg-red-500/5 p-5"
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
              className={`${PILL_BUTTON_CLASS_NAME} font-medium underline underline-offset-4`}
            >
              See which rows the sheet rejected
            </Link>
            <button
              type="button"
              onClick={() => setSyncErrorSeen(true)}
              className={PILL_BUTTON_CLASS_NAME}
            >
              Study the cached words
            </button>
          </div>
        </section>
      ) : (
        renderBody()
      )}

      {/* Undo waits at the bottom, borderless: reached for once in a while, it has no
          business sitting in the header next to the numbers read on every card. */}
      {session === null ||
      session.wordCount === 0 ||
      storageError !== null ||
      blocked ? null : (
        <footer
          className={`flex justify-center ${studying ? "flex-1 items-end" : ""}`}
        >
          <button
            type="button"
            onClick={() => void undo()}
            disabled={undoable === null}
            className="flex h-11 items-center gap-2 rounded-full px-5 text-sm text-zinc-500 transition-[background-color,color,transform] duration-150 hover:bg-black/[.04] hover:text-foreground active:scale-[0.97] disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-500 disabled:active:scale-100 dark:text-zinc-400 dark:hover:bg-white/[.06] dark:hover:text-foreground dark:disabled:hover:text-zinc-400"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
              className="size-4"
            >
              <path d="M8.5 13.5 4 9l4.5-4.5" />
              <path d="M4 9h10a6 6 0 0 1 6 6v0a6 6 0 0 1-6 6h-3" />
            </svg>
            Undo
            <kbd className={`${KEYCAP_CLASS_NAME} pointer-coarse:hidden`}>U</kbd>
          </button>
        </footer>
      )}
    </main>
  );
}

function PronounceButton({
  term,
  offstage,
  className,
}: {
  term: string;
  // The copy on the turned-away face: still in the DOM, but no ear, tap, or Tab key
  // should find it there.
  offstage: boolean;
  className: string;
}) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  // A speaker that turns away while holding focus would keep it invisibly, and the
  // Space guard would then feed every Space to it instead of flipping the card.
  useEffect(() => {
    const button = buttonRef.current;
    if (offstage && button !== null && button === document.activeElement) {
      button.blur();
    }
  }, [offstage]);

  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={`Pronounce “${term}”`}
      aria-hidden={offstage}
      tabIndex={offstage ? -1 : 0}
      onClick={(event) => {
        // A clicked button keeps focus, and the Space guard above would then feed every
        // Space to this button instead of flipping the card. detail is 0 for keyboard
        // activation, where the focus is the user's own.
        if (event.detail > 0) {
          event.currentTarget.blur();
        }
        pronounce(term);
      }}
      className={`${offstage ? "pointer-events-none" : "pointer-events-auto"} flex size-11 items-center justify-center rounded-full text-zinc-400 transition-[background-color,color,transform] duration-150 hover:bg-black/[.05] hover:text-foreground active:scale-95 dark:text-zinc-500 dark:hover:bg-white/10 dark:hover:text-foreground ${className}`}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        className="size-5"
      >
        <path d="M11 5.5 6.8 9H4.5a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h2.3l4.2 3.5v-13Z" />
        <path d="M15 8.7a4.7 4.7 0 0 1 0 6.6" />
        <path d="M17.8 6.2a8.4 8.4 0 0 1 0 11.6" />
      </svg>
    </button>
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
