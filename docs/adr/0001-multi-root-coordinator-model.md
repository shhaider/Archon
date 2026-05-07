# ADR-0001: Multi-Root Coordinator / Run / Task / Claim Model (P4-A)

- **Status**: Accepted
- **Date**: 2026-05-06
- **Author**: qhhaider@gmail.com
- **Roadmap**: `ROADMAP.md` §"P4 - Multi-Root Coordinator Architecture" (lines 123–154) and §"Operating Rule For Dogfooding" (lines 199–212)
- **Slice**: P4-A (schema + DB layer + thin API skeleton + tests). Runtime integration is P4-B/C/D/E.

---

## 1. Context

Today Archon has a single durable abstraction for "work in progress":
`remote_agent_workflow_runs`. That table is appropriate for one-shot workflow
executions (the existing `workflow run` invocation, the resume/abandon flow,
the orchestrator's session bookkeeping). It is **not** appropriate for the
multi-root coordinator architecture the roadmap calls for.

`ROADMAP.md` lines 123–154 quote the requirements verbatim:

> P4 — Multi-Root Coordinator Architecture
>
> Goal: support multiple root-level coordinator conversations, each capable of
> dispatching multiple coding workers.
>
> Architecture direction:
>
> - one project may have several root coordinators, each bound to a roadmap,
>   phase, or user chat window
> - each root coordinator owns a durable task graph with dependencies, claims,
>   worker slots, and evidence state
> - root coordinators may spawn child planning agents when prompt-pack creation
>   becomes the bottleneck
> - worker agents remain isolated in branch/worktree environments
> - merge and PR activity is serialized by dependency/ownership gates, not by
>   hidden chat memory
>
> Tasks:
>
> - model coordinator runs, roadmap tasks, dependencies, worker claims, and
>   evidence in the database
> - expose status and controls in CLI and Web UI
> - add max-parallel worker limits per root coordinator and per repo
> - support crash/restart/resume of coordinator-owned task graphs
>
> Acceptance:
>
> - one user can open multiple root chat windows against the same repo
> - each root can dispatch independent worker runs without clobbering another
>   root's claims
> - status surfaces show roots, child workers, dependencies, blockers, and PRs

The "Operating Rule For Dogfooding" lines 199–212 makes the load explicit:

> Use Archon to upgrade Archon, with bounded parallelism.
>
> - run up to five Archon workflow instances at once
> - each instance owns an isolated branch/worktree
> - if Archon crashes, diagnose the Archon bug, fix it, and resume the blocked
>   task
> - mistakes made by Archon-generated workers become roadmap tasks or immediate
>   fixes depending on severity
> - do not close a task on prompt-pack generation alone; real code tasks require
>   real code, tests, commit, push, and PR evidence

What is missing today:

- **A roadmap-shaped DAG of tasks that span many workflow runs.** A roadmap
  phase like "P4-A" is conceptually one task that spawns several worker runs;
  there is no row in the DB that represents that abstraction.
- **Dependencies between tasks.** P3-A must complete before P3-B starts.
  Workflow runs do not have a typed dependency relation; they have a
  `parent_conversation_id` link, but that captures conversation lineage, not
  task ordering.
- **Claim/lease semantics so two parallel coordinators never dispatch the same
  task twice.** With several root chats open against the same repo, nothing
  prevents both from picking the same logical task.
- **Per-coordinator parallelism budgets.** "Up to five workflows at once" is
  enforced today only by user discipline.
- **Per-task evidence.** Commit SHA, PR URL, diff, test output live in
  `metadata` JSONB blobs with no schema, no validation, no cross-run aggregation.
- **Crash/resume semantics for the graph.** When the server restarts,
  `failOrphanedRuns()` marks individual `running` rows as failed, but there is
  no graph to resume FROM, so the next session does not know which tasks are
  unblocked.

Without a coordinator model, dogfooding Archon on Archon — the operating rule
the roadmap commits to — cannot reliably run "up to five Archon workflow
instances at once" against the same repo.

---

## 2. Decision

Add a coordinator layer **on top of** the existing `workflow_runs` engine.
Three new tables, all under the existing `remote_agent_*` prefix:

```
┌────────────────────────────────────────────────────────────┐
│              coordinator_runs (one per root chat)           │
│  • max_parallel_workers, status, codebase_id                │
└─────────────────────────┬───────────────────────────────────┘
                          │ 1:N
                          ▼
┌────────────────────────────────────────────────────────────┐
│              coordinator_tasks (DAG nodes)                  │
│  • depends_on JSONB[]   • state (blocked│ready│claimed│…)   │
│  • evidence JSONB       • external_key (e.g. "P4-A")        │
└─────────────────────────┬───────────────────────────────────┘
                          │ 1:N (audit trail of all claim attempts)
                          ▼
┌────────────────────────────────────────────────────────────┐
│           coordinator_task_claims (lease + outcome)         │
│  • worker_run_id ───→ workflow_runs.id (existing)           │
│  • claimed_at, lease_expires_at, released_at, outcome       │
│  • UNIQUE (task_id) WHERE released_at IS NULL  ◀── invariant │
└────────────────────────────────────────────────────────────┘
```

### 2.1 Tables and columns

The canonical column list lives in
`migrations/022_coordinator_model.sql` and the SQLite mirror in
`packages/core/src/db/adapters/sqlite.ts` `createSchema()`. The ADR points at
those files rather than inlining the SQL, because the migration is the source
of truth and any duplication here would risk drift.

Summary:

**`remote_agent_coordinator_runs`** — one row per root coordinator chat.

- `id UUID` (PK)
- `conversation_id UUID NOT NULL` → `remote_agent_conversations(id)` ON DELETE CASCADE
- `codebase_id UUID NOT NULL` → `remote_agent_codebases(id)` ON DELETE CASCADE
- `parent_run_id UUID NULL` → `remote_agent_coordinator_runs(id)` ON DELETE SET NULL
  (forward-compatible; child planning agents are P4-E)
- `name VARCHAR(255) NOT NULL`
- `status VARCHAR(20) NOT NULL DEFAULT 'planning'` — values: `planning | active | paused | completed | abandoned`
- `max_parallel_workers INTEGER NOT NULL DEFAULT 3`
- `metadata JSONB DEFAULT '{}'`
- `created_at`, `updated_at`, `completed_at` (TIMESTAMP WITH TIME ZONE)

**`remote_agent_coordinator_tasks`** — nodes of the task DAG.

- `id UUID` (PK)
- `coordinator_run_id UUID NOT NULL` → `remote_agent_coordinator_runs(id)` ON DELETE CASCADE
- `external_key VARCHAR(255) NOT NULL` (e.g. `P4-A`, `P3-A.1`)
- `title TEXT NOT NULL`
- `body TEXT NULL` — task brief / prompt-pack source
- `state VARCHAR(20) NOT NULL DEFAULT 'blocked'` — values: `blocked | ready | claimed | running | completed | failed | cancelled`
- `depends_on JSONB NOT NULL DEFAULT '[]'` — array of coordinator_task UUIDs
- `evidence JSONB NOT NULL DEFAULT '{}'` — typed shape: `{commit_sha, pushed_branch, pr_url, changed_files[], test_output, workflow_run_ids[], notes}`
- `metadata JSONB DEFAULT '{}'`
- `created_at`, `updated_at`, `started_at`, `completed_at`
- `UNIQUE (coordinator_run_id, external_key)` — operators can refer to a task
  stably by its roadmap key within a coordinator run.

**`remote_agent_coordinator_task_claims`** — lease + audit trail.

- `id UUID` (PK)
- `task_id UUID NOT NULL` → `remote_agent_coordinator_tasks(id)` ON DELETE CASCADE
- `coordinator_run_id UUID NOT NULL` → `remote_agent_coordinator_runs(id)` ON DELETE CASCADE
- `worker_run_id UUID NULL` → `remote_agent_workflow_runs(id)` ON DELETE SET NULL
- `worker_label VARCHAR(255) NULL`
- `claimed_at`, `lease_expires_at`, `released_at`
- `outcome VARCHAR(20) NULL` — values when set: `succeeded | failed | abandoned | expired`
- `metadata JSONB DEFAULT '{}'`

The load-bearing invariant is the **partial unique index**:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS unique_active_task_claim
  ON remote_agent_coordinator_task_claims (task_id)
  WHERE released_at IS NULL;
```

This enforces "at most one active claim per task" at the database layer.
Concurrent inserts that would violate it raise SQLSTATE `23505` on Postgres
and `SQLITE_CONSTRAINT_UNIQUE` on SQLite. The DB layer (P4-A) catches the
violation and returns `null` from `claimTask` — the "task already claimed"
signal — instead of throwing. The orchestrator (P4-B) treats `null` as
"someone else got it; pick the next ready task."

The pattern is borrowed verbatim from
`migrations/011_partial_unique_constraint.sql`, which uses the same construct
to enforce "at most one active isolation environment per workflow." That
mechanism has been in production since release 0.1 with no observed
correctness regressions; re-using it here is the conservative choice.

### 2.2 Forward-compatible additive column

`migrations/022_coordinator_model.sql` also adds, additively:

```sql
ALTER TABLE remote_agent_codebases
  ADD COLUMN IF NOT EXISTS max_parallel_workers INTEGER;
```

This lets P4-A persist a per-repo budget without committing the runtime
enforcement (which is P4-B's responsibility — the dispatcher needs the
information first). The column is nullable; `NULL` means "no per-repo cap."
The behavioral wiring is named in §3 ("Out of scope") below.

### 2.3 Why claims are a separate row, not a column on tasks

Three forces argued for a row-shaped claims table:

1. **Audit trail.** A task may be claimed once by a worker that crashed, leased
   for 15 minutes, expired, and then re-claimed by a fresh worker. The row
   shape preserves the prior attempt with its `outcome = 'expired'`. A column
   on the task (`claimed_by`, `lease_expires_at`) would clobber history each
   time and we would need a separate event log to retain it.

2. **Lease expiration without losing history.** `releaseExpiredClaims()` is a
   single UPDATE of all rows where `released_at IS NULL AND
   lease_expires_at < NOW()`. With a column shape, the equivalent operation
   would silently overwrite an active claim and we could not tell apart "lease
   expired then re-claimed" from "lease never existed."

3. **Max-parallel as a single COUNT(\*).** The orchestrator's parallelism
   gate in P4-B becomes
   `SELECT COUNT(*) FROM remote_agent_coordinator_task_claims WHERE coordinator_run_id = $1 AND released_at IS NULL`.
   With a column shape, the same query would have to JOIN tasks and would not
   benefit from the partial index `idx_coordinator_claims_run_active`.

The cost is one extra small table, one extra index, and one extra DB module
(`packages/core/src/db/coordinator-claims.ts`). All small; all comparable to
the existing `remote_agent_isolation_environments` story. Net: claims-as-row.

### 2.4 Schema-mirror discipline

The Postgres migration and the SQLite `createSchema()` MUST stay in sync.
SQLite's `bun:sqlite` does not run `migrations/*.sql`; instead the adapter
emits the same `CREATE TABLE IF NOT EXISTS` blocks at startup. The two
locations are listed in the ADR's §4 ("Consequences") as a known cost.

The P4-A change extends `migrateColumns()` to add `max_parallel_workers` to
existing SQLite databases — mirroring the additive Postgres `ALTER TABLE`.
The pattern is identical to migrations 015 (`parent_conversation_id`) and 019
(`working_path`), which were each reflected in `migrateColumns()` at the time
they shipped.

---

## 3. Out of scope (deferred to follow-on slices)

The roadmap entry for P4 lists a broad spread of work. P4-A is deliberately
a thin slice; the rest is named below with the slice that owns it.

**P4-B — Orchestrator integration (dispatcher).**
- `packages/core/src/orchestrator/` is **not** modified in P4-A.
- Coordinators do not yet auto-issue claims when a workflow run starts.
- The coordinator is a passive data layer in this slice; the dispatcher (the
  thing that watches `coordinator_runs`, picks ready tasks, calls
  `claimTask`, kicks off the worker `workflow_run`, heartbeats the lease,
  releases on completion) is P4-B.
- P4-B will also light up the `releaseExpiredClaims()` server-start sweep
  (analogous to today's `failOrphanedRuns()`).

**P4-C — CLI surfaces.**
- No `archon coordinator list/show/dispatch` commands.
- The CLI surface stays at `archon workflow ...`.
- Coordinator state is observable in P4-A only via the seven new HTTP
  endpoints (curl-testable).

**P4-D — Web UI surfaces.**
- No `CoordinatorPage`, no chat-sidebar surfacing of coordinator state, no SSE
  stream of coordinator events.
- Re-running `bun generate:types` to pick up the new schemas in `@archon/web`
  is also deferred to P4-D so frontend types do not change in this slice.

**P4-E — Child planning agents.**
- The roadmap text says "root coordinators may spawn child planning agents."
- A nullable `parent_run_id UUID REFERENCES coordinator_runs(id)` column is
  included in the schema **only as a forward-compatible field**.
- Behavioral support — what a child planner is, how it differs from a root,
  how its lifecycle interacts with the parent — is P4-E.

**Other out-of-scope items.**

- **No automatic claim issuance from `/workflow run`.** Workers explicitly
  POST a claim in P4-A; no implicit "this workflow run = a claim" wiring.
- **No worker-side helper for evidence emission.** The DB accepts an
  `evidence` JSONB on release; how the worker computes it (collecting commit
  SHA, PR URL, test output) is **P3-A territory** and should be wired through
  the existing P3 evidence-contract work, not duplicated here.
- **No multi-process coordination beyond DB constraints.** A single Archon
  server process is assumed. Cross-process coordinator coordination
  (multi-replica, Postgres-only) is explicitly out of scope; the
  partial-unique-index gives correct behavior for the single-process case and
  is forward-compatible.
- **No retry/backoff state machine.** Tasks that fail can be re-claimed (a
  new claim row can be created after the previous one's `released_at` is set),
  but automatic retry policy is deferred. The schema makes it expressible;
  the runtime is later.
- **No per-repo (codebase) max-parallel enforcement runtime.** The schema
  adds `remote_agent_codebases.max_parallel_workers` so the field exists for
  the future, but coordinator-level (`coordinator_runs.max_parallel_workers`)
  is the only one queryable in this slice.
- **No additional `workflow_events` event types.** Coordinator-level events
  (e.g. `task_state_changed`, `claim_acquired`) can be added in P4-B when the
  orchestrator emits them. No new event type schema is invented here.

---

## 4. Consequences

### Pros

- **Parallel safety.** Two root chats can issue concurrent dispatches against
  the same repo without ever both claiming the same task — the partial unique
  index makes that a hard DB-layer guarantee, not an application discipline.
- **Evidence schema as first-class.** P3-A's "real-execution proof"
  acceptance criterion gets a typed home (`coordinatorTask.evidence`) instead
  of a metadata blob. Reviewers can cross-reference commit SHA / PR URL /
  test output by querying tasks, not by parsing JSONB.
- **Resumable graphs.** When the server restarts, `releaseExpiredClaims()`
  (P4-A function, P4-B caller) sweeps stale leases without losing the task
  graph. The next session sees `state IN ('ready')` tasks and dispatches them
  again. Today's `failOrphanedRuns()` knows about runs but not graphs; this
  closes the gap.
- **Zero-impact rollout.** No orchestrator wiring in P4-A means no behavioral
  change for end-users: the CLI still works exactly as today. The only
  observable change is that `/api/coordinators/*` endpoints now exist and
  return data when called explicitly. All existing tests continue to pass.
- **Forward-compatible.** `parent_run_id` (child planners), per-repo
  `max_parallel_workers`, and the row-shaped claims audit trail are all
  forward-compatible fields that downstream slices light up without requiring
  a second migration.

### Cons

- **One more table to keep in sync between PG migrations and SQLite
  `createSchema()`.** This cost is real; we already pay it for the seven
  existing tables. The mitigation is the test plan in T9 — the SQLite path is
  the one most likely to drift, and the integration tests in
  `coordinator-{runs,tasks,claims}.test.ts` exercise it.
- **CLI/UI catch-up required in P4-B/C/D.** The schema lands before the user
  surface. Operators dogfooding Archon on Archon will continue to use today's
  flow until P4-B ships. This is intentional — the schema is the load-bearing
  artifact, and decoupling it from the surface lets us validate the data
  model under tests before paying the surface cost.
- **Not yet enforced for multi-process replicas.** A single Archon server
  process is still assumed. Multi-replica enforcement requires a coordinator
  beyond the partial-unique-index (e.g. advisory locks, a leader election
  layer). That's not on the roadmap and is named here only so the choice is
  explicit.

---

## 5. Alternatives considered

1. **Single column `claimed_by` on tasks.**
   *Rejected.* No audit trail, lease expiry loses history, retried tasks lose
   prior evidence. The "max-parallel as COUNT(*)" pattern would also have to
   query tasks JOINed against claims-by-position rather than a single index.

2. **Re-use `workflow_runs` as the task table.**
   *Rejected.* `workflow_runs` is per-execution and per-isolation; tasks are
   per-roadmap-item and span many runs. Conflating them would break two
   abstractions: a roadmap task may produce many workflow runs (planning,
   research, implementation, retries), and a workflow run may serve many
   logical tasks (the orchestrator does composite work). The two have
   different lifecycles and different identity rules.

3. **Store dependencies as a separate edges table
   (`remote_agent_coordinator_task_edges (task_id, depends_on_id)`).**
   *Rejected for now under YAGNI.* JSONB array is sufficient for the read
   patterns we need (reading a task's deps; computing "are all deps complete";
   listing ready tasks). If topological queries become a hot path — e.g. "is
   there a cycle in the graph?", "what is the critical path?" — we can
   normalize later. The DB-module function `arePrerequisitesMet(task,
   allTasks)` (T7) is the natural interception point: today it walks the
   array; later it can issue a single recursive CTE query. The Zod schema
   does not need to change.

4. **Use `metadata` JSONB for evidence.**
   *Rejected.* Evidence is the gating signal for P3-A's "real-execution
   proof"; it deserves its own typed schema. Storing evidence in `metadata`
   would mean every reviewer has to know which keys to look for and would
   block schema-level validation. The typed `evidence` JSONB column with the
   `evidenceSchema` Zod definition (T3) is the minimum needed to make
   evidence a first-class field.

---

## 6. Open questions / future work

- **Per-repo max-parallel runtime.** Column is added; enforcement is deferred
  to P4-B (or potentially P5 if the dispatcher does not need it immediately).
  The wiring point will be the dispatcher's "can I claim another task?"
  check, which already needs a coordinator-level check; the per-repo check
  joins `coordinator_runs` and `codebases`.
- **Child planning agents.** `parent_run_id` exists; behavioral semantics —
  whether child runs share the parent's task pool, whether they have their
  own `max_parallel_workers`, how they appear in the UI — are P4-E.
- **Cross-process replica coordination.** Out of scope for the
  single-process model. If we ever go multi-replica we need either Postgres
  advisory locks or a leader election layer; the partial-unique-index gives
  us correctness within a single process but does not order writes across
  replicas (each replica would still serialize through Postgres, but the
  application-side `claimTask + isUniqueViolation` retry loop should not loop
  forever — that needs a backoff policy we have not designed).
- **Coordinator-level event types.** Do we extend `workflow_events` with
  `coordinator.task_state_changed`, `coordinator.claim_acquired`,
  `coordinator.claim_released`? Probably yes in P4-B; the schema does not
  forbid it. We deliberately do **not** invent the event type names in P4-A
  because the dispatcher is the natural author.

---

## 7. Links

- Migration: `migrations/022_coordinator_model.sql`
- Engine schemas: `packages/workflows/src/schemas/coordinator.ts`
- Engine schema barrel: `packages/workflows/src/schemas/index.ts`
- SQLite mirror: `packages/core/src/db/adapters/sqlite.ts` (`createSchema()` and `migrateColumns()`)
- Postgres dialect helper: `packages/core/src/db/adapters/postgres.ts` (`postgresDialect.nowPlusSeconds`)
- DB layer (P4-A): `packages/core/src/db/coordinator-runs.ts`, `coordinator-tasks.ts`, `coordinator-claims.ts`
- DB layer barrel: `packages/core/src/db/index.ts`
- Server routes (P4-A): `packages/server/src/routes/api.ts`, `packages/server/src/routes/schemas/coordinator.schemas.ts`
- Roadmap entry: `ROADMAP.md` §"P4 - Multi-Root Coordinator Architecture" (lines 123–154)
- Operating rule: `ROADMAP.md` §"Operating Rule For Dogfooding" (lines 199–212)
- Pattern reference: `migrations/008_workflow_runs.sql` (table-creation style),
  `migrations/011_partial_unique_constraint.sql` (partial-unique-index pattern),
  `migrations/015_background_dispatch.sql` (additive ALTER pattern)

---

## 8. P4-A acceptance matrix

The roadmap §P4 names four acceptance criteria. P4-A satisfies the
*persistence* foundation for each; runtime/UI satisfaction follows in P4-B/C/D.

| Roadmap criterion | P4-A delivers | Surface in later slices |
|-------------------|---------------|-------------------------|
| One user can open multiple root chat windows against the same repo | `coordinator_runs` rows are not unique by `codebase_id`; multiple rows per repo are explicitly allowed | UI affordance to open multiple roots — P4-D |
| Each root can dispatch independent worker runs without clobbering another root's claims | Partial unique index `unique_active_task_claim` guarantees at most one active claim per task across all roots; `max_parallel_workers` is per-`coordinator_run` so two roots have independent budgets | Dispatcher that reads `coordinator_runs.max_parallel_workers` and calls `claimTask` — P4-B |
| Status surfaces show roots, child workers, dependencies, blockers, and PRs | Schema captures all five: `coordinator_runs` (roots), `claims.worker_run_id` (child workers), `tasks.depends_on` (dependencies), `tasks.state = 'blocked'` (blockers), `tasks.evidence.pr_url` (PRs) | Status surface in CLI — P4-C; in Web UI — P4-D |
| Crash/restart/resume of coordinator-owned task graphs | `releaseExpiredClaims()` exists; `tasks.state` is durable; the partial-unique-index is the recovery anchor | Wiring of `releaseExpiredClaims()` into server start — P4-B |

All four roadmap criteria are *expressible* against the P4-A schema. P4-A is
the schema slice; the surface slices are P4-B/C/D.
