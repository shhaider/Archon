# Bibliography — Emdash Port Evaluation (P5-A)

Every primary source consulted by `docs/adr/0001-emdash-port-evaluation.md`
and the four evidence sub-docs. Citations use relative paths with line ranges
so a future reader can independently re-read each one and verify that the
audit's prose matches the code.

## Source revisions at audit time

| Repo | Local path | HEAD commit | Notes |
|------|------------|-------------|-------|
| Emdash | local sidecar checkout (Mac-local; not committed) | `c1ed4cfe6c2d5b3ba2900c5c7ce0c409e202b1e7` | `generalaction/emdash` v1.1.6, Apache-2.0 (`LICENSE.md`). Sidecar checkout, not a dependency. |
| Archon | `shhaider/Archon` worktree (this repo) | `661e72c9d2c9b0a2131df454051731aa1db67c35` | Branch `archon/task-archon-p5-emdash-audit`, base `dev`. |

Re-running this audit against a different revision pair will produce
different citations; record both HEADs in any successor ADR before quoting.

## Emdash sources

| Path | Lines | What it is | Used in section |
|------|-------|------------|-----------------|
| `src/main/db/schema.ts` | 238-261 | `conversations` table — taskId FK with `onDelete: 'cascade'` | 01 |
| `src/main/db/schema.ts` | 369-375 | `tasksRelations` — `conversations: many(...)` | 01 |
| `src/shared/conversations.ts` | 3-11 | `Conversation` type (id, projectId, taskId, providerId, resume, autoApprove) | 01, 03 |
| `src/shared/tasks.ts` | 22-42 | `Task` type — `conversations: Record<string, number>` | 01 |
| `src/shared/agent-session.ts` | 3-15 | `AgentSessionConfig` (taskId, conversationId, providerId, sessionId, tmuxSessionName, autoApprove) | 01, 03 |
| `src/shared/agent-provider-registry.ts` | 1-26 | `AGENT_PROVIDER_IDS` — 24 CLI provider ids | 03 |
| `src/shared/agent-provider-registry.ts` | 30-108 | `AgentProviderDefinition`; `claude` and `codex` entries (`autoApproveFlag`, `sessionIdFlag`, `supportsHooks`, `terminalOnly`) | 01, 03 |
| `src/main/core/projects/worktrees/worktree-service.ts` | 141-195 | `checkoutBranchWorktree` + `doCheckoutBranchWorktree` (queued git ops, prune, add) | 02 |
| `src/main/core/projects/worktrees/worktree-service.ts` | 274-296 | `removeWorktree` (no confirmation) + `copyPreservedFiles` | 02 |
| `src/main/core/projects/settings/schema.ts` | 1-46 | `.emdash.json` zod schema (`preservePatterns`, `scripts.{setup,run,teardown}`, `shellSetup`, `tmux`, `workspaceProvider`) | 02 |
| `src/main/core/terminals/runLifecycleScript.ts` | 1-23 | `runLifecycleScript({projectId, workspaceId, type})` RPC; `type: 'setup' \| 'run' \| 'teardown'` | 02 |
| `src/main/core/agent-hooks/hook-server.ts` | 1-94 | HTTP hook server on `127.0.0.1:0`; `x-emdash-token` / `x-emdash-pty-id` / `x-emdash-event-type` headers; POST `/hook` | 04 |
| `src/main/core/agent-hooks/hook-config.ts` | 1-189 | Per-worktree writers for `.claude/settings.local.json` and `.codex/config.toml`; gitignore safety | 04 |
| `src/main/core/agent-hooks/agent-hook-service.ts` | 1-32 | Event enrichment + `isAppFocused()` notification gating | 04 |
| `src/main/core/agent-hooks/classifiers/base.ts` | 1-70 | PTY-output classifier fallback (4KB sliding window, ANSI strip) | 04 |
| `src/main/core/conversations/impl/local-conversation.ts` | 65-148 | Session start: writes hook config, passes `{port, ptyId, token}` via env, falls back to classifier when `!supportsHooks` | 01, 04 |
| `src/renderer/features/tasks/conversations/conversations-panel.tsx` | 23-102 | Tabbed multi-conversation panel (each tab owns its `ConversationStore`/PTY) | 01 |
| `src/renderer/features/tasks/conversations/create-conversation-modal.tsx` | 26-105 | `AgentSelector` + auto-approve `Switch`; `createConversation` RPC shape | 01, 03 |
| `src/renderer/features/tasks/conversations/use-effective-provider.ts` | 17-41 | Filters `AGENT_PROVIDER_IDS` by `dependencyResource.data?.[id]?.status === 'available'` | 03 |
| `src/main/core/dependencies/controller.ts` | 1-34 | `dependenciesController` — `getAll` / `get` / `probe` / `probeAll` / `probeCategory` / `install` | 03 |
| `src/renderer/features/tasks/diff-view/main-panel/diff-view.tsx` | 1-14 | `DiffView` shell (`<DiffToolbar />` + `<FileDiffView />`) | 04 |
| `src/renderer/features/tasks/diff-view/main-panel/file-diff-view.tsx` | 1-85 | Monaco `IStandaloneDiffEditor`, git URI model registry, `useDiffEditorComments` | 04 |
| `src/renderer/features/tasks/diff-view/changes-panel/components/pr-entry/create-pr-modal.tsx` | 39-105 | PR creation modal — title/description/base/draft + optional `rpc.git.push` then `rpc.pullRequests.createPullRequest` | 04 |
| `src/main/core/pull-requests/controller.ts` | 10-72 | `listPullRequests`, `getPullRequestsForTask` (Octokit/`gh` underneath; `@octokit/request-error`) | 04 |
| `src/shared/lineComments.ts` | 1-58 | `LineCommentLike`, `formatCommentsForAgent` → `<user_comments><file path="..."><comment line="...">` XML | 04 |
| `package.json` | 1-40 | Stack: Electron, electron-vite, Drizzle, `vitest`; `name: emdash`, `version: 1.1.6`, `license: Apache-2.0` | 00 (ADR Context) |
| `README.md` | 1-50 | Provider matrix (24 CLI agents), Y Combinator W26, Apache-2.0 license badge, "Agentic Development Environment" framing | 00 (ADR Context) |
| `LICENSE.md` | whole | Apache-2.0 license text | 00 (ADR Context) |
| `agents/architecture/overview.md` | whole | Process model (`src/main`, `src/preload`, `src/renderer`, `src/shared`) and RPC primitives | 00 (background, not directly quoted) |
| `agents/architecture/main-process.md` | whole | 24 domain modules under `src/main/core/` | 00 (background) |
| `agents/integrations/providers.md` | whole | Provider registry rules; per-provider hook config writers | 03 (background) |
| `agents/workflows/worktrees.md` | whole | `.emdash.json` keys; `shellSetup` runs in each PTY | 02 (background) |
| `agents/workflows/remote-development.md` | whole | SSH/remote model — explicitly out of scope for this audit (P5 covers local UX only) | Non-Goals |

