import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SheetFetchResult } from "@/lib/sheet";

// The route's statuses are a contract with the device: any failure stops its prefetch pass
// until the next visit. Next's data cache and the sheet are replaced with fakes that behave
// like them — the cache remembers what its function resolves to, and only that — and Google
// with a stubbed fetch.
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

const { POST } = await import("./route");

function sheetWith(...words: { term: string; example?: string }[]): SheetFetchResult {
  return {
    ok: true,
    sheet: {
      words: words.map(({ term, example = "" }) => ({
        id: term,
        term,
        translation: "перевод",
        example,
        tags: [],
        added: "",
      })),
      invalid: [],
      syncedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

function request(body: unknown): NextRequest {
  return new NextRequest("https://slovnyk.test/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function googleAnswer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Google as it answers when all is well: each text back with a prefix.
async function googleTranslatesEach(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const body: { q: string[] } = JSON.parse(String(init?.body));
  return googleAnswer({
    data: { translations: body.q.map((text) => ({ translatedText: `ru: ${text}` })) },
  });
}

let googleFetch: ReturnType<typeof vi.fn<typeof fetch>>;

// Every text Google was asked to translate, in the order asked.
function textsSentToGoogle(): string[] {
  return googleFetch.mock.calls.flatMap(([, init]) => {
    const body: { q: string[] } = JSON.parse(String(init?.body));
    return body.q;
  });
}

beforeEach(() => {
  dataCache.clear();
  fetchSheet.mockReset();
  fetchSheet.mockResolvedValue(
    sheetWith({ term: "glimmerfold", example: "She glimmerfolds the letter." }),
  );
  googleFetch = vi.fn<typeof fetch>(googleTranslatesEach);
  vi.stubGlobal("fetch", googleFetch);
  vi.stubEnv("GOOGLE_TRANSLATE_API_KEY", "test-key-qwerty");
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

describe("POST /api/translate", () => {
  it("answers 503 without a key, before looking at the sheet", async () => {
    vi.stubEnv("GOOGLE_TRANSLATE_API_KEY", "");

    const response = await POST(request({ texts: ["glimmerfold"] }));

    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("TRANSLATION_NOT_CONFIGURED");
    expect(fetchSheet).not.toHaveBeenCalled();
  });

  it("answers 400 to a body that is not a list of texts", async () => {
    for (const body of ["not json", {}, { texts: [] }, { texts: [1] }]) {
      const response = await POST(request(body));

      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe("TRANSLATION_REQUEST_INVALID");
    }
    expect(googleFetch).not.toHaveBeenCalled();
  });

  it("translates the term and the example, and nothing the sheet does not hold", async () => {
    const response = await POST(
      request({ texts: ["glimmerfold", "translate my essay", "She glimmerfolds the letter."] }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      translations: [
        { text: "glimmerfold", translation: "ru: glimmerfold" },
        {
          text: "She glimmerfolds the letter.",
          translation: "ru: She glimmerfolds the letter.",
        },
      ],
    });
    expect(textsSentToGoogle()).toEqual(["glimmerfold", "She glimmerfolds the letter."]);
  });

  it("asks Google once per text, however the requests cut the texts into batches", async () => {
    await POST(request({ texts: ["glimmerfold"] }));
    const again = await POST(request({ texts: ["She glimmerfolds the letter.", "glimmerfold"] }));

    expect(await again.json()).toEqual({
      translations: [
        {
          text: "She glimmerfolds the letter.",
          translation: "ru: She glimmerfolds the letter.",
        },
        { text: "glimmerfold", translation: "ru: glimmerfold" },
      ],
    });
    expect(textsSentToGoogle()).toEqual(["glimmerfold", "She glimmerfolds the letter."]);
  });

  it("answers an empty list, without calling Google, when no text is in the sheet", async () => {
    const response = await POST(request({ texts: ["translate my essay"] }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ translations: [] });
    expect(googleFetch).not.toHaveBeenCalled();
  });

  it("passes a sheet failure on with its own code", async () => {
    fetchSheet.mockResolvedValue({
      ok: false,
      error: { code: "SHEET_NOT_PUBLISHED", message: "publish it" },
    });

    const response = await POST(request({ texts: ["glimmerfold"] }));

    expect(response.status).toBe(502);
    expect(await errorCode(response)).toBe("SHEET_NOT_PUBLISHED");
    expect(googleFetch).not.toHaveBeenCalled();
  });

  it("leaves out a text that failed beside others, and sends only that one next time", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Forty texts make three groups, so each answer is checked against its own text across
    // group boundaries.
    const terms = Array.from({ length: 40 }, (_, index) => `flonk${index}`);
    fetchSheet.mockResolvedValue(sheetWith(...terms.map((term) => ({ term }))));
    googleFetch.mockImplementation(async (url, init) => {
      const body: { q: string[] } = JSON.parse(String(init?.body));
      return body.q[0] === "flonk20"
        ? googleAnswer({ error: { status: "UNAVAILABLE" } }, 503)
        : googleTranslatesEach(url, init);
    });

    const first = await POST(request({ texts: terms }));
    googleFetch.mockImplementation(googleTranslatesEach);
    const second = await POST(request({ texts: terms }));

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      translations: terms
        .filter((term) => term !== "flonk20")
        .map((text) => ({ text, translation: `ru: ${text}` })),
    });
    expect(await second.json()).toEqual({
      translations: terms.map((text) => ({ text, translation: `ru: ${text}` })),
    });
    expect(textsSentToGoogle()).toEqual([...terms, "flonk20"]);
  });

  it("stops at a group in which every text failed, and says why once", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const terms = Array.from({ length: 40 }, (_, index) => `flonk${index}`);
    fetchSheet.mockResolvedValue(sheetWith(...terms.map((term) => ({ term }))));
    googleFetch.mockImplementation(async () =>
      googleAnswer({ error: { status: "RESOURCE_EXHAUSTED", message: "Daily Limit Exceeded" } }, 403),
    );

    const response = await POST(request({ texts: terms }));

    expect(response.status).toBe(502);
    expect(await errorCode(response)).toBe("TRANSLATION_FAILED");
    // A spent quota refuses every text alike, so the groups after the first are not sent.
    expect(textsSentToGoogle()).toEqual(terms.slice(0, 16));
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0][0]).match(/Daily Limit Exceeded/g)).toHaveLength(1);
  });

  it("answers 502 rather than crashing when the data cache fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(dataCache, "get").mockImplementation(() => {
      throw new Error("data cache unreachable");
    });

    const response = await POST(request({ texts: ["glimmerfold"] }));

    expect(response.status).toBe(502);
    expect(String(consoleError.mock.calls[0][0])).toContain("data cache unreachable");
  });

  it("answers 502 with Google's reason in the log only", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    googleFetch.mockImplementationOnce(async () =>
      googleAnswer(
        {
          error: {
            status: "PERMISSION_DENIED",
            message: "Cloud Translation API has not been used in project 1234 before",
          },
        },
        403,
      ),
    );

    const response = await POST(request({ texts: ["glimmerfold"] }));
    const body = JSON.stringify(await response.json());

    expect(response.status).toBe(502);
    expect(body).toContain("TRANSLATION_FAILED");
    expect(body).not.toContain("1234");
    expect(String(consoleError.mock.calls[0][0])).toContain("project 1234");
  });
});
