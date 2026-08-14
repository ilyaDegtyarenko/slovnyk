import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSheet, looksLikeHtml, parseSheetCsv } from "@/lib/sheet";

const SYNCED_AT = "2026-01-05T09:00:00.000Z";
const CSV_URL = "https://sheets.invalid/d/e/2PACX-test/pub?output=csv";

const HEADER = "id,term,translation,example,tags,added";

function csv(...rows: string[]): string {
  return [HEADER, ...rows].join("\n");
}

function stubFetch(response: Response) {
  const fetchMock = vi.fn<typeof fetch>(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("parseSheetCsv", () => {
  it("parses a valid sheet, keeping sheet order and splitting tags", () => {
    const result = parseSheetCsv(
      csv(
        'wa3f19c2b81,flimsum,doorway,"The flimsum creaked at dawn.","noun, house",2026-01-02',
        "wb7c02d4e19,gorbik,to wander,,verb,2026-01-03",
        "wc51e8a0f2d,trellup,quiet,,,",
      ),
      SYNCED_AT,
    );

    expect(result.invalid).toEqual([]);
    expect(result.syncedAt).toBe(SYNCED_AT);
    expect(result.words.map((word) => word.id)).toEqual([
      "wa3f19c2b81",
      "wb7c02d4e19",
      "wc51e8a0f2d",
    ]);
    expect(result.words[0]).toEqual({
      id: "wa3f19c2b81",
      term: "flimsum",
      translation: "doorway",
      example: "The flimsum creaked at dawn.",
      tags: ["noun", "house"],
      added: "2026-01-02",
    });
    expect(result.words[2]).toEqual({
      id: "wc51e8a0f2d",
      term: "trellup",
      translation: "quiet",
      example: "",
      tags: [],
      added: "",
    });
  });

  it("trims surrounding whitespace and drops empty tags", () => {
    const result = parseSheetCsv(
      csv('  wa3f19c2b81  ,  flimsum  ,  doorway  ,,"  a, b , c ,, ",  2026-01-02  '),
      SYNCED_AT,
    );

    expect(result.invalid).toEqual([]);
    expect(result.words[0]).toEqual({
      id: "wa3f19c2b81",
      term: "flimsum",
      translation: "doorway",
      example: "",
      tags: ["a", "b", "c"],
      added: "2026-01-02",
    });
  });

  it("reports every row when a required column is missing from the header", () => {
    const result = parseSheetCsv(
      [
        "id,term,example,tags,added",
        "wa3f19c2b81,flimsum,,noun,2026-01-02",
        "wb7c02d4e19,gorbik,,verb,2026-01-03",
      ].join("\n"),
      SYNCED_AT,
    );

    expect(result.words).toEqual([]);
    expect(result.invalid.map((invalidRow) => invalidRow.row)).toEqual([2, 3]);
    for (const invalidRow of result.invalid) {
      expect(invalidRow.issues.join(" ")).toContain("translation");
    }
  });

  it("reports a row with an empty required field and keeps the other rows", () => {
    const result = parseSheetCsv(
      csv(
        "wa3f19c2b81,flimsum,doorway,,,",
        "wb7c02d4e19,   ,to wander,,,",
        "wc51e8a0f2d,trellup,quiet,,,",
      ),
      SYNCED_AT,
    );

    expect(result.words.map((word) => word.id)).toEqual([
      "wa3f19c2b81",
      "wc51e8a0f2d",
    ]);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0].row).toBe(3);
    expect(result.invalid[0].issues.join(" ")).toContain("term");
  });

  it("keeps the first row of a duplicated id and reports the later one", () => {
    const result = parseSheetCsv(
      csv(
        "wa3f19c2b81,flimsum,doorway,,,",
        "wb7c02d4e19,gorbik,to wander,,,",
        "wa3f19c2b81,flimsum,gateway,,,",
      ),
      SYNCED_AT,
    );

    expect(result.words.map((word) => word.id)).toEqual([
      "wa3f19c2b81",
      "wb7c02d4e19",
    ]);
    expect(result.words[0].translation).toBe("doorway");
    expect(result.invalid).toEqual([
      {
        row: 4,
        issues: [
          'Duplicate id "wa3f19c2b81", already used in row 2. The earlier row is kept.',
        ],
      },
    ]);
  });

  it("reports an unterminated quote against the broken row and keeps the valid ones", () => {
    const result = parseSheetCsv(
      csv("wa3f19c2b81,flimsum,doorway,,,", 'wb7c02d4e19,"gorbik,to wander,,,'),
      SYNCED_AT,
    );

    expect(result.words.map((word) => word.id)).toEqual(["wa3f19c2b81"]);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0].row).toBe(3);
    expect(result.invalid[0].issues.join(" ")).toContain("Quoted field unterminated");
  });

  it("reports a malformed quote at its own row and keeps the rows around it", () => {
    const result = parseSheetCsv(
      csv(
        "wa3f19c2b81,flimsum,doorway,,,",
        'wb7c02d4e19,"gorbik"stray",to wander,,,',
        "wc51e8a0f2d,trellup,quiet,,,",
      ),
      SYNCED_AT,
    );

    expect(result.words.map((word) => word.id)).toEqual([
      "wa3f19c2b81",
      "wc51e8a0f2d",
    ]);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0].row).toBe(3);
    expect(result.invalid[0].issues.join(" ")).toContain("quote");
  });

  it("parses the crlf line endings and byte order mark google exports", () => {
    const result = parseSheetCsv(
      `﻿${HEADER}\r\nwa3f19c2b81,flimsum,doorway,,"noun, house",2026-01-02\r\n`,
      SYNCED_AT,
    );

    expect(result.invalid).toEqual([]);
    expect(result.words).toEqual([
      {
        id: "wa3f19c2b81",
        term: "flimsum",
        translation: "doorway",
        example: "",
        tags: ["noun", "house"],
        added: "2026-01-02",
      },
    ]);
  });

  it("reports a row with too many fields and keeps the rows around it", () => {
    const result = parseSheetCsv(
      csv(
        "wa3f19c2b81,flimsum,doorway,,,",
        "wb7c02d4e19,gorbik,to wander,,,,stray",
        "wc51e8a0f2d,trellup,quiet,,,",
      ),
      SYNCED_AT,
    );

    expect(result.words.map((word) => word.id)).toEqual([
      "wa3f19c2b81",
      "wc51e8a0f2d",
    ]);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0].row).toBe(3);
    expect(result.invalid[0].issues.join(" ")).toContain("Too many fields");
    // The row is otherwise valid, so the tutor is told which word was dropped and why.
    expect(result.invalid[0].issues).toContain(
      'Skipped "gorbik": the row is malformed, so its columns may be shifted and the translation could be wrong. Fix the row in the sheet.',
    );
  });

  it("reports an empty row once instead of once per required column", () => {
    const result = parseSheetCsv(
      csv("wa3f19c2b81,flimsum,doorway,,,", ",,,,,", "wc51e8a0f2d,trellup,quiet,,,"),
      SYNCED_AT,
    );

    expect(result.words.map((word) => word.id)).toEqual([
      "wa3f19c2b81",
      "wc51e8a0f2d",
    ]);
    expect(result.invalid).toEqual([
      { row: 3, issues: ["Row is empty. Delete it in the sheet or fill it in."] },
    ]);
  });

  it("ignores helper columns the sheet keeps beside the documented ones", () => {
    const result = parseSheetCsv(
      [
        "id,term,status,translation,example,tags,added",
        "wa3f19c2b81,flimsum,still learning,doorway,,noun,2026-01-02",
      ].join("\n"),
      SYNCED_AT,
    );

    expect(result.invalid).toEqual([]);
    expect(result.words).toEqual([
      {
        id: "wa3f19c2b81",
        term: "flimsum",
        translation: "doorway",
        example: "",
        tags: ["noun"],
        added: "2026-01-02",
      },
    ]);
  });

  it("treats a row where only a helper column says anything as empty, not as a broken word", () => {
    const result = parseSheetCsv(
      [
        "id,term,translation,example,tags,added,status",
        "wa3f19c2b81,flimsum,doorway,,noun,2026-01-02,learning",
        ",,,,,,add a word here",
        "wc51e8a0f2d,trellup,quiet,,,,",
      ].join("\n"),
      SYNCED_AT,
    );

    expect(result.words.map((word) => word.id)).toEqual([
      "wa3f19c2b81",
      "wc51e8a0f2d",
    ]);
    expect(result.invalid).toEqual([
      { row: 3, issues: ["Row is empty. Delete it in the sheet or fill it in."] },
    ]);
  });

  it("silently drops the rows a helper formula publishes below the last word", () => {
    const result = parseSheetCsv(
      [
        "id,term,translation,example,tags,added,status",
        "wa3f19c2b81,flimsum,doorway,,noun,2026-01-02,learning",
        ",,,,,,add a word here",
        ",,,,,,",
      ].join("\n"),
      SYNCED_AT,
    );

    expect(result.words.map((word) => word.id)).toEqual(["wa3f19c2b81"]);
    expect(result.invalid).toEqual([]);
  });

  it("returns nothing but does not throw on an empty body", () => {
    const result = parseSheetCsv("", SYNCED_AT);

    expect(result.words).toEqual([]);
    expect(result.syncedAt).toBe(SYNCED_AT);
  });
});

