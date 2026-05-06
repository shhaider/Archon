# 03 — Provider UX: Status Surface, Selector, Auto-Approve

How each side surfaces "which agents are installed and ready right now" and
how the user picks one. This is the area where Archon has the most to gain
from Emdash's UX shape — backend parity is already close.

## Capability Matrix

| Capability | Emdash file:line | Archon file:line | Gap |
|------------|------------------|------------------|-----|
| Per-provider availability probe API | `src/main/core/dependencies/controller.ts:1-34` — `getAll`, `get`, `getByCategory`, `probe`, `probeAll`, `probeCategory`, `install` | `packages/cli/src/commands/doctor.ts:213-259` — `doctorCommand` checks `claude` binary, `gh` auth, DB, workspace, bundled defaults, slack, telegram. CLI-only; no JSON endpoint | Archon has the *checks*, no *endpoint* and no *Web UI surface* |
| Provider registry with capabilities | `src/shared/agent-provider-registry.ts:1-26` (`AGENT_PROVIDER_IDS`, 24 ids); `:30-108` (`AgentProviderDefinition`) | `packages/providers/src/registry.ts:85-95` (`getProviderInfoList`); `:105-156` (`registerBuiltinProviders` Claude+Codex; `registerCommunityProviders` Pi); `GET /api/providers` at `packages/server/src/routes/api.ts:2637-2640` | Different breadth (24 vs ~3) but same shape; capabilities surface via different schemas |
| Renderer hook that filters to "installed" providers | `src/renderer/features/tasks/conversations/use-effective-provider.ts:17-41` — `installedProviderIds = AGENT_PROVIDER_IDS.filter(id => dependencyResource.data?.[id]?.status === 'available')` | None — Web UI does not consume `GET /api/providers` for filtering; provider lives in workflow YAML or `.archon/config.yaml` | Real gap; clean shape to mirror |
| Per-conversation provider selector | `src/renderer/features/tasks/conversations/create-conversation-modal.tsx:78-83` (`<AgentSelector />`) | None at the chat creation surface; resolved per-workflow-node (`packages/workflows/src/dag-executor.ts:325-410`) | Selector belongs to multi-agent UX (sub-doc 01); status filter is independent and useful on its own |
| Auto-approve toggle in UI | `create-conversation-modal.tsx:85-96` (Switch labeled "Dangerously skip permissions"); persisted via `useAgentAutoApproveDefaults`; flag string `--dangerously-skip-permissions` (Claude) / `--dangerously-bypass-approvals-and-sandbox` (Codex) at `src/shared/agent-provider-registry.ts:81, 99` | Permission control routed through Claude SDK `permissionMode` and per-node `hooks` callbacks (`packages/workflows/src/schemas/hooks.ts:1-88`; `packages/providers/src/claude/provider.ts:260-290, 408-430`); no UI toggle | Surface gap; Archon must NOT inherit Emdash's flag-string approach |
| Per-conversation default persistence | `useAgentAutoApproveDefaults` (referenced in `create-conversation-modal.tsx:38-39, 88-92`) | None | Pattern, not a port |
| Workflow-level provider override | None | `packages/workflows/src/schemas/dag-node.ts:138` (`provider`); `packages/workflows/src/dag-executor.ts:355` (`node.provider ?? workflowProvider`) | Archon-only mechanism; preserve in any port |
| Capability warnings when feature unsupported | None | `packages/workflows/src/dag-executor.ts:373-414` — emits `'dag.unsupported_capabilities'` and a user-visible warning | Archon-only; preserve |

## What Emdash Does

Emdash exposes a typed RPC controller that the renderer calls to discover
which agents are installed:

```ts
// src/main/core/dependencies/controller.ts:1-25 (excerpt)
export const dependenciesController = createRPCController({
  getAll: async (connectionId?: string) => {
    const mgr = await getDependencyManager(connectionId);
    return Object.fromEntries(mgr.getAll());
  },
  probe: async (id: DependencyId, connectionId?: string) => {
    const mgr = await getDependencyManager(connectionId);
    return mgr.probe(id);
  },
  probeAll: async (connectionId?: string) => {
    const mgr = await getDependencyManager(connectionId);
    return mgr.probeAll();
  },
  // …
});
```

