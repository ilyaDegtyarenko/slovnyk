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
| `APP_KEY`                 | no       | Shared access key for a deployed instance (SPEC §5.6). When set, every page and the words API ask for it once per device at `/gate`. Use a long random phrase — its entropy is the only thing limiting guesses. Rotating it logs every device out at once. Unset = the app is open, which is how dev and the test suites run. |

`SHEET_CSV_URL` is taken verbatim from `File → Publish to web → sheet: Words → CSV`.
It is not derivable from the spreadsheet id — see `docs/sheet-setup.md`.

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
