# 01 — Multi-Agent Chats Per Task

How Emdash and Archon let a user run several conversations against the same
piece of work, what each side stores in its database, and what the smallest
useful pattern to extract is.

## Capability Matrix

| Capability | Emdash file:line | Archon file:line | Gap |
|------------|------------------|------------------|-----|
| Many conversations attached to one unit of work | `src/main/db/schema.ts:238-261, 369-375`; `src/shared/tasks.ts:22-42` (`conversations: Record<string, number>`) | `packages/core/src/types/index.ts:22-36` — `Conversation` rows are independent; no parent "task" row owning many conversations | Archon has no `task` aggregate; conversations are the unit of work |
| Tabbed multi-conversation UI panel | `src/renderer/features/tasks/conversations/conversations-panel.tsx:23-102` (`TabbedPtyPanel`, each tab is a `ConversationStore`/PTY) | `packages/web/src/components/chat/ChatInterface.tsx:99-101` — `ChatInterfaceProps { conversationId }`; one chat surface per route | No tab abstraction in the web UI |
| Provider chosen at conversation creation | `src/renderer/features/tasks/conversations/create-conversation-modal.tsx:26-105` — `AgentSelector` + auto-approve `Switch` | Provider/model resolved per-workflow-node (`packages/workflows/src/dag-executor.ts:325-410`); no Web UI per-conversation selector | Archon resolves provider at workflow-node level, not at chat-creation time |
| Active session = 1:1 with conversation | Conversations are PTY-attached and start fresh each time (`src/main/core/conversations/impl/local-conversation.ts:65-148`) | `packages/core/src/types/index.ts:75-89` — `Session.active: boolean`, `parent_session_id`, `transition_reason` enforce 1:1 active session per conversation | Archon's invariant is stricter; transitions create new linked sessions instead of overlapping |
| Deterministic per-chat agent state isolation | `sessionIdFlag: '--session-id'` for Claude (`src/shared/agent-provider-registry.ts:51-57, 102`); UUID derived from conversation id | Claude SDK is invoked per-node with its own session model (`packages/providers/src/claude/provider.ts:260-290`); no cross-conversation isolation flag because there's no shared worktree-with-multiple-CLIs case yet | Pattern worth extracting if Archon ever runs multiple chats in one worktree |
| Workflow / coordinator surface | None; agents run interactively in PTYs | `migrations/008_workflow_runs.sql:1-23`; `migrations/012_workflow_events.sql:1-22`; `packages/web/src/components/workflows/WorkflowExecution.tsx:76-99` (`'graph' \| 'logs' \| 'chat'` tabs) | Different shape entirely — Archon's multi-agent surface today is *workflow runs*, not *parallel chats* |

## What Emdash Does

Emdash treats a `task` as the unit of work and lets the user open as many
conversations against it as they want. The task aggregate carries its own
status, branch, and PR list, plus a map of conversation ids:

```ts
// src/shared/tasks.ts:22-42
export type Task = {
  id: string;
  projectId: string;
  name: string;
  status: TaskLifecycleStatus;
  sourceBranch: Branch | undefined;
  taskBranch?: string;
  // ...
  prs: PullRequest[];
  conversations: Record<string, number>;
  workspaceProvider?: 'byoi';
  workspaceId?: string;
};
```

The relation is enforced at the schema level:

```ts
// src/main/db/schema.ts:369-375
export const tasksRelations = relations(tasks, ({ one, many }) => ({
  project: one(projects, {
    fields: [tasks.projectId],
    references: [projects.id],
  }),
  conversations: many(conversations),
}));
```

Each `Conversation` row carries a `taskId` FK with `onDelete: 'cascade'`
(`src/main/db/schema.ts:238-261`), so a task's conversations are deleted when
the task is removed. The renderer hangs a tabbed panel off this relation —
each tab renders an independent `ConversationStore` backed by its own PTY:

```tsx
// src/renderer/features/tasks/conversations/conversations-panel.tsx:62-98
<TabbedPtyPanel<ConversationStore>
  store={conversationTabs}
  paneId="conversations"
  getSession={(s) => s.session}
  tabBar={<ConversationsTabs projectId={projectId} taskId={taskId} />}
  emptyState={/* … */}
/>
```