Behind it is the registry shape with per-provider metadata, including
auto-approve flag, resume flag, session-id flag, and a `supportsHooks` bit:

```ts
// src/shared/agent-provider-registry.ts:30-68 (excerpt)
export type AgentProviderDefinition = {
  id: AgentProviderId;
  name: string;
  description?: string;
  // …
  autoApproveFlag?: string;
  initialPromptFlag?: string;
  resumeFlag?: string;
  sessionIdFlag?: string;
  // …
  terminalOnly?: boolean;
  supportsHooks?: boolean;
};
```

The renderer hook that powers the selector is small and clean — it filters
the static id list by the live availability snapshot:

```ts
// src/renderer/features/tasks/conversations/use-effective-provider.ts:17-41
export function useEffectiveProvider(connectionId?: string): EffectiveProvider {
  const [providerOverride, setProviderOverride] = useState<AgentProviderId | null>(null);

  const { value: defaultAgentValue } = useAppSettingsKey('defaultAgent');
  const defaultProviderId: AgentProviderId = isValidProviderId(defaultAgentValue)
    ? defaultAgentValue
    : 'claude';

  const dependencyResource = connectionId
    ? appState.dependencies.getRemote(connectionId)
    : appState.dependencies.local;
  const availabilityKnown = dependencyResource.data !== null;
  const installedProviderIds = AGENT_PROVIDER_IDS.filter(
    (id) => dependencyResource.data?.[id]?.status === 'available'
  );

  const { providerId, createDisabled } = resolveConversationProviderSelection({
    defaultProviderId,
    providerOverride,
    installedProviderIds,
    availabilityKnown,
  });

  return { providerId, setProviderOverride, createDisabled };
}
```

The auto-approve toggle in the create-conversation modal is exactly what its
label says — it stores a per-provider default and feeds it into the agent
command builder:

```tsx
// src/renderer/features/tasks/conversations/create-conversation-modal.tsx:85-96
<Field>
  <div className="flex items-center gap-2">
    <Switch
      checked={skipPermissions}
      disabled={!providerId || autoApproveDefaults.loading || autoApproveDefaults.saving}
      onCheckedChange={(checked) => {
        if (providerId) autoApproveDefaults.setDefault(providerId, checked);
      }}
    />
    <FieldLabel>Dangerously skip permissions</FieldLabel>
  </div>
</Field>
```

The flag value comes from the registry — Claude uses
`--dangerously-skip-permissions`, Codex uses
`--dangerously-bypass-approvals-and-sandbox`
(`src/shared/agent-provider-registry.ts:81, 99`).

## What Archon Does Today

Archon already has the registry plumbing, the public endpoint, and the doctor
checks — they just don't talk to each other or surface in the Web UI.

The registry exposes a Web-safe info list:

```ts
// packages/providers/src/registry.ts:85-95
export function getProviderInfoList(): ProviderInfo[] {
  return getRegisteredProviders().map(({ id, displayName, capabilities, builtIn }) => ({
    id,
    displayName,
    capabilities,
    builtIn,
  }));
}
```

…and a server route serves it:

```ts
// packages/server/src/routes/api.ts:2637-2640
// GET /api/providers - List registered AI providers
registerOpenApiRoute(getProvidersRoute, c => {
  return c.json({ providers: getProviderInfoList() });
});
```

The CLI side ships the per-tool readiness checks, but only as a `console.log`
report, not a JSON endpoint:

```ts
// packages/cli/src/commands/doctor.ts:222-232 (excerpt)
const promises = checks
  ? checks.map(fn => fn())
  : [
      checkClaudeBinary(env),
      checkGhAuth(env),
      checkDatabase(),
      checkWorkspaceWritable(),
      checkBundledDefaults(),
      checkSlack(env),
      checkTelegram(env),
    ];
```

