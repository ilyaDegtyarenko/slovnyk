import { z } from "zod";
import { googleErrorDetail } from "@/lib/google-error";
import type { SheetError, SheetFetchResult, Word } from "@/lib/sheet";

// Server side of machine translation: Google Cloud Translation (Basic, v2) gives a second
// opinion beside the tutor's translation — for the term, and for the example sentence that
// shows which sense the tutor meant. As with pronunciation, the key stays on the server and
// only text that is actually in the sheet is ever sent, so the bill is bounded by the
// vocabulary itself. The limits and both message shapes below are shared with the device.

const TRANSLATE_ENDPOINT = "https://translation.googleapis.com/language/translate/v2";

// Named rather than detected: a lone word like "admit" is too short for detection to be
// trusted, and the sheet's terms and examples are English by contract.
export const SOURCE_LANGUAGE = "en";
// The language the tutor translates into.
export const TARGET_LANGUAGE = "ru";

// A hung upstream must not hold a serverless function open until the platform kills it.
const TRANSLATE_TIMEOUT_MS = 15_000;

// Google's ceiling on the texts one request may carry.
export const MAX_TEXTS_PER_REQUEST = 128;
// Google's recommended ceiling per request; its hard limit is 100 KB.
export const MAX_CHARACTERS_PER_REQUEST = 5_000;
// Room for any example sentence a card can hold, short of a paragraph.
export const MAX_TEXT_LENGTH = 1_000;

export type TranslationErrorCode =
  | "TRANSLATION_NOT_CONFIGURED"
  | "TRANSLATION_REQUEST_INVALID"
  | "TRANSLATION_FAILED";

export type TranslationError = {
  code: TranslationErrorCode | SheetError["code"];
  message: string;
};

export type TranslatedText = { text: string; translation: string };

export type TranslateResult =
  | { ok: true; translations: TranslatedText[] }
  | { ok: false; error: TranslationError };

export type VocabularyTexts =
  | { ok: true; texts: string[] }
  | { ok: false; error: TranslationError };

// Texts are not trimmed here: they are matched against the sheet exactly, and the answer
// echoes each one back as the key the device stores it under.
export const TranslationRequest = z
  .object({
    texts: z
      .array(z.string().min(1).max(MAX_TEXT_LENGTH))
      .min(1)
      .max(MAX_TEXTS_PER_REQUEST),
  })
  .refine(
    (request) => characterCount(request.texts) <= MAX_CHARACTERS_PER_REQUEST,
    { message: `At most ${MAX_CHARACTERS_PER_REQUEST} characters per request.` },
  );

export const TranslationResponse = z.object({
  translations: z.array(z.object({ text: z.string(), translation: z.string() })),
});

export type TranslationResponse = z.infer<typeof TranslationResponse>;

const GoogleTranslateResponse = z.object({
  data: z.object({
    translations: z.array(z.object({ translatedText: z.string() })),
  }),
});

export function characterCount(texts: readonly string[]): number {
  return texts.reduce((total, text) => total + text.length, 0);
}

// Returns the requested texts the sheet holds as a term or an example, each once, in the
// order asked. A text the sheet does not hold is left out rather than refused: one word the
// tutor deleted a minute ago must not cost the device the rest of its batch.
export async function keepVocabularyTexts(
  texts: readonly string[],
  loadSheet: (options: { fresh: boolean }) => Promise<SheetFetchResult>,
): Promise<VocabularyTexts> {
  const cached = await loadSheet({ fresh: false });
  if (!cached.ok) {
    return { ok: false, error: cached.error };
  }

  const known = vocabularyTextsOf(cached.sheet.words);
  // The cached sheet answers almost every request; text added since it was cached gets one
  // fresh look before it counts as foreign. The look adds to the cached answer rather than
  // replacing it: Google's publish lag can serve a copy older than the cached one, and
  // either way every text kept was in the sheet at some point.
  if (!texts.every((text) => known.has(text))) {
    const fresh = await loadSheet({ fresh: true });
    if (fresh.ok) {
      for (const text of vocabularyTextsOf(fresh.sheet.words)) {
        known.add(text);
      }
    }
  }

  return { ok: true, texts: [...new Set(texts)].filter((text) => known.has(text)) };
}

function vocabularyTextsOf(words: readonly Word[]): Set<string> {
  return new Set(
    words.flatMap((word) => (word.example === "" ? [word.term] : [word.term, word.example])),
  );
}

export async function translateTexts(input: {
  texts: readonly string[];
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<TranslateResult> {
  const fetchImpl = input.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(TRANSLATE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // The header rather than `?key=`: a URL ends up in logs, a header does not.
        "X-Goog-Api-Key": input.apiKey,
      },
      body: JSON.stringify({
        q: input.texts,
        source: SOURCE_LANGUAGE,
        target: TARGET_LANGUAGE,
        // Google's default is HTML, which hands an apostrophe back as `&#39;`.
        format: "text",
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS),
    });
  } catch {
    return failed("Cloud Translation could not be reached.");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return failed(
      `Cloud Translation answered HTTP ${response.status} with a body that is not JSON.`,
    );
  }

  if (!response.ok) {
    const detail = googleErrorDetail(body);
    return failed(
      `Cloud Translation answered HTTP ${response.status}${detail === "" ? "." : ` — ${detail}`}`,
    );
  }

  const translated = GoogleTranslateResponse.safeParse(body);
  if (!translated.success) {
    return failed("Cloud Translation answered without translations.");
  }

  // Answers are matched to texts by position, so a list of any other length would pin a
  // translation on the wrong text.
  const answers = translated.data.data.translations;
  if (answers.length !== input.texts.length) {
    return failed(
      `Cloud Translation answered ${answers.length} translations for ${input.texts.length} texts.`,
    );
  }

  return {
    ok: true,
    translations: input.texts.map((text, index) => ({
      text,
      translation: answers[index].translatedText,
    })),
  };
}

export type TranslateEachOutcome = {
  translations: TranslatedText[];
  // One reason per text left out, for the logs.
  failures: unknown[];
};

// Translates each text on its own, a group at a time, answers in the order given. A group in
// which every text failed ends the run — a wrong key or a spent quota would fail the rest the
// same way — while a text that failed beside others that came through is only left out. No
// group starts past the deadline, so the device hears back before it gives up; whatever is
// left out it asks for again on its next pass.
export async function translateEach(input: {
  texts: readonly string[];
  translateOne: (text: string) => Promise<string>;
  groupSize: number;
  deadline: number;
  now?: () => number;
}): Promise<TranslateEachOutcome> {
  const now = input.now ?? Date.now;
  const translations: TranslatedText[] = [];
  const failures: unknown[] = [];
  for (let start = 0; start < input.texts.length; start += input.groupSize) {
    if (start > 0 && now() >= input.deadline) {
      break;
    }
    const group = input.texts.slice(start, start + input.groupSize);
    const settled = await Promise.allSettled(group.map((text) => input.translateOne(text)));
    settled.forEach((outcome, index) => {
      if (outcome.status === "fulfilled") {
        translations.push({ text: group[index], translation: outcome.value });
      } else {
        failures.push(outcome.reason);
      }
    });
    if (settled.every((outcome) => outcome.status === "rejected")) {
      break;
    }
  }
  return { translations, failures };
}

function failed(message: string): TranslateResult {
  return { ok: false, error: { code: "TRANSLATION_FAILED", message } };
}
