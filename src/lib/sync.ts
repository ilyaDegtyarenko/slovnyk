import { z } from "zod";
import {
  applySync,
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

export type MergeResult =
  | { ok: true; words: StoredWord[] }
  | { ok: false; error: SyncError };

export type SyncResult =
  | { ok: true; words: StoredWord[]; syncState: SyncState }
  | { ok: false; error: SyncError };

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

  // Matching by id and nothing else is what lets the tutor rewrite a term without the
  // scheduler noticing: this merge writes words only, and progress is keyed by the same id.
  const words = fetched.map((word, order) => {
    const cachedWord = cachedById.get(word.id);
    return {
      ...word,
      order,
      orphaned: false,
      updatedAt:
        cachedWord === undefined || hasTextChanged(cachedWord, word)
          ? changedAt
          : cachedWord.updatedAt,
    };
  });

  const fetchedIds = new Set(fetched.map((word) => word.id));
  const orphaned = cached
    .filter((word) => !fetchedIds.has(word.id))
    // Their sheet position is meaningless now, but keeping it means a word that reappears
    // in the same place comes back unchanged.
    .map((word) => ({ ...word, orphaned: true }));

  return { ok: true, words: [...words, ...orphaned] };
}

export async function syncFromApi(options: {
  fresh: boolean;
}): Promise<SyncResult> {
  const result = await runSync(options);

  if (!result.ok) {
    await rememberFailure(result.error);
  }

  return result;
}

async function runSync(options: { fresh: boolean }): Promise<SyncResult> {
  const fetched = await fetchWords(options);
  if (!fetched.ok) {
    return fetched;
  }

  let cached: StoredWord[];
  try {
    cached = await readWords();
  } catch (cause) {
    return { ok: false, error: storageUnavailableError(cause) };
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

  return { ok: true, words: merged.words, syncState };
}

async function fetchWords(options: { fresh: boolean }): Promise<FetchedWords> {
  const url = options.fresh ? `${WORDS_ENDPOINT}?fresh=1` : WORDS_ENDPOINT;

  let response: Response;
  try {
    // The route handler owns the upstream cache; a manual refresh must not be answered
    // from the browser's cache either.
    response = await fetch(url, options.fresh ? { cache: "no-store" } : {});
  } catch (cause) {
    return { ok: false, error: offlineError(cause) };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
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
