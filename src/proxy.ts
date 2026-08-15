import { NextResponse, type NextRequest } from "next/server";
import {
  decideGate,
  GATE_COOKIE_NAME,
  gateCookieAttributes,
  gateCookieValue,
} from "@/lib/gate";

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const appKey = process.env.APP_KEY;
  const decision = await decideGate({
    appKey,
    cookieValue: request.cookies.get(GATE_COOKIE_NAME)?.value,
    pathname: request.nextUrl.pathname,
  });

  if (decision === "allow" || decision === "renew") {
    const response = NextResponse.next();
    if (decision === "renew" && appKey !== undefined && appKey !== "") {
      response.cookies.set(
        GATE_COOKIE_NAME,
        await gateCookieValue(appKey),
        gateCookieAttributes(),
      );
    }
    return response;
  }
  if (decision === "unauthorized") {
    // The same `{ error: { code, message } }` shape the words API itself speaks, so the
    // client names the actual problem instead of blaming the endpoint.
    return NextResponse.json(
      {
        error: {
          code: "GATE_LOCKED",
          message:
            "This instance is locked and this device's access key is missing or stale. Open /gate and enter the key again.",
        },
      },
      { status: 401 },
    );
  }
  return NextResponse.redirect(new URL("/gate", request.nextUrl));
}

// Static assets stay outside the gate: the browser fetches the manifest and its icons
// without cookies during "Add to Home Screen", so gating them breaks installation — and
// none of them contain a word.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|icons/|manifest\\.webmanifest|sw\\.js).*)",
  ],
};
