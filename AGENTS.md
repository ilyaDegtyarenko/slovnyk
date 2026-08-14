# AGENTS.md

Working agreement for coding agents on this repository. Read `SPEC.md` before writing
any code. If the spec and this file disagree, `SPEC.md` wins on behaviour and this file
wins on process.

## Commands

```bash
npm run dev        # local dev server
npm run build      # production build — must pass before every commit
npm run test       # vitest
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
```

## Non-negotiables

- **TypeScript strict.** No `any`, no `@ts-ignore`, no `!` non-null assertions outside
  tests. If typing is hard, the design is wrong.
- **Validate at the boundary.** Every byte from the network goes through zod before it
  touches application code.
- **Never invent scheduling logic.** All interval decisions go through `ts-fsrs`.
- **Progress is sacred.** Any code path that could drop or reset `progress` / `reviews`
  needs a test that proves it does not.
- **Do not add dependencies** beyond those listed in `SPEC.md` without stating the reason
  in the PR description. No UI kit, no state-management library, no ORM.
- **Never commit** `.env.local`, real sheet IDs, or personal vocabulary data. Fixtures in
  tests use invented words.

## Conventions

- App Router, server components by default; `'use client'` only where interactivity or
  IndexedDB genuinely requires it.
- Business logic lives in `src/lib/*` as pure, testable functions. Components render, they
  do not decide.
- Tailwind utilities inline. No CSS modules, no styled-components.
- Names say what things are: `dueCards`, not `data`. No abbreviations except `id`.
- Comments explain *why*, never *what*. Code that needs a *what* comment gets rewritten.

## Git

- Conventional commits: `feat:`, `fix:`, `chore:`, `test:`, `refactor:`, `docs:`.
- One milestone from `TASKS.md` per branch, one PR per milestone.
- PR description states: what changed, how it was verified, what is deliberately not done.

## Definition of done for any task

1. `npm run build`, `npm run typecheck`, `npm run lint`, `npm run test` all pass.
2. The acceptance criteria in `TASKS.md` for that milestone are demonstrably met.
3. New logic in `src/lib` has tests.
4. No TODO comments left behind — unfinished work goes in `TASKS.md`, not in the source.

## When blocked

Do not guess on product behaviour. If `SPEC.md` does not answer a question, implement the
smallest reasonable version, and list the open question at the top of the PR description
under **Open questions**. Never silently choose an interpretation that is expensive to
reverse.
