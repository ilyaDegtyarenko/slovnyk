import { randomUUID } from "node:crypto";
import withSerwistInit from "@serwist/next";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Serwist's wrapper below adds a `webpack` key even while disabled, and `next dev` under
  // Turbopack treats a webpack config without a turbopack one as a fatal mistake. The empty
  // object says the divergence is deliberate: dev runs Turbopack, `build --webpack` bundles
  // the service worker.
  turbopack: {},
  // `next dev` otherwise appends its own block to AGENTS.md on every start; that file is a
  // hand-written working agreement, not a scratchpad.
  agentRules: false,
};

// Documents are precached by URL rather than by content, so their revision has to change
// with every build. A commit hash would not: redeploying the same commit with different
// environment variables produces new asset names, and an installed app would keep serving
// HTML that asks for chunks nobody has any more.
const buildRevision = randomUUID();

const withSerwist = withSerwistInit({
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
  // The screens that render from IndexedDB alone, so each of them opens offline instead of
  // falling back to the study screen. `/health` is deliberately not here: it reports what
  // the sheet answered just now, and the service worker keeps it out of the cache too.
  additionalPrecacheEntries: ["/", "/list", "/settings"].map((url) => ({
    url,
    revision: buildRevision,
  })),
  // Serwist reloads the page when the connection comes back unless it is told not to. That
  // would throw away a card revealed in airplane mode the moment the plane lands.
  reloadOnOnline: false,
  // Registration lives in <RegisterServiceWorker /> instead of Serwist's injected script:
  // a worker installed on the key-gate page would precache the gate's HTML as the app
  // shell, and the installed app would then open on the gate forever.
  register: false,
  // Serwist bundles the service worker with a webpack plugin — which is why `build` passes
  // `--webpack` — and a development server has no service worker to bundle.
  disable: process.env.NODE_ENV !== "production",
});

export default withSerwist(nextConfig);
