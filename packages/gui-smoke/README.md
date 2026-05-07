# @archon/gui-smoke

A single Playwright spec that boots `bun run dev` and walks the four primary
Web UI surfaces — Chat, Dashboard, Workflows, Workflow Builder — against the
source web/server build. Fails on console errors and same-origin 5xx network
responses. Produces an HTML report, traces, screenshots, and videos for
triage.

This package fulfills [ROADMAP.md](../../ROADMAP.md) **P1-A** (real-user GUI
verification).

## Run locally

```bash
# One-time per machine — installs Chromium + Linux deps
bun run test:gui:install

# The smoke run — boots `bun run dev` and walks the journey
bun run test:gui
```

Required state:

- Clean checkout (the spec registers `${repo-root}` as a project via the
  in-app Add-project flow).
- `bun` >= 1.3 and a working `bun run dev`.
- Ports `3099` (Hono server) and `5173` (Vite dev server) free, **or** an
  already-running dev session bound to those ports (the spec sets
  `reuseExistingServer: !CI` and will reuse a running dev server outside CI).

## What the journey asserts

| Step | Action | Assertion |
|------|--------|-----------|
| 1 | `GET /` | Redirects to `/chat`; top-nav `Chat` link visible |
| 2 | Click `Add project`, fill repo path, Enter | `archon` option appears in project select within 15s |
| 3 | Send `/help` in chat | Response containing `Archon Orchestrator` appears within 30s |
| 4 | Click `Dashboard` | URL `/dashboard`, `<h1>Mission Control</h1>` visible |
| 5 | Click `Workflows` | URL `/workflows`, `<h1>Workflows</h1>` visible, `New Workflow` link present |
| 6 | Click `New Workflow` | URL `/workflows/builder`, builder library panel visible |
| 7 | Final | Console errors and same-origin 5xx network responses both empty |

The `/help` slash command is deterministic — it is handled entirely by
`packages/core/src/handlers/command-handler.ts` without any LLM call. No API
keys are required.

## Unsupported setups (intentionally bypassed)

The smoke run does NOT exercise these surfaces and does NOT require their
credentials:

- **LLM credentials** (`CLAUDE_API_KEY`, `CODEX_API_KEY`, etc.) — not needed;
  spec only sends `/help`, which is deterministic.
- **Telegram / Slack / Discord tokens** — adapters are skipped server-side
  when env vars are absent.
- **GitHub webhooks** — not exercised.
- **PostgreSQL** — explicitly out of scope. The harness uses the SQLite
  default at `${ARCHON_HOME}/archon.db` (a tmpdir per process, set in
  `playwright.config.ts`).
- **macOS keychain / Claude OAuth** — not exercised.
- **Multi-browser matrix (Firefox, WebKit)** — Chromium only.
- **Visual regression / pixel diffing** — assertions are DOM/text-based.
- **Mobile / viewport variants** — desktop 1280x720 only.

Adding any of these is a follow-up roadmap item, not a P1-A blocker.

## Triage on failure

When the spec fails:

1. Open the HTML report:
   ```bash
   bun --filter @archon/gui-smoke smoke:report
   ```
   Or, in CI: download the `gui-smoke-report` artifact from the failed run.

2. Inspect the trace (`packages/gui-smoke/playwright-report/data/<id>.zip`)
   in the [Playwright Trace Viewer](https://playwright.dev/docs/trace-viewer).

3. Cross-reference the captured `console.error` text with the source files
   listed in `packages/web/src/`.

4. Same-origin 5xx responses are listed in the failing assertion's diff —
   match them against `packages/server/src/routes/`.

5. **File regressions as a P1 entry on `ROADMAP.md`** with the trace
   excerpt or screenshot inline. P1's contract is "GUI failures become
   concrete bugs on this roadmap".

## Why a dedicated workspace package?

`@archon/web`'s `test` script runs `bun test` (Bun's native runner), which is
incompatible with `@playwright/test`. Putting Playwright specs there would
either pollute that script or require renaming. Keeping the boundary clean
also aligns with the project's "single responsibility per package" rule
(see `CLAUDE.md` → "SRP + ISP").

## Why pin `PORT=3099`?

Archon's `getPort()` returns a hashed port for git-worktree paths
(`packages/core/src/utils/port-allocation.ts`). CI runs from a fresh
checkout (no worktree) and would default to `3090`, but local maintainers
often run from worktrees and would land on a different port. Pinning
`PORT=3099` in `playwright.config.ts` → `webServer.env` makes the harness
path-independent. Vite's proxy reads `PORT` via `loadEnv(_, _, '')` and
follows the same value.

## Why `bun run dev` and not the production build?

ROADMAP P1 explicitly demands running "the source web/server dev path,
not only the binary cache". The bundled production assets bypass the very
surface this work is intended to validate.
