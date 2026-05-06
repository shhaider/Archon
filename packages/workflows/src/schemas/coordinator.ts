/**
 * Zod schemas for coordinator runs, tasks, and claims (P4-A).
 * See: docs/adr/0001-multi-root-coordinator-model.md
 *
 * Mirror of `packages/workflows/src/schemas/workflow-run.ts` shape:
 *   status enums → record-shape consts → object schemas → exhaustiveness assertion.
 *
 * Schema validates SHAPE only. Graph-level invariants (cycle detection, unknown
 * dependency IDs, dependency-satisfaction checks) live in DB-module imperative
 * code, not in Zod refinements (mirrors the dagNodeSchema vs validateDagStructure
 * split documented in CLAUDE.md).
 */
import { z } from '@hono/zod-openapi';

// ---------------------------------------------------------------------------
// CoordinatorRunStatus
// ---------------------------------------------------------------------------

export const coordinatorRunStatusSchema = z.enum([
  'planning',
  'active',
  'paused',
  'completed',
  'abandoned',
]);

export type CoordinatorRunStatus = z.infer<typeof coordinatorRunStatusSchema>;

/** Statuses that indicate a coordinator run has finished and cannot transition further. */
export const TERMINAL_COORDINATOR_RUN_STATUSES: readonly CoordinatorRunStatus[] = [
  'completed',
  'abandoned',
] as const;

// ---------------------------------------------------------------------------
// CoordinatorTaskState
// ---------------------------------------------------------------------------

export const coordinatorTaskStateSchema = z.enum([
  'blocked',
  'ready',
  'claimed',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

export type CoordinatorTaskState = z.infer<typeof coordinatorTaskStateSchema>;

/** Task states that indicate the task has finished and cannot transition further. */
export const TERMINAL_COORDINATOR_TASK_STATES: readonly CoordinatorTaskState[] = [
  'completed',
  'cancelled',
] as const;

/** Task states where a worker is currently doing work for this task. */
export const ACTIVE_COORDINATOR_TASK_STATES: readonly CoordinatorTaskState[] = [
  'claimed',
  'running',
] as const;

// ---------------------------------------------------------------------------
// ClaimOutcome
// ---------------------------------------------------------------------------

export const claimOutcomeSchema = z.enum(['succeeded', 'failed', 'abandoned', 'expired']);

export type ClaimOutcome = z.infer<typeof claimOutcomeSchema>;

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * Typed evidence emitted by a worker on claim release.
 * All fields optional; the schema constrains the SHAPE of evidence rather than
 * mandating any particular field. P3-A's "real-execution proof" wiring decides
 * which fields are required for which task types.
 */
export const evidenceSchema = z.object({
  commit_sha: z.string().optional(),
  pushed_branch: z.string().optional(),
  pr_url: z.string().url().optional(),
  changed_files: z.array(z.string()).optional(),
  test_output: z.string().optional(),
  workflow_run_ids: z.array(z.string()).optional(),
  notes: z.string().optional(),
});

export type Evidence = z.infer<typeof evidenceSchema>;

// ---------------------------------------------------------------------------
// CoordinatorRun
// ---------------------------------------------------------------------------

/**
 * Runtime coordinator-run state stored in database.
 */
export const coordinatorRunSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  codebase_id: z.string(),
  parent_run_id: z.string().nullable(),
  name: z.string(),
  status: coordinatorRunStatusSchema,
  max_parallel_workers: z.number().int().positive(),
  metadata: z.record(z.unknown()),
  created_at: z.date(),
  updated_at: z.date(),
  completed_at: z.date().nullable(),
});

export type CoordinatorRun = z.infer<typeof coordinatorRunSchema>;

// ---------------------------------------------------------------------------
// CoordinatorTask
// ---------------------------------------------------------------------------

/**
 * Node in a coordinator-run's task DAG.
 *
 * `depends_on` validates as `z.array(z.string())` at the schema layer.
 * Graph-level checks (cycles, unknown task IDs, "are all deps complete?") live
 * in DB-module imperative code (`arePrerequisitesMet`, `getReadyTasks`), NOT
 * in Zod refinements — same split as `dagNodeSchema` vs `validateDagStructure`.
 */
export const coordinatorTaskSchema = z.object({
  id: z.string(),
  coordinator_run_id: z.string(),
  external_key: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  state: coordinatorTaskStateSchema,
  depends_on: z.array(z.string()),
  evidence: evidenceSchema,
  metadata: z.record(z.unknown()),
  created_at: z.date(),
  updated_at: z.date(),
  started_at: z.date().nullable(),
  completed_at: z.date().nullable(),
});

export type CoordinatorTask = z.infer<typeof coordinatorTaskSchema>;

// ---------------------------------------------------------------------------
// CoordinatorTaskClaim
// ---------------------------------------------------------------------------

/**
 * Lease + audit-trail row for a worker's attempt to claim a task.
 *
 * Invariant: `UNIQUE (task_id) WHERE released_at IS NULL` — at most one active
 * claim per task. Enforced at the DB layer (Postgres partial unique index +
 * SQLite partial unique index). Application code MUST insert first and catch
 * the unique-violation; the pre-check + insert pattern is a TOCTOU race.
 */
export const coordinatorTaskClaimSchema = z.object({
  id: z.string(),
  task_id: z.string(),
  coordinator_run_id: z.string(),
  worker_run_id: z.string().nullable(),
  worker_label: z.string().nullable(),
  claimed_at: z.date(),
  lease_expires_at: z.date(),
  released_at: z.date().nullable(),
  outcome: claimOutcomeSchema.nullable(),
  metadata: z.record(z.unknown()),
});

export type CoordinatorTaskClaim = z.infer<typeof coordinatorTaskClaimSchema>;

// ---------------------------------------------------------------------------
// Compile-time exhaustiveness assertions.
// If a status enum gains a new value, the assignment becomes a type error —
// surfacing as a reminder to update terminal/active state lists.
// Mirrors workflow-run.ts:163-169.
// ---------------------------------------------------------------------------

type AssertCoordinatorRunStatusIsString = CoordinatorRunStatus extends string ? true : never;
const coordinatorRunStatusIsString: AssertCoordinatorRunStatusIsString = true;
void coordinatorRunStatusIsString; // suppress unused-variable lint warning

type AssertCoordinatorTaskStateIsString = CoordinatorTaskState extends string ? true : never;
const coordinatorTaskStateIsString: AssertCoordinatorTaskStateIsString = true;
void coordinatorTaskStateIsString;

type AssertClaimOutcomeIsString = ClaimOutcome extends string ? true : never;
const claimOutcomeIsString: AssertClaimOutcomeIsString = true;
void claimOutcomeIsString;
