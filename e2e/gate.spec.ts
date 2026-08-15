import { expect, test } from "@playwright/test";

// The main suite talks to the open server via `baseURL`; this one talks to the second
// server in playwright.config.ts — the one started with APP_KEY set.
const GATE_ORIGIN = "http://127.0.0.1:3212";
const APP_KEY = "e2e-gate-key";

test("a visitor without the key is walked to the gate", async ({ page }) => {
  await page.goto(`${GATE_ORIGIN}/`);

  await expect(page).toHaveURL(`${GATE_ORIGIN}/gate`);
  await expect(page.getByLabel("Access key")).toBeVisible();
});

test("the words API answers 401, not a login page", async ({ request }) => {
  const response = await request.get(`${GATE_ORIGIN}/api/words`);
  expect(response.status()).toBe(401);
});

test("installation assets stay outside the gate", async ({ request }) => {
  // The browser fetches these without cookies during "Add to Home Screen"; a redirect
  // here is the difference between installable and silently uninstallable.
  for (const path of ["/sw.js", "/manifest.webmanifest", "/icons/icon-192.png"]) {
    const response = await request.get(`${GATE_ORIGIN}${path}`, {
      maxRedirects: 0,
    });
    expect(response.status(), path).toBe(200);
  }
});

test("no service worker registers behind the gate", async ({ page }) => {
  await page.goto(`${GATE_ORIGIN}/gate`);
  // Give a wrong registration every chance to happen before looking: a worker that
  // installs here would precache the gate page as the offline app shell.
  await page.waitForTimeout(500);
  const registrationScope = await page.evaluate(() =>
    navigator.serviceWorker
      .getRegistration()
      .then((found) => found?.scope ?? null),
  );
  expect(registrationScope).toBeNull();
});

test("a wrong key is refused and the door stays shut", async ({ page }) => {
  await page.goto(`${GATE_ORIGIN}/gate`);
  await page.getByLabel("Access key").fill("not-the-key");
  await page.getByRole("button", { name: "Unlock" }).click();

  // By text rather than by role: Next mounts its own always-present `role="alert"`
  // route announcer, which makes the bare role ambiguous.
  await expect(
    page.getByText("That key did not match. Check it and try again."),
  ).toBeVisible();
  await page.goto(`${GATE_ORIGIN}/list`);
  await expect(page).toHaveURL(`${GATE_ORIGIN}/gate`);
});

test("the right key opens every door once", async ({ page }) => {
  await page.goto(`${GATE_ORIGIN}/gate`);
  await page.getByLabel("Access key").fill(APP_KEY);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page).toHaveURL(`${GATE_ORIGIN}/`);

  // The cookie, not the visit, is what lets the device in — and it must hold a digest,
  // never the key itself. Unfiltered on purpose: the cookie is Secure, so filtering by
  // this suite's http origin would hide it even though Chromium sends it to 127.0.0.1.
  const cookies = await page.context().cookies();
  const gateCookie = cookies.find((cookie) => cookie.name === "slovnyk_gate");
  expect(gateCookie?.httpOnly).toBe(true);
  expect(gateCookie?.value).not.toContain(APP_KEY);

  await page.goto(`${GATE_ORIGIN}/list`);
  await expect(page).toHaveURL(`${GATE_ORIGIN}/list`);
  // Fetched from inside the page — the way the app itself calls the API — because
  // Playwright's own HTTP client refuses to send a Secure cookie over this suite's
  // http origin, while the browser rightly treats 127.0.0.1 as trustworthy.
  const wordsStatus = await page.evaluate(() =>
    fetch("/api/words").then((response) => response.status),
  );
  expect(wordsStatus).not.toBe(401);
});
