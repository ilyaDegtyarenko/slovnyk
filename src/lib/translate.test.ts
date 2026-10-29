import { describe, expect, it, vi } from "vitest";
import type { SheetFetchResult, Word } from "./sheet";
import {
  keepVocabularyTexts,
  MAX_CHARACTERS_PER_REQUEST,
  MAX_TEXT_LENGTH,
  MAX_TEXTS_PER_REQUEST,
  translateEach,
  TranslationRequest,
  translateTexts,
} from "./translate";

const API_KEY = "test-key-qwerty";

function word(term: string, example = ""): Word {
  return {
    id: term,
    term,
    translation: "перевод",
    example,
    tags: [],
    added: "",
  };
}

function sheetWith(...words: Word[]): SheetFetchResult {
  return {
    ok: true,
    sheet: { words, invalid: [], syncedAt: "2026-01-01T00:00:00.000Z" },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function googleAnswer(...translations: string[]): Response {
  return jsonResponse({
    data: { translations: translations.map((translatedText) => ({ translatedText })) },
  });
}

describe("translateTexts", () => {
  it("asks for plain-text English-to-Russian and pairs each answer with its text", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      googleAnswer("глиммерфолд", "Он глиммерфолдит каждое утро."),
    );

    const result = await translateTexts({
      texts: ["glimmerfold", "He glimmerfolds every morning."],
      apiKey: API_KEY,
      fetchImpl,
    });

    expect(result).toEqual({
      ok: true,
      translations: [
        { text: "glimmerfold", translation: "глиммерфолд" },
        {
          text: "He glimmerfolds every morning.",
          translation: "Он глиммерфолдит каждое утро.",
        },
      ],
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://translation.googleapis.com/language/translate/v2");
    // The key travels in a header, never in the URL that ends up in logs.
    expect(String(url)).not.toContain(API_KEY);
    expect(new Headers(init?.headers).get("x-goog-api-key")).toBe(API_KEY);
    expect(init?.method).toBe("POST");
    // A hung upstream must not hold the serverless function open.
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body))).toEqual({
      q: ["glimmerfold", "He glimmerfolds every morning."],
      source: "en",
      target: "ru",
      // HTML, Google's default, would hand apostrophes back as entities.
      format: "text",
    });
  });

  it("refuses an answer whose length does not match the texts asked", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => googleAnswer("только одно"));

    const result = await translateTexts({
      texts: ["flonk", "wibbet"],
      apiKey: API_KEY,
      fetchImpl,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "TRANSLATION_FAILED",
        message: "Cloud Translation answered 1 translations for 2 texts.",
      },
    });
  });

  it("names Google's own reason when the request is refused", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(
        {
          error: {
            code: 403,
            status: "PERMISSION_DENIED",
            message: "Cloud Translation API has not been used in project 1 before",
          },
        },
        403,
      ),
    );

    const result = await translateTexts({ texts: ["flonk"], apiKey: API_KEY, fetchImpl });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "TRANSLATION_FAILED",
        message:
          "Cloud Translation answered HTTP 403 — PERMISSION_DENIED: Cloud Translation API has not been used in project 1 before",
      },
    });
  });

  it("reports an unreachable service, a body that is not JSON, and one without translations", async () => {
    const unreachable = await translateTexts({
      texts: ["flonk"],
      apiKey: API_KEY,
      fetchImpl: vi.fn<typeof fetch>(async () => {
        throw new TypeError("fetch failed");
      }),
    });
    const notJson = await translateTexts({
      texts: ["flonk"],
      apiKey: API_KEY,
      fetchImpl: vi.fn<typeof fetch>(async () => new Response("<html>", { status: 502 })),
    });
    const empty = await translateTexts({
      texts: ["flonk"],
      apiKey: API_KEY,
      fetchImpl: vi.fn<typeof fetch>(async () => jsonResponse({ data: {} })),
    });

    expect(unreachable).toEqual({
      ok: false,
      error: { code: "TRANSLATION_FAILED", message: "Cloud Translation could not be reached." },
    });
    expect(notJson).toEqual({
      ok: false,
      error: {
        code: "TRANSLATION_FAILED",
        message: "Cloud Translation answered HTTP 502 with a body that is not JSON.",
      },
    });
    expect(empty).toEqual({
      ok: false,
      error: {
        code: "TRANSLATION_FAILED",
        message: "Cloud Translation answered without translations.",
      },
    });
  });
});

