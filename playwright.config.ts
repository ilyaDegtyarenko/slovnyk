import { defineConfig, devices } from "@playwright/test";

// The service worker and the manifest only exist in a production build, so the smoke test
// runs against `next start`, never against `next dev`. `pnpm e2e` builds first; a bare
// `playwright test` reruns against whatever the last `pnpm build` produced.
const PORT = 3211;
const BASE_URL = `http://127.0.0.1:${PORT}`;
// A second server for e2e/gate.spec.ts: APP_KEY is read per request, but only from the
// process environment, so a locked instance has to be its own process.
const GATE_PORT = 3212;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  reporter: "list",
  use: {
    baseURL: BASE_URL,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // The app is used as an installed phone PWA first, and coarse-pointer styling has
    // already hidden a bug from the desktop project (a keyboard hint whose surrounding
    // spaces vanished with it). Pixel 7 keeps the suite on the installed Chromium.
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    {
      // `pnpm exec` resolves `next` strictly from node_modules/.bin — unlike npx, it can
      // never fall back to fetching an unpinned `next` from the registry.
      command: `pnpm exec next start --port ${PORT}`,
      url: BASE_URL,
      // A server left running from an earlier session would be serving an older build.
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        // The suite must never touch the owner's real vocabulary: the browser answers the
        // word list from a fixture, and this makes sure a request that gets past the fixture
        // cannot reach Google either.
        SHEET_CSV_URL: "http://127.0.0.1:9/slovnyk-e2e-uses-a-fixture",
      },
    },
    {
      command: `pnpm exec next start --port ${GATE_PORT}`,
      // The bare origin would answer with the redirect to the gate; the gate itself is
      // what proves this server is up and locked.
      url: `http://127.0.0.1:${GATE_PORT}/gate`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        SHEET_CSV_URL: "http://127.0.0.1:9/slovnyk-e2e-uses-a-fixture",
        // Invented, like every fixture value here; e2e/gate.spec.ts unlocks with it.
        APP_KEY: "e2e-gate-key",
      },
    },
  ],
});