When the user opens a new conversation, `CreateConversationModal` picks a
provider via `AgentSelector` and a per-provider auto-approve flag, then calls
`conversationMgr.createConversation(...)`
(`src/renderer/features/tasks/conversations/create-conversation-modal.tsx:46-68`).
Provider state isolation between sibling tabs in the same worktree relies on
the per-provider `sessionIdFlag` (e.g. `--session-id` for Claude — see
`src/shared/agent-provider-registry.ts:102`), with the flag value derived
deterministically from the conversation id.

## What Archon Does Today

Archon does not model tasks; the conversation itself is the unit of work.
`Conversation` is independent and binds 1:1 to a codebase, an isolation
environment, and an assistant type:

```ts
// packages/core/src/types/index.ts:22-36
export interface Conversation {
  id: string;
  platform_type: string;
  platform_conversation_id: string;
  codebase_id: string | null;
  cwd: string | null;
  isolation_env_id: string | null; // UUID FK to isolation_environments
  ai_assistant_type: string;
  title: string | null;
  // ...
}
```

`Session` enforces the 1:1 active-session-per-conversation invariant:

```ts
// packages/core/src/types/index.ts:75-89
export interface Session {
  id: string;
  conversation_id: string;
  // ...
  active: boolean;
  // Audit trail fields (added in migration 010)
  parent_session_id: string | null;
  transition_reason: TransitionTrigger | null;
  ended_reason: TransitionTrigger | null;
}
```

The chat surface in the Web UI is single-stream — `ChatInterfaceProps` takes
exactly one `conversationId`
(`packages/web/src/components/chat/ChatInterface.tsx:99-101`), and message
metadata may carry `workflowDispatch`/`workflowResult` pointers
(`ChatInterface.tsx:41-101`) but there is no tab abstraction over multiple
parallel agent conversations in one view.

The closest existing analogue to "many agents on one piece of work" is the
*workflow run*: `WorkflowExecution` renders `'graph' | 'logs' | 'chat'` view
tabs over a single run with parent and worker conversations
(`packages/web/src/components/workflows/WorkflowExecution.tsx:76-99`); the
schema is in `migrations/008_workflow_runs.sql:1-23` and
`migrations/012_workflow_events.sql:1-22`. The shape is completely different
from Emdash's: a workflow run is a structured DAG with worker conversations
spawned as needed, not a free-form set of chats the user opens manually.

## Where They Diverge

- Different unit of work. Emdash has `task` over many conversations; Archon
  has `conversation` plus optional `workflow_run` over many worker
  conversations. Neither is a strict superset of the other.
- Different active-session semantics. Archon's `Session.active` invariant is
  intentional (`packages/core/src/types/index.ts:75-89`); adopting Emdash's
  "many overlapping conversations sharing a worktree" would either weaken
  that invariant or require the multi-root coordinator surface that
  `ROADMAP.md` P4 already plans. P5-A is not the right place to prejudge P4.
- Different provider-selection layer. Emdash picks a provider per
  conversation in the renderer; Archon picks per workflow node
  (`packages/workflows/src/dag-executor.ts:325-410`) and inherits at the
  workflow level. Porting Emdash's per-chat selector means deciding where
  workflow-level inheritance fits — also a P4-shaped question.
- The pattern that *is* portable independently is the deterministic
  `sessionIdFlag` mechanism (`src/shared/agent-provider-registry.ts:51-57`):
  if Archon ever runs more than one Claude conversation in one worktree
  simultaneously, isolating their on-disk session state via a derived UUID
  is a clean, low-risk extraction.

## Recommendation

The right shape for the multi-agent surface in Archon is the coordinator/run
model already on the roadmap as P4-A, not a port of Emdash's
`Task → many Conversations` schema. P5-A should record what is portable
without prejudging P4. The narrow extractable pattern is the deterministic
per-conversation `sessionIdFlag` mechanism — useful only if and when Archon
shares a worktree across multiple simultaneous chats. The tabbed panel UX
(`conversations-panel.tsx:23-102`) is a reasonable visual reference for the
day Archon needs to show several worker conversations side-by-side, but
that's a P4 conversation, not a port.

Owning Archon modules: schema decision in `packages/core/src/db/`,
session-id mechanism in `packages/providers/` (Claude provider already has
the SDK plumbing in `packages/providers/src/claude/provider.ts:260-290`),
multi-conversation panel in `packages/web/src/components/chat/`.

Verdict: EXTRACT-PATTERN — owning Archon modules `packages/core/src/db/`, `packages/providers/src/claude/provider.ts`, `packages/web/src/components/chat/`.
