/// <reference lib="webworker" />

import { defaultCache } from "@serwist/next/worker";
import {
  NetworkOnly,
  Serwist,
  type PrecacheEntry,
  type SerwistGlobalConfig,
} from "serwist";
import { isCacheableShellResponse } from "../lib/precache";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    // Replaced at build time with the list of assets to precache.
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

// Where a navigation lands when its own document is neither precached (see the entries in
// next.config.ts) nor in the runtime cache: the study screen needs nothing but IndexedDB,
// so it is a working app rather than an apology page.
const APP_SHELL_URL = "/";

// Paths that are worth nothing unless they are current. `defaultCache` ends in catch-alls
// that would otherwise keep a copy of both.
const ALWAYS_FRESH_PATHS = new Set(["/api/words", "/health"]);

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  // Any `cacheWillUpdate` here replaces Serwist's own status check, so the predicate
  // carries the >=400 refusal as well as the redirect one.
  precacheOptions: {
    plugins: [
      {
        cacheWillUpdate: async ({ response }) =>
          isCacheableShellResponse(response) ? response : null,
      },
    ],
  },
  // A stale service worker would keep serving the previous build's assets to an installed
  // app that has no visible reload button, so a new one takes over as soon as it is ready.
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  // Order decides: Serwist answers with the first rule that matches, so this one is listed
  // before the catch-alls that end `defaultCache`.
  runtimeCaching: [
    {
      // `/api/words` stays uncached because IndexedDB already holds the offline copy, and a
      // cached response would report a sync that never happened and hide the "offline, last
      // synced X" banner. `/health` stays uncached because it exists to say what the sheet
      // answered just now. Matching on the pathname covers the `?_rsc=` prefetches of the
      // same routes, which are separate URLs but the same answer.
      matcher: ({ sameOrigin, url }) =>
        sameOrigin && ALWAYS_FRESH_PATHS.has(url.pathname),
      handler: new NetworkOnly(),
    },
    ...defaultCache,
  ],
  fallbacks: {
    entries: [
      {
        url: APP_SHELL_URL,
        matcher: ({ request }) => request.destination === "document",
      },
    ],
  },
});

serwist.addEventListeners();
