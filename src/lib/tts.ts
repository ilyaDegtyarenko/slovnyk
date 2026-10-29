import { z } from "zod";
import { googleErrorDetail } from "@/lib/google-error";
import type { SheetFetchResult, SheetError } from "@/lib/sheet";

// Server side of pronunciation: Google Cloud Text-to-Speech turns a term into an MP3, and
// the route keeps each one per voice. The key stays on the server, and only terms that are
// actually in the sheet are ever sent — so the bill is bounded by the vocabulary itself,
// not by how often, or by whom, a word is asked for.

const SYNTHESIZE_ENDPOINT = "https://texttospeech.googleapis.com/v1/text:synthesize";

// A hung upstream must not hold a serverless function open until the platform kills it.
const SYNTHESIZE_TIMEOUT_MS = 15_000;

export type PronunciationErrorCode =
  | "PRONUNCIATION_NOT_CONFIGURED"
  | "PRONUNCIATION_TERM_INVALID"
  | "PRONUNCIATION_TERM_UNKNOWN"
  | "PRONUNCIATION_FAILED";

export type PronunciationError = {
  code: PronunciationErrorCode | SheetError["code"];
  message: string;
};

export type SynthesisResult =
  | { ok: true; audio: Uint8Array<ArrayBuffer> }
  | { ok: false; error: PronunciationError };

export type TermLookup =
  | { ok: true }
  | { ok: false; error: PronunciationError };

const SynthesizeResponse = z.object({ audioContent: z.string().min(1) });

// Long enough for any phrase a card can hold, short enough that one request cannot carry
// a paragraph. Google's own ceiling is 5,000 bytes.
export const MAX_TERM_LENGTH = 200;

export const PronunciationQuery = z.object({
  term: z.string().trim().min(1).max(MAX_TERM_LENGTH),
});

export async function lookUpVocabularyTerm(
  term: string,
  loadSheet: (options: { fresh: boolean }) => Promise<SheetFetchResult>,
): Promise<TermLookup> {
  // The cached sheet answers almost every request; a term added since it was cached gets
  // one fresh look before it counts as foreign.
  for (const fresh of [false, true]) {
    const sheet = await loadSheet({ fresh });
    if (!sheet.ok) {
      return { ok: false, error: sheet.error };
    }
    if (sheet.sheet.words.some((word) => word.term === term)) {
      return { ok: true };
    }
  }
  return {
    ok: false,
    error: {
      code: "PRONUNCIATION_TERM_UNKNOWN",
      message: "Only terms from the word list are pronounced.",
    },
  };
}

export async function synthesizeSpeech(input: {
  term: string;
  apiKey: string;
  voice: { languageCode: string; name: string };
  fetchImpl?: typeof fetch;
}): Promise<SynthesisResult> {
  const fetchImpl = input.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(SYNTHESIZE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // The header rather than `?key=`: a URL ends up in logs, a header does not.
        "X-Goog-Api-Key": input.apiKey,
      },
      body: JSON.stringify({
        input: { text: input.term },
        voice: input.voice,
        audioConfig: { audioEncoding: "MP3" },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(SYNTHESIZE_TIMEOUT_MS),
    });
  } catch {
    return failed("Text-to-Speech could not be reached.");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return failed(`Text-to-Speech answered HTTP ${response.status} with a body that is not JSON.`);
  }

  if (!response.ok) {
    const detail = googleErrorDetail(body);
    return failed(
      `Text-to-Speech answered HTTP ${response.status}${detail === "" ? "." : ` — ${detail}`}`,
    );
  }

  const synthesized = SynthesizeResponse.safeParse(body);
  if (!synthesized.success) {
    return failed("Text-to-Speech answered without audio.");
  }

  const audio = Buffer.from(synthesized.data.audioContent, "base64");
  if (audio.length === 0) {
    return failed("Text-to-Speech answered with empty audio.");
  }
  return { ok: true, audio: new Uint8Array(audio) };
}

function failed(message: string): SynthesisResult {
  return { ok: false, error: { code: "PRONUNCIATION_FAILED", message } };
}
