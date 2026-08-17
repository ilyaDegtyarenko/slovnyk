import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  db,
  readLastSyncError,
  readSyncState,
  recordReview,
  type ProgressRow,
  type StoredWord,
} from "@/lib/db";
import { buildQueue } from "@/lib/queue";
import { parseSheetCsv, type InvalidRow, type Word } from "@/lib/sheet";
import { initialCard, review } from "@/lib/srs";
import {
  describeSyncChanges,
  mergeSheetWords,
  syncFromApi,
  type MergeResult,
} from "@/lib/sync";

const FLIMSUM = "wa3f19c2b81";
const GORBIK = "wb7c02d4e19";
const TRELLUP = "wc51e8a0f2d";

const SYNCED_AT = "2026-03-01T08:00:00.000Z";
const NOW = new Date("2026-03-10T08:00:00.000Z");

function sheetWord(id: string, term: string, overrides: Partial<Word> = {}): Word {
  return {
    id,
    term,
    translation: `${term} in english`,
    example: "",
    tags: [],
    added: "2026-03-01",
    ...overrides,
  };
}

function cachedWord(
  id: string,
  term: string,
  order: number,
  overrides: Partial<StoredWord> = {},
): StoredWord {
  return {
    ...sheetWord(id, term),
    order,
    orphaned: false,
    updatedAt: SYNCED_AT,
    ...overrides,
  };
}

function progressDueAt(id: string, due: string): ProgressRow {
  const reviewedAt = new Date(SYNCED_AT);
  const card = { ...review(initialCard(reviewedAt), "good", reviewedAt).card, due };
  return { id, due, state: card.state, card };
}

function merge(
  cached: StoredWord[],
  fetched: Word[],
  invalid: InvalidRow[] = [],
): MergeResult {
  return mergeSheetWords({ cached, fetched, invalid, now: NOW });
}