## Archon sources

| Path | Lines | What it is | Used in section |
|------|-------|------------|-----------------|
| `ROADMAP.md` | 1-35 | Authority rule: the four named sidecar projects are reference candidates only, not architecture authorities for Archon | 00 (ADR Context) |
| `ROADMAP.md` | 155-178 | P5 acceptance criteria — the contract this ADR satisfies | 00 (ADR Context) |
| `ROADMAP.md` | 199-220 | Operating Rule For Dogfooding + Initial Worker Queue (line 219 is the P5-A bullet) | 00 (ADR Context) |
| `CLAUDE.md` | whole | Engineering principles (KISS, YAGNI, fail-fast, no-cross-process-lifecycle-mutation, package boundaries) | 00, 02, 03, 04 |
| `CHANGELOG.md` | 1-22 | Keep-a-Changelog format with `## [Unreleased]` section | 00 (Changelog edit) |
| `.github/PULL_REQUEST_TEMPLATE.md` | 1-130 | Required PR template (manually pasted into `gh pr create --body`) | Task 9 (out of scope here) |
| `packages/core/src/types/index.ts` | 22-36 | `Conversation` interface (1:1 with codebase, isolation env, AI assistant) | 01 |
| `packages/core/src/types/index.ts` | 75-89 | `Session` interface — `active: boolean`, `parent_session_id`, `transition_reason` (1:1 active session per conversation) | 01 |
| `packages/core/src/config/config-types.ts` | 122-202 | `RepoConfig.worktree`: `baseBranch`, `copyFiles`, `initSubmodules`, `path`. **No** `setup`/`run`/`teardown` keys | 02 |
| `migrations/006_isolation_environments.sql` | 1-71 | `remote_agent_isolation_environments` schema; `UNIQUE (codebase_id, workflow_type, workflow_id)` | 02 |
| `migrations/008_workflow_runs.sql` | 1-23 | `remote_agent_workflow_runs` (workflow_name, conversation_id, status) | 01 |
| `migrations/012_workflow_events.sql` | 1-22 | `remote_agent_workflow_events` (event_type, step_index, data JSONB; lean UI events; verbose log in `{cwd}/.archon/logs/{runId}.jsonl`) | 04 |
| `packages/isolation/src/types.ts` | 145-153 | `DestroyResult` — partial-failure shape for cleanup | 02 |
| `packages/isolation/src/types.ts` | 168-187 | `IIsolationProvider` interface (`create`, `destroy`, `get`, `list`, `adopt?`, `healthCheck`) | 02 |
| `packages/isolation/src/types.ts` | 240-264 | `WorktreeCreateConfig` — exactly the keys the lifecycle PORT must extend | 02 |
| `packages/isolation/src/types.ts` | 299-327 | `IsolationResolution` (`resolved` / `stale_cleaned` / `none` / `blocked`) | 02 |
| `packages/isolation/src/providers/worktree.ts` | 71-200 | `WorktreeProvider` create/destroy implementation (start of file is `resolveRepoLocalOverride` helper; full provider extends to ~line 1227) | 02 |
| `packages/isolation/src/worktree-copy.ts` | 32-100 | `parseCopyFileEntry`, `copyWorktreeFile` (path-traversal guard, ENOENT-skipped) | 02 |
| `packages/cli/src/commands/isolation.ts` | 35-124 | `isolation list` and `isolation cleanup` — **no confirmation prompt** before destroy | 02 |
| `packages/cli/src/commands/isolation.ts` | 130-174 | `isolationCleanupMergedCommand` — also deletes remote branches | 02 |
| `packages/cli/src/commands/doctor.ts` | 213-259 | `doctorCommand` — checks `claude` binary, `gh` auth, DB, workspace, bundled defaults, slack, telegram | 03 |
| `packages/providers/src/registry.ts` | 85-95 | `getProviderInfoList` — id / displayName / capabilities / builtIn | 03 |
| `packages/providers/src/registry.ts` | 105-156 | `registerBuiltinProviders` (Claude, Codex) + `registerCommunityProviders` (Pi) | 03 |
| `packages/server/src/routes/api.ts` | 2637-2640 | `GET /api/providers` (`registerOpenApiRoute(getProvidersRoute, …)`) | 03 |
| `packages/workflows/src/schemas/dag-node.ts` | 132-149 | `dagNodeBaseSchema` — `provider`, `hooks`, `mcp`, `skills` fields | 03, 04 |
| `packages/workflows/src/schemas/hooks.ts` | 1-88 | 21 supported hook events including `WorktreeCreate` and `WorktreeRemove`; `workflowNodeHooksSchema.strict()` | 02, 04 |
| `packages/workflows/src/dag-executor.ts` | 325-410 | `resolveNodeProviderAndModel` — `node.provider ?? workflow.provider`; capability warnings | 03, 04 |
| `packages/providers/src/claude/provider.ts` | 260-290 | Claude provider session resume / `sessionId` plumbing | 04 |
| `packages/providers/src/claude/provider.ts` | 408-430 | `loadMcpConfig` — per-node MCP config loading + env var expansion | 04 |
| `packages/web/src/components/chat/ChatInterface.tsx` | 41-101 | `mapMessageRow` (toolCalls, error, workflowDispatch, workflowResult, files metadata) | 01 |
| `packages/web/src/components/chat/ChatInterface.tsx` | 103-180 | `ChatInterfaceProps { conversationId }` — no tab abstraction; one chat per route | 01 |
| `packages/web/src/components/workflows/WorkflowExecution.tsx` | 46-53 | `WorkflowRunQueryData` shape | 04 |
| `packages/web/src/components/workflows/WorkflowExecution.tsx` | 76-99 | `'graph' \| 'logs' \| 'chat'` view tabs; `workerPlatformId` / `parentPlatformId` | 01, 04 |
| `packages/web/src/components/sidebar/ProjectDetail.tsx` | 35-64 | Polls conversations / runs / environments every 10s; filters `status === 'active'`; **no destroy UI** | 02, 03 |
| `packages/adapters/src/forge/github/adapter.ts` | 120-160 | `sendMessage` — posts comments only; chunked on length. **No PR creation.** | 04 |
| `packages/adapters/src/forge/github/adapter.ts` | 302-365 | Read-only GitHub adapter scope (issue/PR comments + merge detection) | 04 |
| Recent commit `661e72c9` | n/a | `docs: add standalone Archon upgrade roadmap` — precedent for repo-root markdown for roadmap-tier docs and for the `docs(...)` commit subject style | Task 9 (out of scope here) |

