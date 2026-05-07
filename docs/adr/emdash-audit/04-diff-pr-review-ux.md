# 04 — Diff / PR / Review UX, Plus Agent-Hooks Transport And PTY Classifiers

This section covers five sub-areas — Monaco-based diff renderer, PR creation
modal, line-comment review surface, agent-hooks HTTP transport, and PTY
output classifiers — in one file. They share a single underlying Archon gap
(no diff/PR/review surface in the Web UI, and no PTY-launched agent runtime)
so splitting them into four thin sub-docs would just multiply the same
divergence. The verdicts at the bottom are five separate decisions.

## Capability Matrix

| Capability | Emdash file:line | Archon file:line | Gap |
|------------|------------------|------------------|-----|
| In-app diff renderer | `src/renderer/features/tasks/diff-view/main-panel/diff-view.tsx:1-14` (`<DiffToolbar /> + <FileDiffView />`); `file-diff-view.tsx:1-85` (Monaco `IStandaloneDiffEditor` + git URI model registry) | None — Archon has no diff renderer in `packages/web/` | Multi-quarter build |
| Inline line-comment authoring on diff | `file-diff-view.tsx:29-62` (`useDiffEditorComments`, `addComment`/`updateComment`/`deleteComment` with file path + line number) | None | Multi-quarter build |
| Line-comment serialization for agent consumption | `src/shared/lineComments.ts:1-58` — `formatCommentsForAgent` → `<user_comments><file path="..."><comment line="...">…</comment></file></user_comments>` XML | None | Format pattern; not a port without the comment authoring surface |
| PR creation UI | `src/renderer/features/tasks/diff-view/changes-panel/components/pr-entry/create-pr-modal.tsx:39-105` (title, description, base, draft, optional `rpc.git.push` then `rpc.pullRequests.createPullRequest`) | None — `packages/adapters/src/forge/github/adapter.ts:120-160, 302-365` is read-only (issue/PR comments, merge detection) | Real gap; deeply coupled to diff/review surface |
| PR querying / sync | `src/main/core/pull-requests/controller.ts:10-72` — `listPullRequests`, `getPullRequestsForTask` (Octokit/`gh` underneath; `@octokit/request-error`) | None at API layer; `gh` shells out for review tasks (workflow-driven, not UI-driven) | Distinct from creation; same rough cost |
| Hook event transport | `src/main/core/agent-hooks/hook-server.ts:1-94` — HTTP server on `127.0.0.1:0`, token + ptyId + event-type headers, POST `/hook` | `packages/workflows/src/schemas/hooks.ts:1-88` — 21 strict event types delivered via SDK callback API; `packages/providers/src/claude/provider.ts:260-290, 408-430` | Different transport for a need Archon doesn't have |
| Per-worktree hook config writers | `src/main/core/agent-hooks/hook-config.ts:1-189` — writes `.claude/settings.local.json`, `.codex/config.toml`, `.pi/extensions/*`, `.opencode/plugins/*`, gitignore-safe | None directly; Archon's worktree provider copies user-managed files via `worktree.copyFiles` (`packages/core/src/config/config-types.ts:160-166`) | Different mechanism for a partly-overlapping need |
| PTY output classifier (state-event fallback) | `src/main/core/agent-hooks/classifiers/base.ts:1-70` — 4KB sliding window, ANSI strip, returns `notification` / `stop` / `error` events | None — Archon does not launch CLIs in PTYs | Non-need for Archon's SDK runtime |
| Workflow event surface (alternative to per-CLI events) | None | `migrations/012_workflow_events.sql:1-22` — lean UI events for step transitions, artifacts, errors; verbose log in `{cwd}/.archon/logs/{runId}.jsonl`; surfaced via `WorkflowExecution.tsx:46-99` (`'graph' \| 'logs' \| 'chat'`) | Archon already has a structured workflow event surface — different shape from Emdash's per-CLI hook events |
| Read-only forge adapter today | n/a | `packages/adapters/src/forge/github/adapter.ts:120-160, 302-365` — comments only, no PR creation | Establishes the scope ceiling for this audit cycle |

## What Emdash Does

### Diff renderer

The diff surface is a thin observer shell that hosts a Monaco diff editor:

```tsx
// src/renderer/features/tasks/diff-view/main-panel/diff-view.tsx:1-14
import { observer } from 'mobx-react-lite';
import { DiffToolbar } from './diff-toolbar';
import { FileDiffView } from './file-diff-view';

export const DiffView = observer(function DiffView() {
  return (
    <div className="flex h-full flex-col">
      <DiffToolbar />
      <div className="min-h-0 flex-1">
        <FileDiffView />
      </div>
    </div>
  );
});
```

`FileDiffView` builds Monaco URIs from `git` refs and a per-workspace path,
attaches an `IStandaloneDiffEditor`, and overlays a comments component:

