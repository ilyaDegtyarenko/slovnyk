import { z } from "zod";
import {
  applySync,
  clearSyncFailure,
  readSyncState,
  readWords,
  recordSyncFailure,
  type StoredWord,
  type SyncState,
} from "@/lib/db";
import type { InvalidRow, SheetError, Word } from "@/lib/sheet";

export type SyncError =
  | SheetError
  | { code: "GATE_LOCKED"; message: string }
  | { code: "OFFLINE"; message: string }
  | { code: "SYNC_RESPONSE_INVALID"; message: string }
  | { code: "EMPTY_SHEET"; message: string }
  | { code: "STORAGE_UNAVAILABLE"; message: string };

// What a sync did to the list, counted for the person who pressed Refresh: a sync that
// reports nothing at all is indistinguishable from one that never ran.
export type SyncChanges = {
  added: number;
  updated: number;
  removed: number;
};

export type MergeResult =
  | { ok: true; words: StoredWord[]; changes: SyncChanges }
  | { ok: false; error: SyncError };

export type SyncResult =
  | { ok: true; words: StoredWord[]; syncState: SyncState; changes: SyncChanges }
  | { ok: false; error: SyncError };

const NO_CHANGES: SyncChanges = { added: 0, updated: 0, removed: 0 };

// Null rather than an empty string when nothing moved: "no changes" needs a different
// sentence than a list of counts, and the caller has to be forced to write it.
export function describeSyncChanges(changes: SyncChanges): string | null {
  const parts = [
    changes.added > 0 ? `${changes.added} new` : null,
    changes.updated > 0 ? `${changes.updated} changed` : null,
    changes.removed > 0 ? `${changes.removed} removed` : null,
  ].filter((part): part is string => part !== null);

  return parts.length === 0 ? null : parts.join(", ");
}

const WORDS_ENDPOINT = "/api/words";

// A record rather than a list: a fifth code on `SheetError` breaks this line at compile
// time instead of quietly downgrading that error to an unreadable body at runtime.
const SHEET_ERROR_CODES = {
  SHEET_CSV_URL_MISSING: "SHEET_CSV_URL_MISSING",
  SHEET_CSV_URL_INVALID: "SHEET_CSV_URL_INVALID",
  SHEET_NOT_PUBLISHED: "SHEET_NOT_PUBLISHED",
  SHEET_UNREACHABLE: "SHEET_UNREACHABLE",
} as const satisfies { [Code in SheetError["code"]]: Code };

// The route handler is ours, but its answer still arrives over the network, and a service
// worker or a proxy can hand back anything at all.
const WordsPayload = z.object({
  words: z.array(
    z.object({
      id: z.string().min(1),
      term: z.string().min(1),
      translation: z.string().min(1),
      example: z.string(),
      tags: z.array(z.string()),
      added: z.string(),
    }),
  ),
  invalid: z.array(
    z.object({ row: z.number().int(), issues: z.array(z.string()) }),
  ),
  syncedAt: z.iso.datetime(),
});

// The sheet's own codes plus the one the proxy answers with before the route handler
// ever runs — a locked instance must not read as a broken endpoint.
const RELAYED_ERROR_CODES = {
  ...SHEET_ERROR_CODES,
  GATE_LOCKED: "GATE_LOCKED",
} as const;

const ErrorPayload = z.object({
  error: z.object({
    code: z.enum(RELAYED_ERROR_CODES),
    message: z.string(),
  }),
});

type FetchedWords =
  | { ok: true; payload: z.infer<typeof WordsPayload> }
  | { ok: false; error: SyncError };

