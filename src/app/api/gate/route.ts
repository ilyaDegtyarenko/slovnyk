import { NextResponse } from "next/server";
import { z } from "zod";
import {
  GATE_COOKIE_NAME,
  constantTimeEqual,
  gateCookieAttributes,
  gateCookieValue,
} from "@/lib/gate";

const GateForm = z.object({ key: z.string().min(1) });

// Relative rather than absolute: `request.url` carries the server's own idea of its
// hostname (`localhost` under `next start`), and an absolute redirect built from it can
// hop hosts and strand the just-set cookie on the one the browser actually used.
function seeOther(location: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { location } });
}

export async function POST(request: Request): Promise<NextResponse> {
  const appKey = process.env.APP_KEY;
  if (appKey === undefined || appKey === "") {
    return seeOther("/");
  }

  // Anything that is not the plain HTML form — wrong content type, a file where the
  // key belongs — is the same wrong answer as a wrong key.
  let formEntries: Record<string, FormDataEntryValue>;
  try {
    formEntries = Object.fromEntries((await request.formData()).entries());
  } catch {
    return seeOther("/gate?error=1");
  }
  const form = GateForm.safeParse(formEntries);

  // Digests on both sides: hashing first keeps the comparison's timing from saying how
  // many characters of the key were right.
  const expected = await gateCookieValue(appKey);
  const submitted = form.success ? await gateCookieValue(form.data.key) : "";
  if (!constantTimeEqual(submitted, expected)) {
    return seeOther("/gate?error=1");
  }

  const response = seeOther("/");
  response.cookies.set(GATE_COOKIE_NAME, expected, gateCookieAttributes());
  return response;
}