```tsx
// src/renderer/features/tasks/diff-view/main-panel/file-diff-view.tsx:14-62 (excerpt)
export const FileDiffView = observer(function FileDiffView() {
  const { projectId } = useTaskViewContext();
  const provisioned = useProvisionedTask();
  const { workspaceId } = provisioned;
  const diffView = provisioned.taskView.diffView;
  const draftComments = provisioned.draftComments;
  const activeFile = diffView.activeFile;
  const [editor, setEditor] = useState<monaco.editor.IStandaloneDiffEditor | null>(null);

  // …addComment / updateComment / deleteComment wired through draftComments…

  useDiffEditorComments({
    editor: showEditor ? editor : null,
    comments,
    onAddComment: handleAddComment,
    onEditComment: handleEditComment,
    onDeleteComment: handleDeleteComment,
  });
  // …
});
```

Line comments serialize to a fixed XML envelope when fed back to agents:

```ts
// src/shared/lineComments.ts:23-29
const COMMENTS_WRAPPER = (
  fileBlocks: string[]
) => `The user has left the following comments on the code changes:

<user_comments>
${fileBlocks.join('\n')}
</user_comments>`;
```

### PR creation

The PR modal has a small surface — title, description, base override, draft —
and a single submit path that may push first, then create the PR:

```tsx
// src/renderer/features/tasks/diff-view/changes-panel/components/pr-entry/create-pr-modal.tsx:73-95 (excerpt)
if (push) {
  const pushResult = await rpc.git.push(
    projectId,
    workspaceId,
    repo?.configuredRemote.name ?? 'origin'
  );
  if (!pushResult.success) {
    log.error('Failed to push branch:', pushResult.error);
    setError(/* … */);
    return;
  }
}

const result = await rpc.pullRequests.createPullRequest({
  repositoryUrl,
  head: branchName,
  base: selectedBase.branch,
  title: title.trim(),
  body: description.trim() || undefined,
  draft,
});
```

Behind it is a typed RPC controller with PR querying via Octokit and `gh`:

```ts
// src/main/core/pull-requests/controller.ts:10-37 (excerpt)
export const pullRequestController = createRPCController({
  listPullRequests: async (projectId: string, options?: ListPrOptions) => {
    try {
      const prs = await prQueryService.listPullRequests(projectId, options);
      return ok({ prs, totalCount: prs.length });
    } catch (error) {
      log.error('Failed to list pull requests:', error);
      return err<PullRequestError>({
        type: 'list_failed',
        message: error instanceof Error ? error.message : 'Unable to list pull requests',
      });
    }
  },
  // …
});
```

### Agent-hooks HTTP transport and PTY classifiers

Because Emdash spawns agents in PTYs, it needs an out-of-band channel for
state events. The hook server listens on a random local port and rejects any
request without a matching token:

```ts
// src/main/core/agent-hooks/hook-server.ts:18-33 (excerpt)
async start(handler: HookHandler): Promise<void> {
  if (this.server) return;
  this.token = crypto.randomUUID();

  this.server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/hook') {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.headers['x-emdash-token'] !== this.token) {
      log.warn('HookServer: rejected request with invalid token');
      res.writeHead(403);
      res.end();
      return;
    }
    // …
  });
}
```

Per-worktree config writers gitignore-safely emit
`.claude/settings.local.json`, `.codex/config.toml`, and friends so the
launched CLI knows where to POST:

```ts
// src/main/core/agent-hooks/hook-config.ts:34-53 (excerpt)
async writeClaudeHooks(): Promise<boolean> {
  if (!(await resolveCommandPath('claude', this.exec))) return false;

  const config: Record<string, unknown> = (await this.fs.exists(CLAUDE_SETTINGS_PATH))
    ? await this.fs
        .read(CLAUDE_SETTINGS_PATH)
        .then((r) => JSON.parse(r.content) ?? {})
        .catch(() => ({}))
    : {};
  // …
  await this.fs.write(CLAUDE_SETTINGS_PATH, JSON.stringify({ ...config, hooks }, null, 2) + '\n');
  return true;
}
```

When a CLI doesn't support hooks, the classifier fallback parses ANSI-stripped
PTY output through a 4KB sliding window:

```ts
// src/main/core/agent-hooks/classifiers/base.ts:32-44 (excerpt)
const MAX_BUFFER = 4096; // 4KB sliding window

export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\r/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\][^\x1b]*\x1b\\/g, '');
}
```

## What Archon Does Today

Archon has no diff renderer, no PR creation in the Web UI or API, no
line-comment storage, and no PTY runtime — but it does have a structured
workflow event surface and an SDK-callback hook plumbing that *together* fill
the role of Emdash's hook server for the in-process case.

### Workflow events as the structured channel

```sql
-- migrations/012_workflow_events.sql:5-13
CREATE TABLE IF NOT EXISTS remote_agent_workflow_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id UUID NOT NULL REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL,
  step_index INTEGER,
  step_name VARCHAR(255),
  data JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
```

`WorkflowExecution.tsx:46-99` renders these via `'graph' | 'logs' | 'chat'`
tabs over a single workflow run.