describe("keepVocabularyTexts", () => {
  it("keeps terms and examples the cached sheet holds, once each, without a fresh look", async () => {
    const loadSheet = vi.fn(async () =>
      sheetWith(word("flonk", "A flonk sat on the wall."), word("wibbet")),
    );

    const result = await keepVocabularyTexts(
      ["wibbet", "A flonk sat on the wall.", "wibbet"],
      loadSheet,
    );

    expect(result).toEqual({ ok: true, texts: ["wibbet", "A flonk sat on the wall."] });
    expect(loadSheet).toHaveBeenCalledTimes(1);
    expect(loadSheet).toHaveBeenCalledWith({ fresh: false });
  });

  it("gives text the cached sheet lacks one fresh look before leaving it out", async () => {
    const loadSheet = vi.fn(async ({ fresh }: { fresh: boolean }) =>
      fresh ? sheetWith(word("flonk"), word("zorvel")) : sheetWith(word("flonk")),
    );

    const result = await keepVocabularyTexts(
      ["flonk", "zorvel", "translate this paragraph for free"],
      loadSheet,
    );

    // Text the sheet does not hold never reaches Google, so the bill stays bounded by the
    // vocabulary however a request is written.
    expect(result).toEqual({ ok: true, texts: ["flonk", "zorvel"] });
    expect(loadSheet.mock.calls).toEqual([[{ fresh: false }], [{ fresh: true }]]);
  });

  it("keeps what the cached sheet holds even when the fresh look is an older copy", async () => {
    // Google's publish lag can answer a fresh look with a sheet older than the cached one.
    const loadSheet = vi.fn(async ({ fresh }: { fresh: boolean }) =>
      fresh ? sheetWith(word("zorvel")) : sheetWith(word("flonk")),
    );

    const result = await keepVocabularyTexts(["flonk", "zorvel", "quobble"], loadSheet);

    expect(result).toEqual({ ok: true, texts: ["flonk", "zorvel"] });
  });

  it("keeps the cached answer when the fresh look fails", async () => {
    const loadSheet = vi.fn(
      async ({ fresh }: { fresh: boolean }): Promise<SheetFetchResult> =>
        fresh
          ? { ok: false, error: { code: "SHEET_UNREACHABLE", message: "down" } }
          : sheetWith(word("flonk")),
    );

    const result = await keepVocabularyTexts(["flonk", "zorvel"], loadSheet);

    expect(result).toEqual({ ok: true, texts: ["flonk"] });
  });

  it("passes the sheet's own error on when even the cached sheet is out of reach", async () => {
    const loadSheet = vi.fn(
      async (): Promise<SheetFetchResult> => ({
        ok: false,
        error: { code: "SHEET_NOT_PUBLISHED", message: "publish it" },
      }),
    );

    const result = await keepVocabularyTexts(["flonk"], loadSheet);

    expect(result).toEqual({
      ok: false,
      error: { code: "SHEET_NOT_PUBLISHED", message: "publish it" },
    });
  });
});

describe("TranslationRequest", () => {
  it("accepts a batch within Google's limits", () => {
    const texts = Array.from({ length: MAX_TEXTS_PER_REQUEST }, (_, index) => `w${index}`);

    expect(TranslationRequest.safeParse({ texts }).success).toBe(true);
  });

  it("refuses an empty batch, a batch too long, an oversized text, and too many characters", () => {
    const tooMany = Array.from({ length: MAX_TEXTS_PER_REQUEST + 1 }, () => "w");
    const oversized = ["x".repeat(MAX_TEXT_LENGTH + 1)];
    const tooLongInAll = Array.from(
      { length: Math.ceil(MAX_CHARACTERS_PER_REQUEST / MAX_TEXT_LENGTH) + 1 },
      () => "x".repeat(MAX_TEXT_LENGTH),
    );

    expect(TranslationRequest.safeParse({ texts: [] }).success).toBe(false);
    expect(TranslationRequest.safeParse({ texts: tooMany }).success).toBe(false);
    expect(TranslationRequest.safeParse({ texts: oversized }).success).toBe(false);
    expect(TranslationRequest.safeParse({ texts: tooLongInAll }).success).toBe(false);
    expect(TranslationRequest.safeParse({ texts: [""] }).success).toBe(false);
    expect(TranslationRequest.safeParse({}).success).toBe(false);
  });
});

describe("translateEach", () => {
  const texts = ["flonk", "wibbet", "zorvel", "quobble", "snerk"];

  it("answers each text in the order given, a group at a time", async () => {
    const inFlight: number[] = [];
    let running = 0;
    const result = await translateEach({
      texts,
      translateOne: async (text) => {
        running += 1;
        inFlight.push(running);
        await Promise.resolve();
        running -= 1;
        return `ru: ${text}`;
      },
      groupSize: 2,
      deadline: Number.POSITIVE_INFINITY,
    });

    expect(result).toEqual({
      translations: texts.map((text) => ({ text, translation: `ru: ${text}` })),
      failures: [],
    });
    expect(Math.max(...inFlight)).toBe(2);
  });

  it("leaves out a text that failed beside others and carries on", async () => {
    const asked: string[] = [];
    const result = await translateEach({
      texts,
      translateOne: async (text) => {
        asked.push(text);
        if (text === "wibbet") {
          throw new Error("one bad answer");
        }
        return `ru: ${text}`;
      },
      groupSize: 2,
      deadline: Number.POSITIVE_INFINITY,
    });

    expect(asked).toEqual(texts);
    expect(result.translations.map((entry) => entry.text)).toEqual([
      "flonk",
      "zorvel",
      "quobble",
      "snerk",
    ]);
    expect(result.failures).toEqual([new Error("one bad answer")]);
  });

  it("stops after a group in which every text failed", async () => {
    const asked: string[] = [];
    const result = await translateEach({
      texts,
      translateOne: async (text) => {
        asked.push(text);
        if (text !== "flonk") {
          throw new Error("quota spent");
        }
        return `ru: ${text}`;
      },
      groupSize: 2,
      deadline: Number.POSITIVE_INFINITY,
    });

    expect(asked).toEqual(["flonk", "wibbet", "zorvel", "quobble"]);
    expect(result.translations).toEqual([{ text: "flonk", translation: "ru: flonk" }]);
    expect(result.failures).toHaveLength(3);
  });

  it("starts no group past the deadline, but always the first", async () => {
    let clock = 0;
    const asked: string[] = [];
    const result = await translateEach({
      texts,
      translateOne: async (text) => {
        asked.push(text);
        clock += 600;
        return `ru: ${text}`;
      },
      groupSize: 2,
      deadline: 1_000,
      now: () => clock,
    });

    // The first group runs whatever the clock says; by its end the deadline has passed.
    expect(asked).toEqual(["flonk", "wibbet"]);
    expect(result.translations).toHaveLength(2);
    expect(result.failures).toEqual([]);
  });
});
