import { expect, test, type Locator, type Page } from "@playwright/test";

// Invented words with the shape `/api/words` answers (see `src/lib/sheet.ts`). Nothing here
// comes from a real sheet, and nothing in this suite reaches the network.
const WORDS_FIXTURE = {
  words: [
    {
      id: "e2e-blimflar",
      term: "blimflar",
      translation: "to hum while working",
      example: "He blimflars over the washing-up.",
      tags: ["verb"],
      added: "2024-01-01",
    },
    {
      id: "e2e-quennet",
      term: "quennet",
      translation: "a small high window",
      example: "Light came in through the quennet.",
      tags: ["noun"],
      added: "2024-01-02",
    },
    {
      id: "e2e-sproom",
      term: "sproom",
      translation: "damp morning air",
      example: "The sproom smelled of rain.",
      tags: ["noun"],
      added: "2024-01-03",
    },
  ],
  invalid: [],
  syncedAt: new Date().toISOString(),
};

const FIXTURE_TERMS = /blimflar|quennet|sproom/;

async function serveWordsFixture(page: Page): Promise<void> {
  await page.route("**/api/words*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(WORDS_FIXTURE),
    }),
  );
}

function answersTodayLabel(answers: number): string {
  return answers === 1 ? "1 answer today" : `${answers} answers today`;
}

function doneHeadingOf(page: Page): Locator {
  return page.getByRole("heading", { name: "Done for today" });
}

/** Reveals and rates Good until the queue is empty, and says how many answers that took. */
async function answerEveryQueuedCard(page: Page): Promise<number> {
  const showAnswer = page.getByRole("button", { name: "Show answer" });
  const good = page.getByRole("button", { name: /^good/i });
  const doneHeading = doneHeadingOf(page);

  await expect(showAnswer).toBeVisible();

  let answers = 0;
  while (!(await doneHeading.isVisible())) {
    // Space is pressed on the body rather than on whatever the last click left focused:
    // the shortcut is a window listener, and the study screen ignores Space while a button
    // has focus so that the browser can activate it instead.
    await page.locator("body").press("Space");
    await good.click();
    answers += 1;

    // Whichever comes next, the screen has settled before the loop looks again.
    await expect(showAnswer.or(doneHeading).first()).toBeVisible();
    expect(answers).toBeLessThanOrEqual(WORDS_FIXTURE.words.length);
  }

  expect(answers).toBeGreaterThan(0);
  return answers;
}

test.describe("study session", () => {
  // A request the service worker has taken over is invisible to `page.route`, so the
  // fixture is only dependable with service workers switched off. The service worker has
  // its own tests below.
  test.use({ serviceWorkers: "block" });

  test("progress survives a reload", async ({ page }) => {
    await serveWordsFixture(page);
    await page.goto("/");

    // Proves the session is built from the fixture rather than from anyone's real sheet.
    await expect(page.getByText(FIXTURE_TERMS).first()).toBeVisible();

    const answers = await answerEveryQueuedCard(page);
    await expect(page.getByText(answersTodayLabel(answers))).toBeVisible();

    await page.reload();

    // Both halves of the promise in one assertion pair: the queue does not offer the
    // answered cards again — every one of them is scheduled ahead now — and the review log
    // that counts today's answers is still there.
    await expect(doneHeadingOf(page)).toBeVisible();
    await expect(page.getByText(answersTodayLabel(answers))).toBeVisible();
  });

  test("the blocking sync error keeps the keyboard away from the queue", async ({
    page,
  }) => {
    await serveWordsFixture(page);
    await page.goto("/");
    await expect(page.getByText(FIXTURE_TERMS).first()).toBeVisible();

    // The same sheet answering nothing but broken rows: EMPTY_SHEET, the blocking screen.
    await page.unroute("**/api/words*");
    await page.route("**/api/words*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          words: [],
          invalid: [{ row: 2, issues: ["term: Too small"] }],
          syncedAt: new Date().toISOString(),
        }),
      }),
    );
    await page.reload();

    const acknowledge = page.getByRole("button", {
      name: "Study the cached words",
    });
    await expect(acknowledge).toBeVisible();

    // Behind the alert the queue is populated; these keys must not reach it.
    await page.locator("body").press("Space");
    await page.locator("body").press("3");

    const reviewCount = await page.evaluate(
      () =>
        new Promise<number>((resolve, reject) => {
          const open = indexedDB.open("slovnyk");
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const database = open.result;
            const count = database
              .transaction("reviews", "readonly")
              .objectStore("reviews")
              .count();
            count.onsuccess = () => {
              database.close();
              resolve(count.result);
            };
            count.onerror = () => reject(count.error);
          };
        }),
    );
    expect(reviewCount).toBe(0);

    // Acknowledging shows the first card face down: the Space above revealed nothing.
    await acknowledge.click();
    await expect(page.getByRole("button", { name: "Show answer" })).toBeVisible();
  });
});

test("a session finished in airplane mode survives a reload", async ({
  page,
  context,
}) => {
  await serveWordsFixture(page);
  await page.goto("/");

  const answers = await answerEveryQueuedCard(page);

  // The shell is in the cache once the service worker is active: it precaches during
  // install, and a worker only becomes active after its install has finished.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await page.reload();

  // No network, no server: the service worker serves the shell and IndexedDB serves the
  // session that was just studied.
  await expect(doneHeadingOf(page)).toBeVisible();
  await expect(page.getByText(answersTodayLabel(answers))).toBeVisible();
});

test("the app is installable and registers its service worker", async ({
  page,
}) => {
  await serveWordsFixture(page);
  await page.goto("/");

  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest.webmanifest",
  );

  const manifestResponse = await page.request.get("/manifest.webmanifest");
  expect(manifestResponse.ok()).toBe(true);
  const manifest: unknown = await manifestResponse.json();
  expect(manifest).toMatchObject({
    id: "/",
    name: "slovnyk",
    start_url: "/",
    display: "standalone",
    theme_color: "#101014",
  });

  // `ready` resolves once a service worker is active for this page, which is what makes the
  // app installable and what serves the shell when the phone is offline.
  const activeScriptUrl = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.active?.scriptURL ?? null;
  });
  expect(activeScriptUrl).toContain("/sw.js");
});
