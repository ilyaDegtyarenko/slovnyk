import { unstable_cache } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { fetchSheet } from "@/lib/sheet";
import {
  keepVocabularyTexts,
  MAX_CHARACTERS_PER_REQUEST,
  MAX_TEXTS_PER_REQUEST,
  SOURCE_LANGUAGE,
  TARGET_LANGUAGE,
  translateEach,
  TranslationRequest,
  translateTexts,
  type TranslationError,
  type TranslationResponse,
} from "@/lib/translate";

const statusByErrorCode: Record<TranslationError["code"], number> = {
  // 503 tells the device to stop asking and show the tutor's translations alone.
  TRANSLATION_NOT_CONFIGURED: 503,
  TRANSLATION_REQUEST_INVALID: 400,
  TRANSLATION_FAILED: 502,
  SHEET_CSV_URL_MISSING: 500,
  SHEET_CSV_URL_INVALID: 500,
  SHEET_NOT_PUBLISHED: 502,
  SHEET_UNREACHABLE: 502,
};

// Texts are looked up, and the ones missing from the cache sent to Google, this many at a
// time: a whole batch at once would be a burst of a hundred requests, one at a time a wait
// of seconds.
const PARALLEL_TRANSLATIONS = 16;

// No group starts this long after the request came in. The last one is bounded by Google's
// own timeout, and the sum stays inside the time the device waits for an answer.
const TRANSLATION_BUDGET_MS = 10_000;

function errorResponse(error: TranslationError): NextResponse<{ error: TranslationError }> {
  return NextResponse.json({ error }, { status: statusByErrorCode[error.code] });
}

// Each text is translated, and kept in Next's data cache, on its own, keyed by language pair
// and text — as pronunciation keeps each term. The device's own copy spares Google the
// requests of one device; this one also absorbs a second device, a reinstall, and anyone
// replaying requests with the access key, however they cut the texts into batches. Google
// bills by the character, so one text per request costs no more than a batch. The cache is
// not forever: the platform may evict an entry, and Next keys it by this callback's
// compiled source too, so a deploy can start afresh.
function cachedTranslation(text: string, apiKey: string): Promise<string> {
  return unstable_cache(
    async () => {
      const translated = await translateTexts({ texts: [text], apiKey });
      // Thrown rather than returned: the cache keeps whatever this function resolves to, and
      // a failure remembered there would leave the text untranslated for good.
      if (!translated.ok) {
        throw new Error(translated.error.message);
      }
      return translated.translations[0].translation;
    },
    ["translation", SOURCE_LANGUAGE, TARGET_LANGUAGE, text],
  )();
}

export async function POST(
  request: NextRequest,
): Promise<NextResponse<TranslationResponse | { error: TranslationError }>> {
  const deadline = Date.now() + TRANSLATION_BUDGET_MS;
  const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY?.trim();
  if (!apiKey) {
    return errorResponse({
      code: "TRANSLATION_NOT_CONFIGURED",
      message:
        "GOOGLE_TRANSLATE_API_KEY is not set, so cards show the tutor's translation alone.",
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = undefined;
  }
  const query = TranslationRequest.safeParse(body);
  if (!query.success) {
    return errorResponse({
      code: "TRANSLATION_REQUEST_INVALID",
      message: `Send {"texts": [...]} with up to ${MAX_TEXTS_PER_REQUEST} terms or examples from the word list, ${MAX_CHARACTERS_PER_REQUEST} characters in all.`,
    });
  }

  const vocabulary = await keepVocabularyTexts(query.data.texts, fetchSheet);
  if (!vocabulary.ok) {
    return errorResponse(vocabulary.error);
  }
  if (vocabulary.texts.length === 0) {
    return NextResponse.json({ translations: [] }, { headers: { "Cache-Control": "no-store" } });
  }

  const { translations, failures } = await translateEach({
    texts: vocabulary.texts,
    translateOne: (text) => cachedTranslation(text, apiKey),
    groupSize: PARALLEL_TRANSLATIONS,
    deadline,
  });

  if (failures.length > 0) {
    // Google's wording names the missed setup step but also the Cloud project; it belongs
    // in the deployment's logs, not in the answer to the device. Sixteen texts refused for
    // one wrong key say so once.
    const reasons = new Set(
      failures.map((reason) => (reason instanceof Error ? reason.message : String(reason))),
    );
    console.error(`Translation failed: ${[...reasons].join(" | ")}`);
  }
  // Returned rather than thrown even when nothing came through: Next hands the data cache
  // the translations this request did get only once the handler returns.
  if (translations.length === 0 && failures.length > 0) {
    return errorResponse({
      code: "TRANSLATION_FAILED",
      message: "Cloud Translation produced no translation; the deployment's logs say why.",
    });
  }

  return NextResponse.json({ translations }, { headers: { "Cache-Control": "no-store" } });
}
