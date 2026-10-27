import { unstable_cache } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { PRONUNCIATION_VOICE } from "@/lib/pronunciation";
import { fetchSheet } from "@/lib/sheet";
import {
  lookUpVocabularyTerm,
  PronunciationQuery,
  synthesizeSpeech,
  type PronunciationError,
} from "@/lib/tts";

const statusByErrorCode: Record<PronunciationError["code"], number> = {
  // 503 tells the device to stop asking for the rest of the list and use its own voice.
  PRONUNCIATION_NOT_CONFIGURED: 503,
  PRONUNCIATION_TERM_INVALID: 400,
  PRONUNCIATION_TERM_UNKNOWN: 404,
  PRONUNCIATION_FAILED: 502,
  SHEET_CSV_URL_MISSING: 500,
  SHEET_CSV_URL_INVALID: 500,
  SHEET_NOT_PUBLISHED: 502,
  SHEET_UNREACHABLE: 502,
};

// Thrown rather than returned from inside the cache, which keeps whatever its function
// resolves to: a failure remembered there would keep the word silent for good.
class SynthesisFailure extends Error {}

function errorResponse(error: PronunciationError): NextResponse<{ error: PronunciationError }> {
  return NextResponse.json({ error }, { status: statusByErrorCode[error.code] });
}

export async function GET(request: NextRequest): Promise<Response> {
  const apiKey = process.env.GOOGLE_TTS_API_KEY?.trim();
  if (!apiKey) {
    return errorResponse({
      code: "PRONUNCIATION_NOT_CONFIGURED",
      message:
        "GOOGLE_TTS_API_KEY is not set, so terms are read by the device's own voice.",
    });
  }

  const query = PronunciationQuery.safeParse({
    term: request.nextUrl.searchParams.get("term") ?? "",
  });
  if (!query.success) {
    return errorResponse({
      code: "PRONUNCIATION_TERM_INVALID",
      message: "Pass the term to pronounce as ?term=.",
    });
  }
  const term = query.data.term;

  const lookup = await lookUpVocabularyTerm(term, fetchSheet);
  if (!lookup.ok) {
    return errorResponse(lookup.error);
  }

  // A synthesized term is kept in Next's data cache, keyed by voice and term. The device's
  // own copy only spares Google the requests of a device that can store files; this one
  // also absorbs a device that cannot, a second device, and anyone replaying requests with
  // the access key. It is not forever — the platform may evict an entry, and Next keys it
  // by this callback's compiled source too, so a deploy can start afresh — but each miss
  // costs one term, never a loop of them.
  let audioBase64: string;
  try {
    audioBase64 = await unstable_cache(
      async () => {
        const synthesized = await synthesizeSpeech({
          term,
          apiKey,
          voice: PRONUNCIATION_VOICE,
        });
        if (!synthesized.ok) {
          throw new SynthesisFailure(synthesized.error.message);
        }
        // The data cache stores JSON, so the bytes travel through it as text.
        return Buffer.from(synthesized.audio).toString("base64");
      },
      ["pronunciation", PRONUNCIATION_VOICE.name, term],
    )();
  } catch (error) {
    if (!(error instanceof SynthesisFailure)) {
      throw error;
    }
    // Google's wording names the missed setup step but also the Cloud project; it belongs
    // in the deployment's logs, not in the answer to the device.
    console.error(`Pronunciation failed: ${error.message}`);
    return errorResponse({
      code: "PRONUNCIATION_FAILED",
      message: "Text-to-Speech produced no recording; the deployment's logs say why.",
    });
  }

  return new Response(Buffer.from(audioBase64, "base64"), {
    headers: {
      "Content-Type": "audio/mpeg",
      // The device keeps its own copy under a key that includes the voice; an HTTP cache
      // keyed by the term alone would replay the old voice after a change.
      "Cache-Control": "no-store",
    },
  });
}
