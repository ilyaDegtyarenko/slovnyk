import { describe, expect, it, vi } from "vitest";
import type { SheetFetchResult, Word } from "./sheet";
import {
  lookUpVocabularyTerm,
  MAX_TERM_LENGTH,
  PronunciationQuery,
  synthesizeSpeech,
} from "./tts";

const VOICE = { languageCode: "en-US", name: "en-US-Test-Voice" };
const API_KEY = "test-key-qwerty";

function word(term: string): Word {
  return {
    id: term,
    term,
    translation: "перевод",
    example: "",
    tags: [],
    added: "",
  };
}

function sheetWith(...terms: string[]): SheetFetchResult {
  return {
    ok: true,
    sheet: { words: terms.map(word), invalid: [], syncedAt: "2026-01-01T00:00:00.000Z" },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("synthesizeSpeech", () => {
  it("asks for one MP3 in the given voice and decodes the audio", async () => {
    const audio = new Uint8Array([0x49, 0x44, 0x33, 0x04]);
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ audioContent: Buffer.from(audio).toString("base64") }),
    );

    const result = await synthesizeSpeech({
      term: "glimmerfold",
      apiKey: API_KEY,
      voice: VOICE,
      fetchImpl,
    });

    expect(result).toEqual({ ok: true, audio });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://texttospeech.googleapis.com/v1/text:synthesize");
    // The key travels in a header, never in the URL that ends up in logs.
    expect(String(url)).not.toContain(API_KEY);
    expect(new Headers(init?.headers).get("x-goog-api-key")).toBe(API_KEY);
    // A hung upstream must not hold the serverless function open.
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body))).toEqual({
      input: { text: "glimmerfold" },
      voice: VOICE,
      audioConfig: { audioEncoding: "MP3" },
    });
  });

  it("names Google's own reason when the request is refused", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(
        {
          error: {
            code: 403,
            status: "PERMISSION_DENIED",
            message: "Cloud Text-to-Speech API has not been used in project 1 before",
          },
        },
        403,
      ),
    );

    const result = await synthesizeSpeech({
      term: "glimmerfold",
      apiKey: API_KEY,
      voice: VOICE,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PRONUNCIATION_FAILED");
      expect(result.error.message).toContain("HTTP 403");
      expect(result.error.message).toContain("PERMISSION_DENIED");
      expect(result.error.message).toContain("has not been used");
      expect(result.error.message).not.toContain(API_KEY);
    }
  });

  it.each([
    ["the network fails", async () => Promise.reject(new TypeError("fetch failed"))],
    ["the body is not JSON", async () => new Response("<html>", { status: 502 })],
    ["the answer has no audio", async () => jsonResponse({ audioContent: "" })],
    ["the answer is some other shape", async () => jsonResponse({ audio: "AAAA" })],
  ])("fails without throwing when %s", async (_situation, respond) => {
    const result = await synthesizeSpeech({
      term: "glimmerfold",
      apiKey: API_KEY,
      voice: VOICE,
      fetchImpl: vi.fn<typeof fetch>(respond),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PRONUNCIATION_FAILED");
    }
  });
});

describe("lookUpVocabularyTerm", () => {
  it("accepts a term the cached sheet already has, without asking again", async () => {
    const loadSheet = vi.fn(async () => sheetWith("glimmerfold", "on the fence"));

    expect(await lookUpVocabularyTerm("on the fence", loadSheet)).toEqual({ ok: true });
    expect(loadSheet).toHaveBeenCalledTimes(1);
    expect(loadSheet).toHaveBeenCalledWith({ fresh: false });
  });

  it("gives a term missing from the cached sheet one fresh look", async () => {
    const loadSheet = vi.fn(async ({ fresh }: { fresh: boolean }) =>
      fresh ? sheetWith("glimmerfold", "brandnewish") : sheetWith("glimmerfold"),
    );

    expect(await lookUpVocabularyTerm("brandnewish", loadSheet)).toEqual({ ok: true });
    expect(loadSheet.mock.calls).toEqual([[{ fresh: false }], [{ fresh: true }]]);
  });

  it("refuses text that is not in the sheet at all", async () => {
    const loadSheet = vi.fn(async () => sheetWith("glimmerfold"));

    const lookup = await lookUpVocabularyTerm("read me a whole novel", loadSheet);

    expect(lookup.ok).toBe(false);
    if (!lookup.ok) {
      expect(lookup.error.code).toBe("PRONUNCIATION_TERM_UNKNOWN");
    }
  });

  it("matches whole terms only", async () => {
    const loadSheet = vi.fn(async () => sheetWith("on the fence"));

    expect((await lookUpVocabularyTerm("fence", loadSheet)).ok).toBe(false);
  });

  it("relays a sheet that cannot be read", async () => {
    const loadSheet = vi.fn(
      async (): Promise<SheetFetchResult> => ({
        ok: false,
        error: { code: "SHEET_UNREACHABLE", message: "down" },
      }),
    );

    expect(await lookUpVocabularyTerm("glimmerfold", loadSheet)).toEqual({
      ok: false,
      error: { code: "SHEET_UNREACHABLE", message: "down" },
    });
  });
});

describe("PronunciationQuery", () => {
  it("trims the term", () => {
    expect(PronunciationQuery.parse({ term: "  give up " })).toEqual({ term: "give up" });
  });

  it.each(["", "   ", "x".repeat(MAX_TERM_LENGTH + 1)])(
    "refuses %j",
    (term) => {
      expect(PronunciationQuery.safeParse({ term }).success).toBe(false);
    },
  );
});
