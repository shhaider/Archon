# 0001 — Emdash Port Evaluation (P5-A)

- Status: Accepted
- Date: 2026-05-06
- Roadmap: ROADMAP.md P5 (lines 155–178)
- Audit packet: [docs/adr/emdash-audit/](./emdash-audit/)

## Context

Emdash (`generalaction/emdash`, v1.1.6, Apache-2.0; "an Agentic Development
Environment") is an Electron desktop app that orchestrates ~24 CLI coding
agents in parallel, each isolated in its own git worktree, locally or over
SSH. Stack: Electron + React renderer with MobX, Drizzle on better-sqlite3,
Monaco for diffs, node-pty for agent runtimes, typed RPC controllers between
main and renderer (per `agents/architecture/overview.md` in the local
checkout). It is a desktop product first; the agent runtime model is
PTY-launched CLIs, not in-process SDK calls.

`ROADMAP.md` P5 (lines 155–178) requires an architecture decision record
that decides, per feature area, whether to PORT, EXTRACT-PATTERN, or
NO-PORT each comparison surface, with the binding constraints that (a) any
ported feature uses Archon's workflow / coordinator / evidence backend, and
(b) no non-Archon authority is imported as a default. The decision must
land in writing before any port begins, so future port PRs are graded
against the per-area verdicts and not free-form opinion. P5 names five
evaluation areas: multi-agent task/conversation UI, task branch/worktree
creation UX, provider selection and provider status surfaces, diff/PR/review
UX, and sandbox/worktree trust and cleanup behaviour.

This ADR — supported by an evidence packet under `docs/adr/emdash-audit/` —
issues the per-area verdicts.

## Decision

Two areas merit a narrow PORT (worktree lifecycle scripts, provider status
surface + selector). Three areas merit EXTRACT-PATTERN (multi-agent
conversation UX, worktree destroy-confirmation UX, per-provider auto-approve
toggle). Five sub-areas under diff/PR/review UX, plus the agent-hooks HTTP
transport and the PTY classifier fallback, are NO-PORT this cycle — either
because Archon's SDK runtime makes them unnecessary, or because the build is
multi-quarter and partial ports would violate the "uses Archon's
workflow/coordinator/evidence backend" acceptance rule. Every PORT and
EXTRACT-PATTERN row below names a real path inside Archon's `packages/*`.

## Decision Matrix

| Feature area | Verdict | Owning Archon module | Rationale (one line) |
|--------------|---------|----------------------|----------------------|
| Multi-agent chats per task (schema + tabbed panel + per-chat selector) | EXTRACT-PATTERN | `packages/core/src/db/`, `packages/web/src/components/chat/` | Archon's coordinator/run model (P4) is the right shape for parallel agent surfaces; extract only the deterministic `sessionIdFlag` mechanism (`packages/providers/src/claude/provider.ts:260-290`) |
| Worktree lifecycle scripts (`setup` / `run` / `teardown`) | PORT (narrow) | `packages/isolation/`, `packages/core/src/config/` | Real gap — `RepoConfig.worktree` (`packages/core/src/config/config-types.ts:122-202`) has no lifecycle keys; existing `WorktreeCreate` / `WorktreeRemove` hook events (`packages/workflows/src/schemas/hooks.ts:1-88`) are the natural dispatch boundary |
| Worktree trust / destroy confirmation UX | EXTRACT-PATTERN | `packages/web/src/components/sidebar/` | Neither side prompts today; the Web UI sidebar polling layout (`ProjectDetail.tsx:35-64`) is the natural insertion point; defer to a later roadmap item |
| Provider status surface + selector | PORT | `packages/web/`, `packages/cli/src/commands/doctor.ts`, `packages/server/src/routes/`, `packages/providers/src/registry.ts` | `GET /api/providers` (`packages/server/src/routes/api.ts:2637-2640`) and `archon doctor` (`packages/cli/src/commands/doctor.ts:213-259`) already do the work; only the JSON endpoint and Web UI surface are missing |
| Per-provider auto-approve toggle | EXTRACT-PATTERN | `packages/web/`, `packages/providers/src/claude/provider.ts`, `packages/workflows/src/schemas/hooks.ts` | Mirror the *UX* but route through Archon's `permissionMode` / per-node `hooks` plumbing — never adopt Emdash's flag-string registry field; required by `CLAUDE.md` "Fail Fast + Explicit Errors" |
| Diff renderer + PR creation UI + line-comment serializer | NO-PORT (this cycle) | n/a — gap inventory only | Multi-quarter build across Hono / React / Drizzle vs. Electron + Monaco + RPC; partial port would violate the "uses Archon's workflow/coordinator/evidence backend" acceptance rule |
| Agent-hooks HTTP transport (`127.0.0.1:0` server + per-CLI config writers) | NO-PORT | n/a | Archon does not run agents in PTYs; the SDK callback path in `packages/workflows/src/schemas/hooks.ts:1-88` covers the in-process need without an HTTP transport |
| Agent event classifier (PTY output → state events) | NO-PORT | n/a | Archon's providers expose structured SDK events; ANSI-stripped state-machine parsing has no analogue need |

For full evidence, capability matrices, and per-area divergence analysis,
see the four sub-docs under `docs/adr/emdash-audit/` and the bibliography at
`docs/adr/emdash-audit/99-bibliography.md`.

## Consequences

### Positive

- Future P5-B / P5-C work has a written contract to land against. Reviewers
  can compare a port PR against this matrix instead of re-running the
  comparison.
- Two narrow ports (worktree lifecycle scripts, provider status surface +
  selector) are scoped well enough to slot into existing modules without
  schema rework — they ride on `WorktreeCreate` / `WorktreeRemove` hook
  events and on `archon doctor` / `GET /api/providers`.
- The "owning Archon module" column is mechanically auditable: every
  PORT/EXTRACT-PATTERN row points at a real path inside `packages/*`,
  satisfying `ROADMAP.md` P5's constraint that ported features reuse
  Archon's workflow/coordinator/evidence backend.
- The deferred items (diff/PR/review surface) now have a documented gap
  inventory. The cost of *not* deciding to build them is no longer free —
  it is logged in the matrix.

### Negative

- Diff/PR/review UX defers indefinitely. Users still need to leave the
  Archon Web UI to review code or open a PR. This is a real product gap;
  the audit's position is that solving it half-way is worse than solving
  it later in full.
- Two ports (lifecycle scripts, provider status surface) are *named* but
  not *built* in this cycle. If they are not picked up in the next P5 sub-
  cycle, the ADR risks aging into a description of work that almost
  happened. Mitigated by the ROADMAP `Initial Worker Queue` line for
  P5-A capturing the audit completion explicitly.
- The `EXTRACT-PATTERN` verdicts are softer than `PORT` — they document a
  shape worth following without scoping the actual change. Future authors
  must convert them into bounded tasks before implementing, or risk
  re-litigating the same area.

### Follow-up

Likely successor roadmap items (none scheduled by this PR — listed only so
the matrix is connected to the larger plan):

- P5-B (candidate): worktree lifecycle scripts in
  `packages/isolation/` + `packages/core/src/config/`, dispatching
  `WorktreeCreate` / `WorktreeRemove` hook events.
- P5-C (candidate): provider status surface — `GET /api/doctor` in
  `packages/server/`, renderer hook + selector in `packages/web/`, with the
  Pi community provider as the immediate beneficiary.
- Deferred (no candidate yet): diff renderer, PR creation UI, line-comment
  authoring + serializer. Track as a single multi-quarter item rather than
  splitting it.

## Non-Goals

This ADR is intentionally scoped narrowly. The following are out of scope
and do not count as gaps for any reviewer of this PR:

- No code changes outside `docs/`, `ROADMAP.md`, `CHANGELOG.md`. Zero
  TypeScript, zero schema, zero CI surface changes in this PR.
- No port implementation. The ADR decides PORT / EXTRACT-PATTERN / NO-PORT;
  the actual ports become future ROADMAP items (P5-B onward). Starting a
  port in the same PR would conflate the audit with the build.
- No changes to the public docs site (`packages/docs-web/`). The ADR is
  internal engineering documentation and lives in `docs/`.
- No comparison with non-Emdash sidecars. P5-A is Emdash-only by ROADMAP
  contract (`ROADMAP.md:1-35`). Cross-referencing would re-introduce
  non-Archon authority bias as default.
- No upstream-Emdash issue filing or external outreach. Port decisions stay
  internal until a successor roadmap cycle.
- No license-cleanroom analysis. The Emdash repo's Apache-2.0 license is
  noted; the attribution obligation activates only when actual code is
  ported in a later PR.
- No remote-via-SSH evaluation depth. Emdash's SSH/remote model
  (`agents/workflows/remote-development.md` in the local checkout) is
  acknowledged in the bibliography but explicitly excluded from the four
  evaluation areas.
- No new ADR convention beyond what this PR establishes. A single
  ADR + `docs/README.md` is the entire convention investment. No
  templating tool, MADR plugin, or ADR linter.

## References

- Decision contract: [`ROADMAP.md`](../../ROADMAP.md) P5 (lines 155–178);
  authority rule (lines 1–35).
- Engineering principles: [`CLAUDE.md`](../../CLAUDE.md) — KISS, YAGNI,
  fail-fast, no-cross-process-lifecycle-mutation.
- Evidence packet:
  - [01 — Multi-Agent Chats Per Task](./emdash-audit/01-multi-agent-chats.md)
  - [02 — Worktree Sandbox: Lifecycle Scripts, Trust, Cleanup](./emdash-audit/02-worktree-sandbox.md)
  - [03 — Provider UX: Status Surface, Selector, Auto-Approve](./emdash-audit/03-provider-ux.md)
  - [04 — Diff / PR / Review UX, Plus Agent-Hooks Transport And PTY Classifiers](./emdash-audit/04-diff-pr-review-ux.md)
  - [99 — Bibliography](./emdash-audit/99-bibliography.md)
- Source revisions at audit time:
  - Emdash: `generalaction/emdash@c1ed4cfe6c2d5b3ba2900c5c7ce0c409e202b1e7`
    (v1.1.6, Apache-2.0; see `LICENSE.md` in the local sidecar checkout).
  - Archon: `shhaider/Archon@661e72c9d2c9b0a2131df454051731aa1db67c35`
    on branch `archon/task-archon-p5-emdash-audit`.
