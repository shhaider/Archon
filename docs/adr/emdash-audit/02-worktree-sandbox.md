# 02 — Worktree Sandbox: Lifecycle Scripts, Trust, Cleanup

How each side creates, configures, and tears down isolated work
environments — and where Emdash's `.emdash.json` lifecycle hooks fit on top
of Archon's existing `IIsolationProvider` flow.

## Capability Matrix

| Capability | Emdash file:line | Archon file:line | Gap |
|------------|------------------|------------------|-----|
| Create per-task git worktree | `src/main/core/projects/worktrees/worktree-service.ts:141-195` (`checkoutBranchWorktree` + `doCheckoutBranchWorktree`; queued git ops, prune, add) | `packages/isolation/src/providers/worktree.ts:71-200` — `WorktreeProvider.create`; `IIsolationProvider` interface at `packages/isolation/src/types.ts:168-187` | Parity in concept; different surface (provider interface vs. service class) |
| Copy git-ignored files into worktree | `worktree-service.ts:279-296` — `copyPreservedFiles` driven by `preservePatterns` (default includes `.env*`, `docker-compose.override.yml`, `.emdash.json`) | `packages/isolation/src/worktree-copy.ts:32-100` — `parseCopyFileEntry`, `copyWorktreeFile` (path-traversal guard, ENOENT-skipped) driven by `worktree.copyFiles` (`packages/core/src/config/config-types.ts:160-166`) | Parity. Archon doesn't ship a default list — opt-in via repo config |
| `setup` / `run` / `teardown` lifecycle scripts | `src/main/core/projects/settings/schema.ts:27-33`; `src/main/core/terminals/runLifecycleScript.ts:1-23` | None — `RepoConfig.worktree` (`packages/core/src/config/config-types.ts:122-202`) has `baseBranch`/`copyFiles`/`initSubmodules`/`path` and **no** lifecycle keys | Real, narrow gap |
| Hook events at worktree-create / worktree-remove | None (lifecycle scripts run via direct RPC, not an event channel) | `packages/workflows/src/schemas/hooks.ts:1-88` already lists `WorktreeCreate` and `WorktreeRemove` among its 21 strict event types | Archon's hook surface already exists; the lifecycle PORT lands cleanly on it |
| Confirmation prompt before destroying worktree | None — `worktree-service.ts:274-277` removes recursively then prunes | None — `packages/cli/src/commands/isolation.ts:80-124` destroys without prompting | Both sides skip; portable UX gap |
| Trust / safe-directory handling | `claudeTrustService.maybeAutoTrustLocal(...)` called pre-spawn (`src/main/core/conversations/impl/local-conversation.ts:86-90`) | Archon's git layer uses `safe.directory` config and execFile wrappers; trust is handled at the git/launcher level, not as a per-spawn check | Different layer; not a clean PORT target |
| `init-submodules` after worktree create | None | `packages/isolation/src/types.ts:240-264` (`WorktreeCreateConfig.initSubmodules`, default `true`); auto-runs `git submodule update --init --recursive` when `.gitmodules` is present | Archon-only — should be preserved by any port |
| Per-project worktree path override | `src/main/core/projects/settings/schema.ts:34` (`worktreeDirectory`) | `packages/isolation/src/types.ts:255-263`; `packages/core/src/config/config-types.ts:180-202` (`worktree.path`, validated for safe relative paths) | Parity in concept, stricter validation in Archon |
| Shared remote/SSH worktree model | `agents/workflows/remote-development.md` (SSH path, out of scope here) | None — local only | Out of scope per `ROADMAP.md` P5 |

## What Emdash Does

Emdash's per-project settings live in `.emdash.json`, validated by a Zod
schema:

```ts
// src/main/core/projects/settings/schema.ts:12-44
export const projectSettingsSchema = z.object({
  preservePatterns: z
    .array(z.string())
    .optional()
    .default([
      '.env',
      '.env.keys',
      '.env.local',
      '.env.*.local',
      '.envrc',
      'docker-compose.override.yml',
      '.emdash.json',
    ]),
  shellSetup: z.string().optional(),
  tmux: z.boolean().optional(),
  scripts: z
    .object({
      setup: z.string().optional(),
      run: z.string().optional(),
      teardown: z.string().optional(),
    })
    .optional(),
  worktreeDirectory: z.string().trim().optional(),
  // …
});
```

The lifecycle scripts run via a tiny RPC that resolves the workspace and
defers to a per-workspace lifecycle service:

```ts
// src/main/core/terminals/runLifecycleScript.ts:1-23
export async function runLifecycleScript({
  projectId,
  workspaceId,
  type,
}: {
  projectId: string;
  workspaceId: string;
  type: 'setup' | 'run' | 'teardown';
}) {
  const workspace = resolveWorkspace(projectId, workspaceId);
  if (!workspace) throw new Error('Workspace not found');

  const settings = await getEffectiveTaskSettings({
    projectSettings: workspace.settings,
    taskFs: workspace.fs,
  });
  const script = settings.scripts?.[type];
  if (!script) return;
  await workspace.lifecycleService.runLifecycleScript({ type, script }, { exit: true });
}
```

Worktree creation itself is straightforward — a queued operation that prunes,
optionally creates the local branch, and runs `git worktree add`:

```ts
// src/main/core/projects/worktrees/worktree-service.ts:141-147
async checkoutBranchWorktree(
  sourceBranch: Branch | undefined,
  branchName: string
): Promise<Result<string, ServeWorktreeError>> {
  await this.ensureWorktreePoolDirExists();
  return this.enqueueGitOp(() => this.doCheckoutBranchWorktree(sourceBranch, branchName));
}
```