function stubFetch(response: Response) {
  const fetchMock = vi.fn<typeof fetch>(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubFailingFetch() {
  const fetchMock = vi.fn<typeof fetch>(async () => {
    throw new TypeError("Failed to fetch");
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sheetResponse(rows: string[], syncedAt: string): Response {
  const sheet = parseSheetCsv(
    ["id,term,translation,example,tags,added", ...rows].join("\n"),
    syncedAt,
  );
  return new Response(JSON.stringify(sheet), {
    headers: { "content-type": "application/json" },
  });
}

// What the route handler really answers, serialized the way it reaches the browser.
function stubSheetResponse(rows: string[], syncedAt: string = SYNCED_AT) {
  return stubFetch(sheetResponse(rows, syncedAt));
}

beforeEach(async () => {
  await Promise.all([
    db.words.clear(),
    db.progress.clear(),
    db.reviews.clear(),
    db.meta.clear(),
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("mergeSheetWords", () => {
  it("keeps the progress of a word whose term the tutor rewrote", () => {
    const cached = [cachedWord(FLIMSUM, "flimsum", 0)];
    const progress = [progressDueAt(FLIMSUM, "2026-03-09T08:00:00.000Z")];
    const progressSnapshot = structuredClone(progress);

    const merged = merge(cached, [
      sheetWord(FLIMSUM, "flimsúm", { translation: "doorway" }),
    ]);

    if (!merged.ok) {
      throw new Error(`expected a merged list, got ${merged.error.code}`);
    }
    expect(merged.words).toHaveLength(1);
    expect(merged.words[0].id).toBe(FLIMSUM);
    expect(merged.words[0].term).toBe("flimsúm");
    expect(merged.words[0].translation).toBe("doorway");
    expect(progress).toEqual(progressSnapshot);

    // The scheduler still knows this word: it comes back as a due card, not a new one.
    const queue = buildQueue({
      words: merged.words,
      progress,
      now: NOW,
      newPerDay: 10,
    });
    expect(queue.dueCards.map((word) => word.term)).toEqual(["flimsúm"]);
    expect(queue.newCards).toEqual([]);
  });

  it("orphans a word the tutor deleted and keeps its progress", () => {
    const cached = [
      cachedWord(FLIMSUM, "flimsum", 0),
      cachedWord(GORBIK, "gorbik", 1),
    ];
    const progress = [progressDueAt(GORBIK, "2026-03-09T08:00:00.000Z")];
    const progressSnapshot = structuredClone(progress);

    const merged = merge(cached, [sheetWord(FLIMSUM, "flimsum")]);

    if (!merged.ok) {
      throw new Error(`expected a merged list, got ${merged.error.code}`);
    }
    const gorbik = merged.words.find((word) => word.id === GORBIK);
    expect(gorbik?.orphaned).toBe(true);
    expect(gorbik?.updatedAt).toBe(SYNCED_AT);
    expect(progress).toEqual(progressSnapshot);

    const queue = buildQueue({
      words: merged.words,
      progress,
      now: NOW,
      newPerDay: 10,
    });
    expect(queue.dueCards).toEqual([]);
    expect(queue.newCards.map((word) => word.id)).toEqual([FLIMSUM]);
  });

  it("resumes a word the tutor put back exactly where it was", () => {
    const cached = [
      cachedWord(GORBIK, "gorbik", 1, { orphaned: true, updatedAt: SYNCED_AT }),
    ];

    const merged = merge(cached, [sheetWord(GORBIK, "gorbik")]);

    if (!merged.ok) {
      throw new Error(`expected a merged list, got ${merged.error.code}`);
    }
    expect(merged.words[0].orphaned).toBe(false);
    expect(merged.words[0].updatedAt).toBe(SYNCED_AT);
    expect(merged.words[0].order).toBe(0);
  });

  it("orphans nothing when the fetched sheet is truncated to nothing", () => {
    const cached = [
      cachedWord(FLIMSUM, "flimsum", 0),
      cachedWord(GORBIK, "gorbik", 1),
    ];
    const cachedSnapshot = structuredClone(cached);

    const merged = merge(cached, []);

    if (merged.ok) {
      throw new Error("expected an error for a sheet with no usable words");
    }
    expect(merged.error.code).toBe("EMPTY_SHEET");
    expect(merged.error.message).toContain("/health");
    expect(cached).toEqual(cachedSnapshot);
  });

  it("refuses a first sync where every row failed instead of showing an empty app", () => {
    const merged = merge([], [], [{ row: 2, issues: ["translation: required"] }]);

    if (merged.ok) {
      throw new Error("expected an error for a sheet whose rows all failed");
    }
    expect(merged.error.code).toBe("EMPTY_SHEET");
    expect(merged.error.message).toContain("failed to parse");
  });

  it("accepts an empty sheet when nothing is cached and nothing failed", () => {
    const merged = merge([], []);

    if (!merged.ok) {
      throw new Error(`expected a merged list, got ${merged.error.code}`);
    }
    expect(merged.words).toEqual([]);
  });

  it("stores a word it has never seen in sheet order", () => {
    const merged = merge(
      [cachedWord(FLIMSUM, "flimsum", 0)],
      [sheetWord(FLIMSUM, "flimsum"), sheetWord(TRELLUP, "trellup")],
    );

    if (!merged.ok) {
      throw new Error(`expected a merged list, got ${merged.error.code}`);
    }
    expect(merged.words[1]).toEqual({
      ...sheetWord(TRELLUP, "trellup"),
      order: 1,
      orphaned: false,
      updatedAt: NOW.toISOString(),
    });
  });

  it("dates a word by its last text change, not by the last sync", () => {
    const cached = [
      cachedWord(FLIMSUM, "flimsum", 0),
      cachedWord(GORBIK, "gorbik", 1),
      cachedWord(TRELLUP, "trellup", 2),
    ];

    const merged = merge(cached, [
      sheetWord(FLIMSUM, "flimsum"),
      sheetWord(GORBIK, "gorbik", { example: "The gorbik wandered off." }),
      sheetWord(TRELLUP, "trellup", { tags: ["adjective"] }),
    ]);

    if (!merged.ok) {
      throw new Error(`expected a merged list, got ${merged.error.code}`);
    }
    expect(merged.words[0].updatedAt).toBe(SYNCED_AT);
    expect(merged.words[1].updatedAt).toBe(NOW.toISOString());
    expect(merged.words[2].updatedAt).toBe(NOW.toISOString());
  });

  it("counts new, changed, and removed words for the refresh report", () => {
    const cached = [
      cachedWord(FLIMSUM, "flimsum", 0),
      cachedWord(GORBIK, "gorbik", 1),
    ];

    const merged = merge(cached, [
      sheetWord(FLIMSUM, "flimsum", { translation: "gateway" }),
      sheetWord(TRELLUP, "trellup"),
    ]);

    if (!merged.ok) {
      throw new Error(`expected a merged list, got ${merged.error.code}`);
    }
    expect(merged.changes).toEqual({ added: 1, updated: 1, removed: 1 });
  });

  it("reports an untouched sheet as no changes at all", () => {
    const cached = [cachedWord(FLIMSUM, "flimsum", 0)];

    const merged = merge(cached, [sheetWord(FLIMSUM, "flimsum")]);

    if (!merged.ok) {
      throw new Error(`expected a merged list, got ${merged.error.code}`);
    }
    expect(merged.changes).toEqual({ added: 0, updated: 0, removed: 0 });
  });

  it("does not report a word that was already orphaned as removed again", () => {
    const cached = [
      cachedWord(FLIMSUM, "flimsum", 0),
      cachedWord(GORBIK, "gorbik", 1, { orphaned: true }),
    ];

    const merged = merge(cached, [sheetWord(FLIMSUM, "flimsum")]);

    if (!merged.ok) {
      throw new Error(`expected a merged list, got ${merged.error.code}`);
    }
    expect(merged.changes).toEqual({ added: 0, updated: 0, removed: 0 });
  });

  it("reports a word back from orphanhood as a change", () => {
    const cached = [
      cachedWord(GORBIK, "gorbik", 1, { orphaned: true }),
    ];

    const merged = merge(cached, [sheetWord(GORBIK, "gorbik")]);

    if (!merged.ok) {
      throw new Error(`expected a merged list, got ${merged.error.code}`);
    }
    expect(merged.changes).toEqual({ added: 0, updated: 1, removed: 0 });
  });

  it("follows a word moved up the sheet without calling it edited", () => {
    const cached = [
      cachedWord(FLIMSUM, "flimsum", 0),
      cachedWord(GORBIK, "gorbik", 1),
    ];

    const merged = merge(cached, [
      sheetWord(GORBIK, "gorbik"),
      sheetWord(FLIMSUM, "flimsum"),
    ]);

    if (!merged.ok) {
      throw new Error(`expected a merged list, got ${merged.error.code}`);
    }
    expect(merged.words.map((word) => [word.id, word.order])).toEqual([
      [GORBIK, 0],
      [FLIMSUM, 1],
    ]);
    expect(merged.words.every((word) => word.updatedAt === SYNCED_AT)).toBe(true);
  });
});

describe("describeSyncChanges", () => {
  it("names only the counts that moved, in a fixed order", () => {
    expect(describeSyncChanges({ added: 2, updated: 0, removed: 1 })).toBe(
      "2 new, 1 removed",
    );
    expect(describeSyncChanges({ added: 0, updated: 3, removed: 0 })).toBe(
      "3 changed",
    );
    expect(describeSyncChanges({ added: 1, updated: 1, removed: 1 })).toBe(
      "1 new, 1 changed, 1 removed",
    );
  });

  it("returns null when nothing moved, so the caller must say so in words", () => {
    expect(describeSyncChanges({ added: 0, updated: 0, removed: 0 })).toBeNull();
  });
});

describe("syncFromApi", () => {
  it("stores what the route really answers", async () => {
    stubSheetResponse([
      "wa3f19c2b81,flimsum,doorway,,\"noun, house\",2026-01-02",
      "wb7c02d4e19,gorbik,to wander,,verb,2026-01-03",
      "wc51e8a0f2d,,broken,,,",
    ]);

    const result = await syncFromApi({ fresh: false });

    if (!result.ok) {
      throw new Error(`expected a stored list, got ${result.error.code}`);
    }
    expect(result.words.map((word) => word.term)).toEqual(["flimsum", "gorbik"]);
    expect(await db.words.get(FLIMSUM)).toEqual({
      id: FLIMSUM,
      term: "flimsum",
      translation: "doorway",
      example: "",
      tags: ["noun", "house"],
      added: "2026-01-02",
      order: 0,
      orphaned: false,
      updatedAt: expect.any(String),
    });

    // The invalid row is kept for /health rather than dropped on the floor.
    const syncState = await readSyncState();
    expect(syncState?.syncedAt).toBe(SYNCED_AT);
    expect(syncState?.invalid.map((invalidRow) => invalidRow.row)).toEqual([4]);
  });

  it("keeps a progress row byte-identical across a rename and a deletion", async () => {
    stubSheetResponse([
      "wa3f19c2b81,flimsum,doorway,,,",
      "wb7c02d4e19,gorbik,to wander,,,",
    ]);
    await syncFromApi({ fresh: false });

    await recordReview({ id: FLIMSUM, rating: "good", now: NOW });
    const beforeSecondSync = await db.progress.get(FLIMSUM);

    stubSheetResponse(["wa3f19c2b81,flimsúm,gateway,,,"]);
    const result = await syncFromApi({ fresh: true });

    if (!result.ok) {
      throw new Error(`expected a stored list, got ${result.error.code}`);
    }
    expect(await db.progress.get(FLIMSUM)).toEqual(beforeSecondSync);
    expect(await db.reviews.count()).toBe(1);
    expect((await db.words.get(FLIMSUM))?.term).toBe("flimsúm");
    expect((await db.words.get(GORBIK))?.orphaned).toBe(true);
  });

  it("refuses a sheet whose header the tutor renamed, cache or no cache", async () => {
    stubFetch(
      new Response(
        JSON.stringify(
          parseSheetCsv(
            // Every documented column renamed: the hardest version of the mistake, where
            // no row has even one recognisable cell to make it look non-empty.
            [
              "identifier,word,meaning,sample,labels,created",
              "wa3f19c2b81,flimsum,doorway,,,",
            ].join("\n"),
            SYNCED_AT,
          ),
        ),
        { headers: { "content-type": "application/json" } },
      ),
    );

    const result = await syncFromApi({ fresh: false });

    if (result.ok) {
      throw new Error("expected an error for a sheet whose rows all failed");
    }
    expect(result.error.code).toBe("EMPTY_SHEET");
    expect(await db.words.count()).toBe(0);
  });

  it("reports a device that will not store the word list", async () => {
    stubSheetResponse(["wa3f19c2b81,flimsum,doorway,,,"]);
    vi.spyOn(db.words, "toArray").mockRejectedValue(
      new Error("IndexedDB API missing"),
    );

    const result = await syncFromApi({ fresh: false });

    if (result.ok) {
      throw new Error("expected an error for unusable storage");
    }
    expect(result.error.code).toBe("STORAGE_UNAVAILABLE");
    expect(result.error.message).toContain("IndexedDB API missing");
    // The device cannot store the word list, so it cannot store the complaint either.
    expect(await readLastSyncError()).toBeUndefined();
  });

  it("remembers why a sync failed without disowning the last good one", async () => {
    stubSheetResponse(["wa3f19c2b81,flimsum,doorway,,,"]);
    await syncFromApi({ fresh: false });

    stubFailingFetch();
    await syncFromApi({ fresh: true });

    const failure = await readLastSyncError();
    expect(failure?.code).toBe("OFFLINE");
    expect(failure?.message).toContain("Failed to fetch");
    expect(Number.isNaN(Date.parse(failure?.at ?? ""))).toBe(false);
    expect((await readSyncState())?.syncedAt).toBe(SYNCED_AT);
    expect(await db.words.count()).toBe(1);
  });

  it("clears the remembered failure as soon as a sync gets through", async () => {
    stubFailingFetch();
    await syncFromApi({ fresh: false });
    expect(await readLastSyncError()).toBeDefined();

    stubSheetResponse(["wa3f19c2b81,flimsum,doorway,,,"]);
    await syncFromApi({ fresh: false });

    expect(await readLastSyncError()).toBeUndefined();
    expect((await readSyncState())?.syncedAt).toBe(SYNCED_AT);
  });

  it("reports an unreachable endpoint instead of throwing", async () => {
    stubFailingFetch();

    const result = await syncFromApi({ fresh: false });

    if (result.ok) {
      throw new Error("expected an error for a failing network");
    }
    expect(result.error.code).toBe("OFFLINE");
    expect(result.error.message).toContain("Failed to fetch");
  });

  it("discards a response older than the applied sync instead of orphaning by it", async () => {
    const NEWER_SYNCED_AT = "2026-03-05T08:00:00.000Z";
    stubSheetResponse(
      ["wa3f19c2b81,flimsum,doorway,,,", "wb7c02d4e19,gorbik,to wander,,,"],
      NEWER_SYNCED_AT,
    );
    await syncFromApi({ fresh: false });

    // A failed attempt in between: the discarded refresh below still proves the
    // endpoint works, so it has to retire this complaint.
    stubFailingFetch();
    await syncFromApi({ fresh: false });
    expect(await readLastSyncError()).toBeDefined();

    // A refresh answered from Google's publish cache: an older snapshot from before
    // gorbik existed. Applying it would orphan a word that is still in the sheet.
    stubSheetResponse(["wa3f19c2b81,flimsum,doorway,,,"], SYNCED_AT);
    const result = await syncFromApi({ fresh: true });

    if (!result.ok) {
      throw new Error(`expected a discarded stale sync, got ${result.error.code}`);
    }
    expect(result.changes).toEqual({ added: 0, updated: 0, removed: 0 });
    expect(result.syncState.syncedAt).toBe(NEWER_SYNCED_AT);
    expect((await db.words.get(GORBIK))?.orphaned).toBe(false);
    expect((await readSyncState())?.syncedAt).toBe(NEWER_SYNCED_AT);
    expect(await readLastSyncError()).toBeUndefined();
  });

  it("joins a sync already in flight instead of sending a second request", async () => {
    let answer: (response: Response) => void = () => {};
    const fetchMock = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = syncFromApi({ fresh: false });
    const second = syncFromApi({ fresh: false });
    answer(sheetResponse(["wa3f19c2b81,flimsum,doorway,,,"], SYNCED_AT));

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Joined, not raced: the second caller gets the very result the first one got.
    expect(secondResult).toBe(firstResult);
    // The mount-time background sync is exactly the request that once wedged the lane,
    // so the deadline has to ride the non-fresh shape too — not only the refresh one.
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);

    // The lane is free again afterwards — the next sync makes its own request.
    const nextFetchMock = stubSheetResponse(["wa3f19c2b81,flimsum,doorway,,,"]);
    await syncFromApi({ fresh: false });
    expect(nextFetchMock).toHaveBeenCalledTimes(1);
  });

  it("lets a background sync join a refresh already in flight", async () => {
    let answer: (response: Response) => void = () => {};
    const fetchMock = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const refresh = syncFromApi({ fresh: true });
    const background = syncFromApi({ fresh: false });
    answer(sheetResponse(["wa3f19c2b81,flimsum,doorway,,,"], SYNCED_AT));

    const [refreshResult, backgroundResult] = await Promise.all([
      refresh,
      background,
    ]);

    // A fresher answer than the background sync asked for is still an answer to it.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/words?fresh=1");
    expect(backgroundResult).toBe(refreshResult);
  });

  it("reports a timed-out request as offline and frees the lane", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        // What an expired AbortSignal.timeout throws out of fetch.
        throw new DOMException("The operation timed out", "TimeoutError");
      }),
    );

    const result = await syncFromApi({ fresh: false });

    if (result.ok) {
      throw new Error("expected a timeout to read as offline");
    }
    expect(result.error.code).toBe("OFFLINE");

    // The wedge fix's whole point: the next attempt starts clean instead of joining
    // the dead one.
    const nextFetchMock = stubSheetResponse(["wa3f19c2b81,flimsum,doorway,,,"]);
    const retried = await syncFromApi({ fresh: false });
    expect(retried.ok).toBe(true);
    expect(nextFetchMock).toHaveBeenCalledTimes(1);
  });

  it("queues a manual refresh behind a cached sync instead of downgrading it", async () => {
    const pending: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          pending.push(resolve);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const background = syncFromApi({ fresh: false });
    const refresh = syncFromApi({ fresh: true });

    // Serialised, not raced: while the background sync runs, the refresh has not fired.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/words");

    // Not merely in this tick: with the first request still unanswered a whole task
    // later, the refresh is still holding back.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    pending[0](sheetResponse(["wa3f19c2b81,flimsum,doorway,,,"], SYNCED_AT));
    await background;

    // Joining the cached sync would have answered the refresh with the very response
    // the user pressed the button to get past; it makes its own fresh request instead.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1][0])).toBe("/api/words?fresh=1");

    const REFRESHED_SYNCED_AT = "2026-03-02T08:00:00.000Z";
    pending[1](
      sheetResponse(["wa3f19c2b81,flimsum,gateway,,,"], REFRESHED_SYNCED_AT),
    );
    const result = await refresh;

    if (!result.ok) {
      throw new Error(`expected the queued refresh to apply, got ${result.error.code}`);
    }
    expect(result.changes).toEqual({ added: 0, updated: 1, removed: 0 });
    expect((await readSyncState())?.syncedAt).toBe(REFRESHED_SYNCED_AT);
  });

  it("asks for a fresh list past every cache when the user refreshes", async () => {
    const fetchMock = stubFailingFetch();

    await syncFromApi({ fresh: true });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/words?fresh=1");
    expect(init?.cache).toBe("no-store");
    // The deadline is what frees the sync lane when a request never answers — without
    // it, one hung fetch would leave every later sync joined to it forever.
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("relays the typed error of a sheet that is not published", async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          error: {
            code: "SHEET_NOT_PUBLISHED",
            message: "Publish it with File → Publish to web.",
          },
        }),
        { status: 502, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await syncFromApi({ fresh: false });

    if (result.ok) {
      throw new Error("expected the relayed sheet error");
    }
    expect(result.error.code).toBe("SHEET_NOT_PUBLISHED");
    expect(result.error.message).toContain("Publish to web");
  });

  it("relays a locked instance's 401 without blaming the endpoint", async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          error: {
            code: "GATE_LOCKED",
            message: "Open /gate and enter the key again.",
          },
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await syncFromApi({ fresh: false });

    if (result.ok) {
      throw new Error("expected the relayed gate error");
    }
    expect(result.error.code).toBe("GATE_LOCKED");
    expect(result.error.message).toContain("/gate");
  });

  it("refuses a word list that does not match the shape it expects", async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          words: [{ id: FLIMSUM, term: "flimsum" }],
          invalid: [],
          syncedAt: SYNCED_AT,
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );

    const result = await syncFromApi({ fresh: false });

    if (result.ok) {
      throw new Error("expected an error for a malformed payload");
    }
    expect(result.error.code).toBe("SYNC_RESPONSE_INVALID");
    expect(result.error.message).toContain("translation");
  });

  it("refuses a body that is not json at all", async () => {
    stubFetch(
      new Response("<!DOCTYPE html><html><body>Sign in</body></html>", {
        headers: { "content-type": "text/html" },
      }),
    );

    const result = await syncFromApi({ fresh: false });

    if (result.ok) {
      throw new Error("expected an error for an html body");
    }
    expect(result.error.code).toBe("SYNC_RESPONSE_INVALID");
  });

  it("refuses an error body it cannot read", async () => {
    stubFetch(
      new Response(JSON.stringify({ error: { code: "SOMETHING_NEW" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await syncFromApi({ fresh: false });

    if (result.ok) {
      throw new Error("expected an error for an unknown error payload");
    }
    expect(result.error.code).toBe("SYNC_RESPONSE_INVALID");
    expect(result.error.message).toContain("500");
  });
});
