// A deployed instance is reachable by anyone who has the URL. The gate is one shared
// passphrase for the owner's own devices (and the tutor, if invited) — deliberately not
// accounts or login, which SPEC §2 rules out. No APP_KEY configured means no gate, which
// is how development and both test suites run.

export const GATE_COOKIE_NAME = "slovnyk_gate";

// Asked once per device container and forgotten about: an installed PWA has no place to
// show a login prompt gracefully, so the cookie outlives any plausible pause in studying.
export const GATE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

// The door itself and the handler that unlocks it. Everything else waits for the cookie.
const OPEN_PATHS = new Set(["/gate", "/api/gate"]);

// "renew" is "allow, and this device earned it with its cookie": the proxy answers by
// re-issuing the cookie, so its year restarts on every visit and only a device that
// stays away a whole year is ever asked for the key again.
export type GateDecision = "allow" | "renew" | "challenge" | "unauthorized";

// The cookie holds a digest rather than the key, so the key itself never rests in a
// cookie jar — and rotating APP_KEY invalidates every device's cookie at once.
export async function gateCookieValue(appKey: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(appKey),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

// Bitwise accumulation instead of `===`: a comparison that bails at the first wrong
// character tells a patient attacker how much of the value was right.
export function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

// One place for the attributes: the unlock handler issues the cookie and the proxy
// re-issues it, and a drift between the two would log devices out on whichever
// attribute disagreed.
export function gateCookieAttributes(): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: GATE_COOKIE_MAX_AGE_SECONDS,
  };
}

export async function decideGate(request: {
  appKey: string | undefined;
  cookieValue: string | undefined;
  pathname: string;
}): Promise<GateDecision> {
  const { appKey, cookieValue, pathname } = request;
  if (appKey === undefined || appKey === "" || OPEN_PATHS.has(pathname)) {
    return "allow";
  }
  if (
    cookieValue !== undefined &&
    constantTimeEqual(cookieValue, await gateCookieValue(appKey))
  ) {
    return "renew";
  }
  // A background fetch cannot walk through a redirect to an HTML page; the API says 401
  // and the client surfaces it as a failed sync over a still-working cached list.
  return pathname.startsWith("/api/") ? "unauthorized" : "challenge";
}