After creation, `copyPreservedFiles` walks `preservePatterns` and copies the
matched files into the new worktree
(`worktree-service.ts:279-296`). Removal is unconditional —
`removeWorktree(worktreePath)` deletes the path recursively then prunes
(`worktree-service.ts:274-277`); there is no confirmation step.

## What Archon Does Today

Archon's isolation system is a typed provider:

```ts
// packages/isolation/src/types.ts:168-187
export interface IIsolationProvider {
  readonly providerType: IsolationProviderType;

  create(request: IsolationRequest): Promise<IsolatedEnvironment>;

  /**
   * Best-effort cleanup. Throws only for unexpected errors (permissions, git failures).
   */
  destroy(envId: string, options?: DestroyOptions | WorktreeDestroyOptions): Promise<DestroyResult>;

  get(envId: string): Promise<IsolatedEnvironment | null>;

  /** For worktrees, codebaseId is the canonical repo path */
  list(codebaseId: string): Promise<IsolatedEnvironment[]>;

  /** Take ownership of externally-created environments (optional, for skill-app symbiosis) */
  adopt?(path: string): Promise<IsolatedEnvironment | null>;

  healthCheck(envId: string): Promise<boolean>;
}
```

The repo-level config carries the worktree shape — and notably no lifecycle
hooks:

```ts
// packages/core/src/config/config-types.ts:154-202 (excerpt)
worktree?: {
  baseBranch?: string;
  copyFiles?: string[];
  initSubmodules?: boolean;
  path?: string;
};
```

Environments are persisted by a unique key per (codebase, workflow_type,
workflow_id) — `migrations/006_isolation_environments.sql:1-71`:

```sql
-- migrations/006_isolation_environments.sql:5-27
CREATE TABLE IF NOT EXISTS remote_agent_isolation_environments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codebase_id           UUID NOT NULL REFERENCES remote_agent_codebases(id) ON DELETE CASCADE,
  workflow_type         TEXT NOT NULL,
  workflow_id           TEXT NOT NULL,
  provider              TEXT NOT NULL DEFAULT 'worktree',
  working_path          TEXT NOT NULL,
  branch_name           TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active',
  created_at            TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_by_platform   TEXT,
  metadata              JSONB DEFAULT '{}',
  CONSTRAINT unique_workflow UNIQUE (codebase_id, workflow_type, workflow_id)
);
```

Cleanup paths skip the prompt-before-destroy step that a real "trust" UX
would surface; the CLI removes worktrees and updates DB status without user
confirmation:

```ts
// packages/cli/src/commands/isolation.ts:106-114
await provider.destroy(env.working_path, {
  branchName: env.branch_name ? toBranchName(env.branch_name) : undefined,
  canonicalRepoPath: toRepoPath(env.codebase_default_cwd),
});

await isolationDb.updateStatus(env.id, 'destroyed');
```

The existing per-node hook event surface already declares the events a
lifecycle PORT would fire on:

```ts
// packages/workflows/src/schemas/hooks.ts:10-32 (excerpt)
export const workflowHookEventSchema = z.enum([
  // …
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
]);
```

## Where They Diverge

- Archon already abstracts isolation behind `IIsolationProvider`; Emdash uses
  a concrete `WorktreeService` class. A lifecycle PORT must extend the
  provider interface (or its config injection at
  `packages/isolation/src/types.ts:240-264`), not bypass it.
- Archon's `WorktreeCreate` / `WorktreeRemove` hook events
  (`packages/workflows/src/schemas/hooks.ts:1-88`) are the existing
  in-process channel for "worktree just changed state". Emdash has no
  equivalent — it calls the lifecycle service directly. Archon should reuse
  its hook events rather than adding a parallel RPC.
- `init-submodules` (Archon, `packages/isolation/src/types.ts:240-264`) and
  `tmux` (Emdash, `projectSettingsSchema:26`) are non-overlapping. The
  lifecycle PORT should preserve `initSubmodules` and ignore `tmux` — Archon
  does not run agents in PTYs, so a tmux toggle has nothing to attach to.
- Neither side has a confirmation prompt before destroy. This is shared
  pattern debt, not a port; the Web UI sidebar
  (`packages/web/src/components/sidebar/ProjectDetail.tsx:35-64`) is the
  natural surface for an Archon-side confirmation but the change is
  independent of the lifecycle script port.

## Recommendation

Two distinct verdicts share this section because the underlying gap is
shared (worktree UX) but the recommendations point at different code:

- **Lifecycle scripts (`setup` / `run` / `teardown`)** — `PORT (narrow)`.
  Extend `WorktreeCreateConfig`
  (`packages/isolation/src/types.ts:240-264`) and `RepoConfig.worktree`
  (`packages/core/src/config/config-types.ts:122-202`) with optional
  `setup` / `run` / `teardown` script fields. Run them inside
  `WorktreeProvider.create` (`packages/isolation/src/providers/worktree.ts`)
  and `destroy`, dispatching `WorktreeCreate` / `WorktreeRemove` hook events
  (`packages/workflows/src/schemas/hooks.ts:1-88`) at the same boundary so
  workflows can react. Do not adopt `tmux` or `shellSetup`.
- **Trust / destroy-confirmation UX** — `EXTRACT-PATTERN`. Neither side
  prompts today. The pattern worth extracting is "list the user's worktrees
  with branch + age + last activity, then confirm before destroying" — the
  rendering side fits the existing
  `packages/web/src/components/sidebar/ProjectDetail.tsx:35-64` polling
  layout. Defer the actual build to a follow-on roadmap item; do not block
  the lifecycle PORT on it.

Verdict: PORT (lifecycle scripts) — owning Archon modules `packages/isolation/` and `packages/core/src/config/`; EXTRACT-PATTERN (destroy confirmation UX) — owning Archon module `packages/web/src/components/sidebar/`.
