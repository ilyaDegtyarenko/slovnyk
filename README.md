# slovnyk

A personal spaced-repetition PWA for learning vocabulary.

The word list lives in a Google Sheet that a tutor can edit directly — no accounts,
no admin UI, no backend. The app reads the published sheet, schedules reviews with
FSRS, and stores all review progress locally in IndexedDB.

## Why this design

- **The tutor edits a spreadsheet.** Zero onboarding for them, zero auth code for us.
- **Progress is local and keyed by a stable `id`.** Editing a typo in the sheet never
  resets scheduling history.
- **No server, no database.** Static hosting on Vercel's free tier, forever.

## Stack

- Next.js 16 (App Router, TypeScript)
- Tailwind CSS
- `ts-fsrs` — FSRS scheduler (same algorithm family as modern Anki)
- `dexie` — IndexedDB wrapper
- `papaparse` + `zod` — sheet parsing and validation
- Serwist — service worker / installable PWA

## Getting started

```bash
pnpm install
pnpm exec playwright install chromium   # once per machine, for `pnpm e2e`
cp .env.example .env.local              # fill in SHEET_CSV_URL
pnpm dev
```

A production build writes the service worker to `public/sw.js`, and `next dev` then serves
that file as a static asset — so a browser that has already installed the service worker
from `pnpm start` on the same port keeps updating from it and can answer with precached
production HTML instead of the dev server. If a dev page looks stale, unregister the service
worker in DevTools → Application → Service workers.

## Environment

| Variable                  | Required | Description                                                     |
| ------------------------- | -------- | --------------------------------------------------------------- |
| `SHEET_CSV_URL`           | yes      | Full published-to-web CSV URL (`/d/e/2PACX-.../pub?...&output=csv`) |
| `NEXT_PUBLIC_SHEET_EDIT_URL` | no    | Normal sheet URL, used for the "edit in the sheet" link in the UI |
| `NEXT_PUBLIC_NEW_PER_DAY` | no       | New-card intake per day, defaults to `10`                        |
| `GOOGLE_TTS_API_KEY`      | no       | Google Cloud API key restricted to the Cloud Text-to-Speech API (SPEC §5.1). When set, each term is recorded once in a natural neural voice and kept on the device, so the speaker plays even in iOS Silent Mode and offline. Unset = the speaker uses the device's own speech synthesis, which iOS mutes in Silent Mode. |
| `GOOGLE_TRANSLATE_API_KEY` | no     | Google Cloud API key restricted to the Cloud Translation API (SPEC §5.1). When set, the back of each card shows Google's translation of the term and of the example under the tutor's, as a second opinion, kept on the device. Unset = the card shows the tutor's translation alone. |
| `APP_KEY`                 | no       | Shared access key for a deployed instance (SPEC §5.6). When set, every page and the words API ask for it once per device at `/gate`. Use a long random phrase — its entropy is the only thing limiting guesses. Rotating it logs every device out at once. Unset = the app is open, which is how dev and the test suites run. |

`SHEET_CSV_URL` is taken verbatim from `File → Publish to web → sheet: Words → CSV`.
It is not derivable from the spreadsheet id — see `docs/sheet-setup.md`.

`GOOGLE_TTS_API_KEY` setup, once: create a Google Cloud project with billing enabled,
enable the Cloud Text-to-Speech API, create an API key under APIs & Services →
Credentials and restrict it to that API (no application restriction — Vercel has no fixed
IP). The route only ever sends terms that are in the sheet, and keeps each recording in
Next's data cache once synthesized, so usage stays at roughly the vocabulary's character
count per voice however many devices ask (plus an occasional re-recording after a cache
eviction or a deploy) — far inside the monthly free tier. Google
budgets only alert, they do not cap spending; a $1 budget alert is a cheap early warning.

`GOOGLE_TRANSLATE_API_KEY` setup, once: in the same Google Cloud project, enable the
Cloud Translation API and create a second API key restricted to it. The route only ever
sends terms and examples that are in the sheet, and keeps each translation in Next's data
cache, so usage stays at roughly the vocabulary's character count however many devices
ask (plus a re-translation after a cache eviction or a deploy) — far inside the 500,000
characters a month the free tier covers. Unlike a budget, a quota does cap usage: set
"v2 and v3 general model characters per day" (Google's docs call it "Characters sent to
general model per project per day (v2 and v3)") for the Cloud Translation API under
IAM & Admin → Quotas & System Limits — filter by `general model` — to a few times the
vocabulary's size — 50,000 covers a list of several hundred words with examples — and
allow up to a day for it to take effect. Past it Google answers "Daily Limit Exceeded"
until midnight Pacific Time; cards already holding Google's line keep it, and the rest
show the tutor's translation alone until the next day's pass.

## Google Sheet contract

The sheet must have a worksheet named `Words` with a header row:

```
id | term | translation | example | tags | added
```

- `id` — stable, never reused, never edited. Progress is keyed by this value.
- `term`, `translation` — required, non-empty.
- `example`, `tags`, `added` — optional. `tags` is comma-separated.

Rows that fail validation are skipped and reported on `/health`, never crash the app.

See `SPEC.md` for the full functional specification and `AGENTS.md` for engineering
conventions.

## License

MIT
