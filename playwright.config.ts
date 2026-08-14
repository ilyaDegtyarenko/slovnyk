import { defineConfig, devices } from "@playwright/test";

// The service worker and the manifest only exist in a production build, so the smoke test
// runs against `next start`, never against `next dev`. `pnpm e2e` builds first; a bare
// `playwright test` reruns against whatever the last `pnpm build` produced.
const PORT = 3211;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  reporter: "list",
  use: {
    baseURL: BASE_URL,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
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
});
