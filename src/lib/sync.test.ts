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
import { mergeSheetWords, syncFromApi, type MergeResult } from "@/lib/sync";

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

// What the route handler really answers, serialized the way it reaches the browser.
function stubSheetResponse(rows: string[]) {
  const sheet = parseSheetCsv(
    ["id,term,translation,example,tags,added", ...rows].join("\n"),
    SYNCED_AT,
  );
  return stubFetch(
    new Response(JSON.stringify(sheet), {
      headers: { "content-type": "application/json" },
    }),
  );
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
            ["id,term,meaning,example,tags,added", "wa3f19c2b81,flimsum,doorway,,,"].join(
              "\n",
            ),
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

  it("asks for a fresh list past every cache when the user refreshes", async () => {
    const fetchMock = stubFailingFetch();

    await syncFromApi({ fresh: true });

    expect(fetchMock).toHaveBeenCalledWith("/api/words?fresh=1", {
      cache: "no-store",
    });
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