### SDK-callback hooks (in-process)

```ts
// packages/workflows/src/schemas/hooks.ts:10-32 (excerpt)
export const workflowHookEventSchema = z.enum([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'SessionStart',
  // …
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
]);
```

The Claude provider plumbs MCP, hooks, and session resume through the SDK
directly (`packages/providers/src/claude/provider.ts:260-290, 408-430`); no
HTTP transport is needed because there is no separate PTY process to call
back into.

### GitHub adapter is read-only

```ts
// packages/adapters/src/forge/github/adapter.ts:128-143 (excerpt)
async sendMessage(
  conversationId: string,
  message: string,
  _metadata?: MessageMetadata
): Promise<void> {
  const parsed = this.parseConversationId(conversationId);
  if (!parsed) {
    getLog().error({ conversationId }, 'github.invalid_conversation_id');
    return;
  }
  // …postComment(parsed, message)…
}
```

The adapter posts comments and detects merges; PR creation lives outside it
(today, on the user's local `gh` for ad-hoc work).

## Where They Diverge

- Emdash is a desktop ADE with Electron, MobX stores, Monaco, a typed RPC
  layer, and direct local filesystem access. Archon is a Hono server + React
  Web UI with Drizzle/SQLite or Postgres and SSE. Diff/PR/review surfaces
  port across that boundary at full size, not in pieces.
- Emdash needs the HTTP hook transport because PTY-launched CLIs cannot call
  back into the host process otherwise. Archon does not launch CLIs in
  PTYs — it uses the Claude Agent SDK directly, and `node.hooks` already
  routes hook events through the SDK callback API. The HTTP server is a
  solution to a problem Archon does not have.
- The PTY-output classifier exists in Emdash because some CLIs do not
  support hooks
  (`src/shared/agent-provider-registry.ts:30-68`'s `supportsHooks` bit).
  Archon's two built-in providers (Claude, Codex) and the Pi community
  provider all expose structured events through their SDKs; ANSI-stripped
  state-machine parsing is a non-need.
- The per-worktree hook-config writer pattern (Emdash,
  `hook-config.ts:1-189`) maps imperfectly onto Archon's `worktree.copyFiles`
  (`packages/core/src/config/config-types.ts:160-166`): Archon copies
  user-managed files; Emdash *generates* a per-worktree config and
  gitignores it. The `gitignore` safety pattern is interesting; the
  generation pattern is solving the HTTP-transport need we don't have.
- Archon already has a richer authoritative event surface than Emdash for
  the workflow case (`migrations/012_workflow_events.sql:1-22` plus the
  JSONL log in `{cwd}/.archon/logs/{runId}.jsonl`). For the workflow case,
  porting an HTTP hook server would be a step backward.

## Recommendation

Five distinct sub-verdicts:

- **In-app diff renderer (Monaco-based)** — `NO-PORT (this cycle)`. Archon
  has zero diff infrastructure; Emdash's depends on Monaco + git URI model
  registry + draft-comments store + workspace path resolution. A faithful
  port is multi-quarter. The "any ported feature uses Archon's
  workflow/coordinator/evidence backend" acceptance rule
  (`ROADMAP.md:177`) is the binding constraint that keeps this from being a
  multi-week build. Document the gap inventory; defer to a dedicated
  diff/review roadmap item.
- **PR creation UI / controller** — `NO-PORT (this cycle)`. Same reason —
  the PR modal is meaningful only after the diff surface lands, and the
  read-only GitHub adapter today
  (`packages/adapters/src/forge/github/adapter.ts:120-160, 302-365`)
  intentionally scopes Archon's forge surface narrowly. A PR-creation port
  is a separate, deeper conversation about whether Archon should own that
  side-effect surface.
- **Line-comment review serializer** — `NO-PORT (this cycle)`. Without a
  diff surface there is no comment authoring surface, and without comments
  there is nothing to serialize.
- **Agent-hooks HTTP transport** — `NO-PORT`. Archon's SDK callback path
  fully covers the in-process case; the HTTP server is a PTY-runtime
  solution to a non-problem here. Note explicitly so future readers don't
  re-derive it.
- **Agent event classifier (PTY → state events)** — `NO-PORT`. Archon's
  providers expose structured events; ANSI parsing is a fallback for
  CLIs without hook support, none of which Archon ships today.

The single pattern worth carrying forward (outside the verdicts) is the
gitignore-safety idea in `hook-config.ts:151-189` — when Archon ever writes
machine-managed files into a worktree (today it only *copies* user files
via `worktree.copyFiles`), append `.gitignore` entries before writing.
That's a code-comment-level note, not a port.

Verdict: NO-PORT (diff renderer + PR creation UI + PR controller + line-comment serializer + agent-hooks HTTP transport + PTY classifier — five sub-areas, this cycle); owning Archon modules: n/a (gap inventory only) — future roadmap items would land in `packages/web/` (diff/review), `packages/adapters/src/forge/github/` (PR creation), `packages/workflows/` (already covers in-process hooks).