## External documentation referenced

| Source | Why referenced | Used in section |
|--------|----------------|-----------------|
| `LICENSE.md` (Emdash, Apache-2.0) | Attribution obligation activates only when actual code is ported | 00 (ADR Context, Non-Goals) |
| Keep a Changelog 1.1.0 | `### Documentation` change-type used in the conditional `CHANGELOG.md` edit (per `CLAUDE.md` `/release` skill notes) | Task 7 (conditional) |
| GitHub repo `generalaction/emdash` (README) | Confirms 24 CLI providers and Issues integrations matrix; consulted only when local checkout omits the same fact | 03 (background) |

## Notes for future readers

- All Emdash citations were verified to exist with valid line ranges at HEAD
  `c1ed4cfe…` during plan confirmation (56 / 56 OK). If a citation no longer
  resolves, the upstream Emdash file has moved — patch the citation in this
  bibliography and the matching evidence sub-doc; do not propagate the stale
  path.
- Every PORT and EXTRACT-PATTERN row in
  `docs/adr/0001-emdash-port-evaluation.md` names an Archon module path
  appearing in this bibliography. If a future ADR row names a path not listed
  here, that path was added without evidence and the audit's "owning Archon
  module" rule has been violated.
- The audit deliberately omits Emdash's SSH/remote-development model.
  `agents/workflows/remote-development.md` is listed only so the omission is
  auditable, not because it informs any verdict.