export function mergeSheetWords(input: {
  cached: StoredWord[];
  fetched: Word[];
  invalid: InvalidRow[];
  now: Date;
}): MergeResult {
  const { cached, fetched, invalid, now } = input;

  // An unterminated quote can truncate the sheet into nothing, and a renamed header can
  // fail every row at once. Neither is an edit anyone made, so neither may orphan the
  // vocabulary or leave a first-time user staring at an empty app.
  if (fetched.length === 0 && (cached.length > 0 || invalid.length > 0)) {
    return { ok: false, error: emptySheetError(cached.length, invalid.length) };
  }

  const cachedById = new Map(cached.map((word) => [word.id, word]));
  const changedAt = now.toISOString();

  let added = 0;
  let updated = 0;

  // Matching by id and nothing else is what lets the tutor rewrite a term without the
  // scheduler noticing: this merge writes words only, and progress is keyed by the same id.
  const words = fetched.map((word, order) => {
    const cachedWord = cachedById.get(word.id);
    const isNew = cachedWord === undefined;
    const edited = !isNew && hasTextChanged(cachedWord, word);
    if (isNew) {
      added += 1;
    } else if (edited || cachedWord.orphaned) {
      // A word back from orphanhood changed the studyable list even when its text did
      // not, so the refresh report counts it too.
      updated += 1;
    }

    return {
      ...word,
      order,
      orphaned: false,
      updatedAt: isNew || edited ? changedAt : cachedWord.updatedAt,
    };
  });

  const fetchedIds = new Set(fetched.map((word) => word.id));
  const missing = cached.filter((word) => !fetchedIds.has(word.id));
  // Only a word losing its place counts as removed; one that was already orphaned is old
  // news and must not be reported again on every sync.
  const removed = missing.filter((word) => !word.orphaned).length;
  // Their sheet position is meaningless now, but keeping it means a word that reappears
  // in the same place comes back unchanged.
  const orphaned = missing.map((word) => ({ ...word, orphaned: true }));

  return {
    ok: true,
    words: [...words, ...orphaned],
    changes: { added, updated, removed },
  };
}

type PendingSync = { fresh: boolean; result: Promise<SyncResult> };

// One sync at a time — per tab: module state cannot see another window, so a second tab
// still syncs on its own, protected only by the syncedAt discard below. Two interleaved
// syncs would each read the cached words before the other writes, and the loser's orphan
// pass would then judge the sheet against a list its payload no longer describes.
let pendingSync: PendingSync | null = null;

export async function syncFromApi(options: {
  fresh: boolean;
}): Promise<SyncResult> {
  const running = pendingSync;

  // Joining is only honest when the running sync asks upstream at least as hard as this
  // call would have: a manual refresh joining a cached background sync would silently
  // become the very answer the user pressed the button to get past. Such a refresh waits
  // its turn instead — still one sync at a time, never two requests in flight.
  if (running !== null && (running.fresh || !options.fresh)) {
    return running.result;
  }

  const result = (async () => {
    // Awaited only when a sync is actually running: an unconditional await would push
    // even an uncontended sync onto a later microtask, and its request with it.
    if (running !== null) {
      await running.result.then(
        () => undefined,
        () => undefined,
      );
    }

    const outcome = await runSync(options);
    if (!outcome.ok) {
      await rememberFailure(outcome.error);
    }
    return outcome;
  })();

  const sync: PendingSync = {
    fresh: options.fresh,
    result: result.finally(() => {
      // A queued refresh may have replaced this entry already; its lane is not ours to
      // clear.
      if (pendingSync === sync) {
        pendingSync = null;
      }
    }),
  };

  pendingSync = sync;
  return sync.result;
}

async function runSync(options: { fresh: boolean }): Promise<SyncResult> {
  const fetched = await fetchWords(options);
  if (!fetched.ok) {
    return fetched;
  }

  let cached: StoredWord[];
  let lastApplied: SyncState | undefined;
  try {
    [cached, lastApplied] = await Promise.all([readWords(), readSyncState()]);
  } catch (cause) {
    return { ok: false, error: storageUnavailableError(cause) };
  }

  // `?fresh=1` dodges this app's caches but not Google's, so a refresh can still answer
  // with a snapshot older than one already applied. Applying it would orphan every word
  // the newer snapshot added, so a stale answer is discarded as no news instead. A stale
  // answer still proves the endpoint works, which settles any standing complaint.
  if (
    lastApplied !== undefined &&
    Date.parse(fetched.payload.syncedAt) < Date.parse(lastApplied.syncedAt)
  ) {
    try {
      await clearSyncFailure();
    } catch {
      // The discard already keeps everything; losing the cleanup must not fail it.
    }
    return { ok: true, words: cached, syncState: lastApplied, changes: NO_CHANGES };
  }

  const merged = mergeSheetWords({
    cached,
    fetched: fetched.payload.words,
    invalid: fetched.payload.invalid,
    now: new Date(),
  });
  if (!merged.ok) {
    return merged;
  }

  const syncState: SyncState = {
    syncedAt: fetched.payload.syncedAt,
    invalid: fetched.payload.invalid,
  };

  try {
    await applySync({ words: merged.words, syncState });
  } catch (cause) {
    return { ok: false, error: storageUnavailableError(cause) };
  }

  return { ok: true, words: merged.words, syncState, changes: merged.changes };
}