The Web UI sidebar polls codebase environments and conversations every 10
seconds (`packages/web/src/components/sidebar/ProjectDetail.tsx:35-58`) but
does not render provider availability anywhere. Provider selection at the
node level happens inside `dag-executor.ts:325-410`, with capability
warnings emitted when a node requests features the chosen provider doesn't
support — so the *engine* knows Pi can't host certain features, but no UI
surface tells the user that ahead of time.

Permission control on Archon's side is intentional: the Claude provider
plumbs `permissionMode` and per-node `hooks` (workflow YAML —
`packages/workflows/src/schemas/hooks.ts:1-88`;
`packages/providers/src/claude/provider.ts:260-290, 408-430`). There is no
UI surface that toggles this today — and per `CLAUDE.md`'s "Fail Fast +
Explicit Errors" principle ("Never silently broaden permissions or
capabilities"), there should not be a flag-string toggle.

## Where They Diverge

- Archon's source of truth for *which providers exist* is the registry +
  `GET /api/providers`; Emdash's is `AGENT_PROVIDER_IDS` filtered by
  dependency probes. A port maps `dependenciesController.probeAll` to a new
  Archon endpoint that *re-uses* the existing `doctor` checks rather than
  adding a parallel registry.
- Emdash's auto-approve switch flips a CLI flag string. Archon's permission
  surface is the SDK `permissionMode` + per-node `hooks`. Adopting the *idea*
  of a per-provider default toggle is fine; adopting the flag string would
  silently bypass `CLAUDE.md`'s permission-mode contract and is a non-goal.
- Provider scope differs (Emdash 24 ids; Archon 3 — Claude, Codex, Pi). The
  port is the *shape* (typed registry + readiness map + UI hook), not the
  list. Pi (community provider, `packages/providers/src/registry.ts:154-156`)
  is the interesting case for Archon — it's the provider where "is the right
  binary installed and authenticated?" is most user-visible, and where the
  status surface pays off immediately.
- Capability-warning emission (Archon, `dag-executor.ts:373-414`) has no
  Emdash analogue. Any port must preserve it — silently dropping a feature
  because the chosen provider can't honor it is exactly what the warning is
  there to prevent.

## Recommendation

Two distinct verdicts in this section:

- **Provider status surface + selector** — `PORT`. The minimum viable port
  is:
  1. expose the `doctor` checks (`packages/cli/src/commands/doctor.ts:213-259`)
     as a JSON endpoint (e.g. `GET /api/doctor`), reusing the existing
     `Promise.allSettled` loop;
  2. add a renderer hook in `packages/web/` that mirrors
     `useEffectiveProvider`'s shape — read `GET /api/providers` and
     `GET /api/doctor`, filter to "ready", and feed a selector;
  3. surface the result in the existing
     `packages/web/src/components/sidebar/ProjectDetail.tsx` polling layout.
  Provider list stays Archon's (Claude / Codex / Pi); registry is the
  authority. Pi is the immediate beneficiary.
- **Auto-approve toggle** — `EXTRACT-PATTERN`, do not port flag strings.
  Mirror the *UX* (a per-provider, persistent toggle in the conversation /
  workflow surface) but route the value through Archon's existing
  `permissionMode` / per-node `hooks` plumbing
  (`packages/providers/src/claude/provider.ts:260-290, 408-430`;
  `packages/workflows/src/schemas/hooks.ts:1-88`), not Emdash's flag-string
  registry field. Capability warnings
  (`packages/workflows/src/dag-executor.ts:373-414`) remain authoritative.

Verdict: PORT (provider status surface + selector) — owning Archon modules `packages/web/`, `packages/cli/src/commands/doctor.ts`, `packages/server/src/routes/`, `packages/providers/src/registry.ts`; EXTRACT-PATTERN (per-provider auto-approve UX) — owning Archon modules `packages/web/`, `packages/providers/src/claude/provider.ts`, `packages/workflows/src/schemas/hooks.ts`.
