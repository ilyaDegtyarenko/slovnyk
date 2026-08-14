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
npm install
cp .env.example .env.local   # fill in SHEET_ID
npm run dev
```

## Environment

| Variable                 | Required | Description                                          |
| ------------------------ | -------- | ---------------------------------------------------- |
| `SHEET_ID`               | yes      | Google Sheet ID (from the sheet URL)                 |
| `SHEET_TAB`              | no       | Worksheet name, defaults to `Words`                  |
| `NEXT_PUBLIC_NEW_PER_DAY`| no       | New-card intake per day, defaults to `10`            |

## Google Sheet contract

The sheet must have a worksheet (default `Words`) with a header row:

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
