import { NextResponse, type NextRequest } from "next/server";
import { decideGate, GATE_COOKIE_NAME } from "@/lib/gate";

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const decision = await decideGate({
    appKey: process.env.APP_KEY,
    cookieValue: request.cookies.get(GATE_COOKIE_NAME)?.value,
    pathname: request.nextUrl.pathname,
  });

  if (decision === "allow") {
    return NextResponse.next();
  }
  if (decision === "unauthorized") {
    return NextResponse.json(
      { error: "This instance is locked. Open /gate to enter its access key." },
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
