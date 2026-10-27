import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SheetFetchResult } from "@/lib/sheet";

// The route's statuses are a contract with the device: 503 stops a whole prefetch pass,
// anything else costs one word. Next's data cache and the sheet are replaced with fakes
// that behave like them — the cache remembers what its function resolves to, and only
// that, and like the real one hands a hit back through JSON.
const dataCache = new Map<string, string>();
vi.mock("next/cache", () => ({
  unstable_cache:
    <Result>(compute: () => Promise<Result>, keyParts: string[]) =>
    async (): Promise<Result> => {
      const key = JSON.stringify(keyParts);
      const stored = dataCache.get(key);
      if (stored !== undefined) {
        return JSON.parse(stored) as Result;
      }
      const result = await compute();
      dataCache.set(key, JSON.stringify(result));
      return result;
    },
}));

const fetchSheet = vi.fn<(options: { fresh: boolean }) => Promise<SheetFetchResult>>();
vi.mock("@/lib/sheet", () => ({ fetchSheet: (options: { fresh: boolean }) => fetchSheet(options) }));

const { GET } = await import("./route");

const MP3_BYTES = new Uint8Array([0x49, 0x44, 0x33, 0x04]);

function sheetWith(...terms: string[]): SheetFetchResult {
  return {
    ok: true,
    sheet: {
      words: terms.map((term) => ({
        id: term,
        term,
        translation: "перевод",
        example: "",
        tags: [],
        added: "",
      })),
      invalid: [],
      syncedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

function request(term?: string): NextRequest {
  const url = new URL("https://slovnyk.test/api/pronounce");
  if (term !== undefined) {
    url.searchParams.set("term", term);
  }
  return new NextRequest(url);
}

function googleAnswer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let googleFetch: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  dataCache.clear();
  fetchSheet.mockReset();
  fetchSheet.mockResolvedValue(sheetWith("glimmerfold"));
  googleFetch = vi.fn<typeof fetch>(async () =>
    googleAnswer({ audioContent: Buffer.from(MP3_BYTES).toString("base64") }),
  );
  vi.stubGlobal("fetch", googleFetch);
  vi.stubEnv("GOOGLE_TTS_API_KEY", "test-key-qwerty");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function errorCode(response: Response): Promise<string> {
  const body: { error: { code: string } } = await response.json();
  return body.error.code;
}

describe("GET /api/pronounce", () => {
  it("answers 503 without a key, before looking at the sheet", async () => {
    vi.stubEnv("GOOGLE_TTS_API_KEY", "");

    const response = await GET(request("glimmerfold"));

    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("PRONUNCIATION_NOT_CONFIGURED");
    expect(fetchSheet).not.toHaveBeenCalled();
  });

  it("answers 400 without a term", async () => {
    const response = await GET(request());

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("PRONUNCIATION_TERM_INVALID");
  });

  it("answers 404 for text that is not in the sheet, without calling Google", async () => {
    const response = await GET(request("read me a whole novel"));

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("PRONUNCIATION_TERM_UNKNOWN");
    expect(googleFetch).not.toHaveBeenCalled();
  });

  it("sends the recording as MP3 that no HTTP cache keeps", async () => {
    const response = await GET(request("glimmerfold"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(MP3_BYTES);
  });

  it("asks Google once per term, however often the term is requested", async () => {
    await GET(request("glimmerfold"));
    const again = await GET(request("glimmerfold"));

    expect(again.status).toBe(200);
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(MP3_BYTES);
    expect(googleFetch).toHaveBeenCalledTimes(1);
  });

  it("keeps each term's own recording", async () => {
    fetchSheet.mockResolvedValue(sheetWith("glimmerfold", "give up"));
    const recordingOf = (term: string) => new TextEncoder().encode(`mp3 of ${term}`);
    googleFetch.mockImplementation(async (_url, init) => {
      const body: { input: { text: string } } = JSON.parse(String(init?.body));
      return googleAnswer({
        audioContent: Buffer.from(recordingOf(body.input.text)).toString("base64"),
      });
    });

    for (const term of ["glimmerfold", "give up", "glimmerfold", "give up"]) {
      const response = await GET(request(term));
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(recordingOf(term));
    }
    expect(googleFetch).toHaveBeenCalledTimes(2);
  });

  it("answers 502 with Google's reason in the log only, and tries again next time", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    googleFetch.mockImplementationOnce(async () =>
      googleAnswer(
        {
          error: {
            status: "PERMISSION_DENIED",
            message: "Cloud Text-to-Speech API has not been used in project 1234 before",
          },
        },
        403,
      ),
    );

    const failed = await GET(request("glimmerfold"));
    const body = JSON.stringify(await failed.json());
    const retried = await GET(request("glimmerfold"));

    expect(failed.status).toBe(502);
    expect(body).toContain("PRONUNCIATION_FAILED");
    expect(body).not.toContain("1234");
    expect(String(consoleError.mock.calls[0][0])).toContain("project 1234");
    expect(retried.status).toBe(200);
    expect(googleFetch).toHaveBeenCalledTimes(2);
  });
});