describe("looksLikeHtml", () => {
  it("detects the pages Google serves instead of an unpublished sheet", () => {
    expect(looksLikeHtml("<!DOCTYPE html><html><body>Sign in</body></html>")).toBe(true);
    expect(looksLikeHtml("\n  <html lang=\"en\">")).toBe(true);
    expect(looksLikeHtml("<HTML>")).toBe(true);
  });

  it("accepts a csv body", () => {
    expect(looksLikeHtml(csv("wa3f19c2b81,flimsum,doorway,,,"))).toBe(false);
  });
});

describe("fetchSheet", () => {
  it("parses the published csv and records when it was synced", async () => {
    vi.stubEnv("SHEET_CSV_URL", CSV_URL);
    const fetchMock = stubFetch(
      new Response(csv("wa3f19c2b81,flimsum,doorway,,noun,2026-01-02"), {
        headers: { "content-type": "text/csv" },
      }),
    );

    const result = await fetchSheet({ fresh: false });

    if (!result.ok) {
      throw new Error(`expected a parsed sheet, got ${result.error.code}`);
    }
    expect(result.sheet.words.map((word) => word.term)).toEqual(["flimsum"]);
    expect(Number.isNaN(Date.parse(result.sheet.syncedAt))).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(CSV_URL, {
      next: { revalidate: 300 },
    });
  });

  it("bypasses every cache when asked for fresh data", async () => {
    vi.stubEnv("SHEET_CSV_URL", CSV_URL);
    const fetchMock = stubFetch(
      new Response(csv("wa3f19c2b81,flimsum,doorway,,,")),
    );

    await fetchSheet({ fresh: true });

    expect(fetchMock).toHaveBeenCalledWith(CSV_URL, { cache: "no-store" });
  });

  it("reports an html body as a sheet that is not published", async () => {
    vi.stubEnv("SHEET_CSV_URL", CSV_URL);
    stubFetch(
      new Response("<!DOCTYPE html><html><body>Sign in</body></html>", {
        headers: { "content-type": "text/plain" },
      }),
    );

    const result = await fetchSheet({ fresh: true });

    if (result.ok) {
      throw new Error("expected an error for an html body");
    }
    expect(result.error.code).toBe("SHEET_NOT_PUBLISHED");
    expect(result.error.message).toContain("Publish to web");
  });

  it("reports an html content type as a sheet that is not published", async () => {
    vi.stubEnv("SHEET_CSV_URL", CSV_URL);
    stubFetch(
      new Response("anything", { headers: { "content-type": "text/html" } }),
    );

    const result = await fetchSheet({ fresh: true });

    if (result.ok) {
      throw new Error("expected an error for an html content type");
    }
    expect(result.error.code).toBe("SHEET_NOT_PUBLISHED");
  });

  it("reports when google answered, so a cached response cannot claim a fresh sync", async () => {
    vi.stubEnv("SHEET_CSV_URL", CSV_URL);
    stubFetch(
      new Response(csv("wa3f19c2b81,flimsum,doorway,,,"), {
        headers: {
          "content-type": "text/csv",
          date: "Mon, 05 Jan 2026 09:00:00 GMT",
        },
      }),
    );

    const result = await fetchSheet({ fresh: false });

    if (!result.ok) {
      throw new Error(`expected a parsed sheet, got ${result.error.code}`);
    }
    expect(result.sheet.syncedAt).toBe(SYNCED_AT);
  });

  it("falls back to request time when the response carries no date", async () => {
    vi.stubEnv("SHEET_CSV_URL", CSV_URL);
    stubFetch(
      new Response(csv("wa3f19c2b81,flimsum,doorway,,,"), {
        headers: { "content-type": "text/csv" },
      }),
    );
    const before = Date.now();

    const result = await fetchSheet({ fresh: true });

    if (!result.ok) {
      throw new Error(`expected a parsed sheet, got ${result.error.code}`);
    }
    const syncedAt = Date.parse(result.sheet.syncedAt);
    expect(Number.isNaN(syncedAt)).toBe(false);
    expect(syncedAt).toBeGreaterThanOrEqual(before);
  });

  it("reports an html page with a server error as unreachable, not unpublished", async () => {
    vi.stubEnv("SHEET_CSV_URL", CSV_URL);
    stubFetch(
      new Response("<!DOCTYPE html><html><body>Server Error</body></html>", {
        status: 503,
        statusText: "Service Unavailable",
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );

    const result = await fetchSheet({ fresh: true });

    if (result.ok) {
      throw new Error("expected an error for an html 503");
    }
    expect(result.error.code).toBe("SHEET_UNREACHABLE");
    expect(result.error.message).toContain("503");
  });

  it("reports throttling as unreachable, not unpublished", async () => {
    vi.stubEnv("SHEET_CSV_URL", CSV_URL);
    stubFetch(
      new Response("<!DOCTYPE html><html><body>Too Many Requests</body></html>", {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );

    const result = await fetchSheet({ fresh: true });

    if (result.ok) {
      throw new Error("expected an error for an html 429");
    }
    expect(result.error.code).toBe("SHEET_UNREACHABLE");
    expect(result.error.message).toContain("429");
  });

  it("never dates a sync in the future, whatever the date header claims", async () => {
    vi.stubEnv("SHEET_CSV_URL", CSV_URL);
    stubFetch(
      new Response(csv("wa3f19c2b81,flimsum,doorway,,,"), {
        headers: {
          "content-type": "text/csv",
          date: "Tue, 01 Jan 2999 00:00:00 GMT",
        },
      }),
    );
    const before = Date.now();

    const result = await fetchSheet({ fresh: true });

    if (!result.ok) {
      throw new Error(`expected a parsed sheet, got ${result.error.code}`);
    }
    const syncedAt = Date.parse(result.sheet.syncedAt);
    expect(syncedAt).toBeGreaterThanOrEqual(before);
    expect(syncedAt).toBeLessThanOrEqual(Date.now());
  });

  it("reports the html 404 of an unpublished sheet as not published", async () => {
    vi.stubEnv("SHEET_CSV_URL", CSV_URL);
    stubFetch(
      new Response("<!DOCTYPE html><html><body>Sorry, unavailable.</body></html>", {
        status: 404,
        statusText: "Not Found",
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );

    const result = await fetchSheet({ fresh: true });

    if (result.ok) {
      throw new Error("expected an error for an html 404");
    }
    expect(result.error.code).toBe("SHEET_NOT_PUBLISHED");
    expect(result.error.message).toContain("Publish to web");
    expect(result.error.message).toContain("404");
  });

  it("reports a failing status without html as unreachable", async () => {
    vi.stubEnv("SHEET_CSV_URL", CSV_URL);
    stubFetch(
      new Response("", {
        status: 503,
        statusText: "Service Unavailable",
        headers: { "content-type": "text/plain" },
      }),
    );

    const result = await fetchSheet({ fresh: true });

    if (result.ok) {
      throw new Error("expected an error for a 503 response");
    }
    expect(result.error.code).toBe("SHEET_UNREACHABLE");
    expect(result.error.message).toContain("503");
  });

  it("reports the nested cause of a failed fetch, not the bare wrapper", async () => {
    vi.stubEnv("SHEET_CSV_URL", CSV_URL);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: new Error("getaddrinfo ENOTFOUND docs.google.com"),
        });
      }),
    );

    const result = await fetchSheet({ fresh: false });

    if (result.ok) {
      throw new Error("expected an error for a failing network");
    }
    expect(result.error.code).toBe("SHEET_UNREACHABLE");
    expect(result.error.message).toContain("getaddrinfo ENOTFOUND");
  });

  it("keeps the configured url out of a network failure message", async () => {
    vi.stubEnv("SHEET_CSV_URL", CSV_URL);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new TypeError(`request to ${CSV_URL} failed`);
      }),
    );

    const result = await fetchSheet({ fresh: false });

    if (result.ok) {
      throw new Error("expected an error for a failing network");
    }
    expect(result.error.message).not.toContain(CSV_URL);
    expect(result.error.message).toContain("the configured sheet URL");
  });

  it("reports a missing environment variable without fetching", async () => {
    vi.stubEnv("SHEET_CSV_URL", "");
    const fetchMock = stubFetch(new Response(""));

    const result = await fetchSheet({ fresh: false });

    if (result.ok) {
      throw new Error("expected an error for a missing SHEET_CSV_URL");
    }
    expect(result.error.code).toBe("SHEET_CSV_URL_MISSING");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only environment variable as missing", async () => {
    vi.stubEnv("SHEET_CSV_URL", "   ");
    const fetchMock = stubFetch(new Response(""));

    const result = await fetchSheet({ fresh: false });

    if (result.ok) {
      throw new Error("expected an error for a blank SHEET_CSV_URL");
    }
    expect(result.error.code).toBe("SHEET_CSV_URL_MISSING");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a misconfigured url without repeating its value", async () => {
    const misconfigured = "2PACX-secret-key-pasted-without-the-scheme";
    vi.stubEnv("SHEET_CSV_URL", misconfigured);
    const fetchMock = stubFetch(new Response(""));

    const result = await fetchSheet({ fresh: false });

    if (result.ok) {
      throw new Error("expected an error for a misconfigured SHEET_CSV_URL");
    }
    expect(result.error.code).toBe("SHEET_CSV_URL_INVALID");
    expect(result.error.message).not.toContain(misconfigured);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
