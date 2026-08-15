# TASKS.md

Milestones in order. Each is one branch and one PR. Do not start the next before the
previous is merged and its acceptance criteria are met.

---

## M0 — Scaffold

- Next.js 16, TypeScript, Tailwind, ESLint, `src/` directory, `@/*` import alias.
- Vitest configured with a `test` script.
- `.env.example` with `SHEET_CSV_URL=`, `NEXT_PUBLIC_SHEET_EDIT_URL=`,
  `NEXT_PUBLIC_NEW_PER_DAY=10`.
- `.gitignore` covers `.env*.local`.
- Dependencies installed: `ts-fsrs`, `dexie`, `papaparse`, `zod`, `@types/papaparse`.

**Acceptance:** `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` all
pass on a clean clone after `pnpm install`.

---

## M1 — Sheet pipeline

- `src/lib/sheet.ts`: fetch, parse, validate, dedupe by `id`, return
  `{ words, invalid, syncedAt }`.
- `GET /api/words` route handler with `revalidate: 300` and `?fresh=1` bypass.
- Detects an HTML response (sheet not published) and returns a typed, actionable error.
- `/health` page rendering invalid rows and the last sync state.
- Tests: valid CSV, missing required column, empty required field, duplicate ids,
  malformed CSV, HTML response.

**Acceptance:** with a real published sheet, `/api/words` returns the parsed list; adding
a row in the sheet appears after `?fresh=1`; a deliberately broken row shows up on
`/health` and does not break the response.

---

## M2 — Storage and scheduling

- `src/lib/db.ts`: Dexie schema per `SPEC.md` §4.1.
- `src/lib/srs.ts`: `ts-fsrs` wrapper — `review(cardState, rating, now)`, `initial()`.
- `src/lib/queue.ts`: due cards first, then up to `NEW_PER_DAY` new ones, orphans excluded.
- `src/lib/sync.ts`: merge a fetched list into `words`, mark missing ids as orphaned,
  never touch `progress` or `reviews`.
- Orphan guard: a fetch whose `words` is empty while the cached list is not — an
  unterminated quote truncating the sheet, for example — must keep the previous list and
  surface a sync error instead of orphaning everything. Any non-empty fetch is a
  legitimate edit and orphans normally per `SPEC.md` §4.4.
- Tests: full state transitions per rating, queue ordering, new-card cap, orphan handling,
  a test proving that a truncated fetch orphans nothing, and — required — a test proving
  that changing a word's `term` preserves its progress.

**Acceptance:** the "sheet edit does not reset progress" test passes. No UI yet.

---

## M3 — Study UI

- `/` session screen: reveal, four ratings, keyboard shortcuts `Space` and `1`–`4`,
  remaining counts, undo (`U`) for the last answer only.
- Empty state with next-due information and a "study ahead" action.
- `/list` with search and tag filter, read-only, linking out to the sheet.
- `/settings`: new-per-day, manual refresh with last-sync timestamp, JSON export/import,
  orphan count.
- Offline banner when serving cached data.

**Acceptance:** a full session can be completed with the keyboard only and with one thumb
on a phone; a reload mid-session loses nothing; no layout shift on reveal.

---

## M4 — PWA and deploy

- Manifest, icons (192/512 + maskable), theme color, standalone display.
- Serwist service worker: app shell and last-synced data cached.
- Vercel deployment with `SHEET_CSV_URL` set in project environment variables.
- One Playwright smoke test: load → reveal → rate → reload → progress persisted.

**Acceptance:** installs to the iOS and Android home screen; a session completed in
airplane mode persists across a reload.

---

## M5 — Stats (optional, only after M4 is used for a week)

- `/stats`: reviews per day for 30 days, counts by state, current streak.
- One chart, three numbers, nothing more.

---

## Backlog — not scheduled

- Reverse mode (translation → term)
- Cross-device progress sync
- FSRS parameter optimisation from the review log