// Later syncs join the request in flight, so one that never settles would leave the tab
// unable to sync until it is killed. The deadline lands on the offline path, and the
// next attempt starts clean.
const REQUEST_TIMEOUT_MS = 30_000;

async function fetchWords(options: { fresh: boolean }): Promise<FetchedWords> {
  const url = options.fresh ? `${WORDS_ENDPOINT}?fresh=1` : WORDS_ENDPOINT;
  const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      // The route handler owns the upstream cache; a manual refresh must not be answered
      // from the browser's cache either.
      ...(options.fresh ? ({ cache: "no-store" } as const) : {}),
      signal: deadline,
    });
  } catch (cause) {
    return { ok: false, error: offlineError(cause) };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    // The deadline stays armed through the body read, so a network that stalled after
    // the headers trips here. That is the same dead connection as one that stalled
    // before them — not the endpoint answering garbage.
    if (deadline.aborted) {
      return { ok: false, error: offlineError(cause) };
    }
    return {
      ok: false,
      error: {
        code: "SYNC_RESPONSE_INVALID",
        message: `The word list endpoint answered HTTP ${response.status} with a body that is not JSON. The cached words were kept.`,
      },
    };
  }

  if (!response.ok) {
    const relayed = ErrorPayload.safeParse(body);
    return {
      ok: false,
      error: relayed.success
        ? relayed.data.error
        : unreadableBodyError(response.status, "an error this version cannot read"),
    };
  }

  const payload = WordsPayload.safeParse(body);
  if (!payload.success) {
    return {
      ok: false,
      error: unreadableBodyError(response.status, describeIssues(payload.error)),
    };
  }

  return { ok: true, payload: payload.data };
}

async function rememberFailure(error: SyncError): Promise<void> {
  // A device that just refused to store the word list will not store the complaint about
  // it either, and the caller is already holding the error.
  if (error.code === "STORAGE_UNAVAILABLE") {
    return;
  }

  try {
    await recordSyncFailure({
      code: error.code,
      message: error.message,
      at: new Date().toISOString(),
    });
  } catch {
    // Losing the record of a failed sync must not turn into a second failure.
  }
}

function emptySheetError(cachedCount: number, invalidCount: number): SyncError {
  const cause =
    invalidCount > 0
      ? `every row it returned failed to parse (${invalidCount})`
      : "it returned no rows at all";
  const kept =
    cachedCount > 0
      ? `the ${cachedCount} cached words were kept and nothing was orphaned`
      : "there is nothing cached to fall back on";

  return {
    code: "EMPTY_SHEET",
    message: `The sheet gave no usable words: ${cause}. So ${kept}. Open /health to see which rows failed.`,
  };
}

function hasTextChanged(cached: StoredWord, fetched: Word): boolean {
  return (
    cached.term !== fetched.term ||
    cached.translation !== fetched.translation ||
    cached.example !== fetched.example ||
    cached.added !== fetched.added ||
    !haveSameTags(cached.tags, fetched.tags)
  );
}

function haveSameTags(cached: string[], fetched: string[]): boolean {
  return (
    cached.length === fetched.length &&
    cached.every((tag, index) => tag === fetched[index])
  );
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      [issue.path.map(String).join("."), issue.message]
        .filter((part) => part.length > 0)
        .join(": "),
    )
    .join("; ");
}

function unreadableBodyError(status: number, detail: string): SyncError {
  return {
    code: "SYNC_RESPONSE_INVALID",
    message: `The word list endpoint answered HTTP ${status} with ${detail}. The cached words were kept; open /health to see what the sheet looks like.`,
  };
}

function offlineError(cause: unknown): SyncError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return {
    code: "OFFLINE",
    message: `The word list could not be reached (${message}). The cached words are still there and the list will refresh once the connection is back.`,
  };
}

function storageUnavailableError(cause: unknown): SyncError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return {
    code: "STORAGE_UNAVAILABLE",
    message: `This device would not store the word list (${message}). Nothing was saved, and studying now would lose progress.`,
  };
}
