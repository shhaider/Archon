/**
 * Database operations for coordinator tasks (P4-A).
 *
 * Mirrors `packages/core/src/db/workflows.ts` patterns:
 *   - lazy `getLog()`
 *   - `pool.query<T>()` + `getDialect()`
 *   - `INSERT … RETURNING *`
 *   - `normalize*` helper for JSONB-string-on-SQLite columns (`depends_on`,
 *     `evidence`, `metadata` are all JSONB on PG and TEXT on SQLite)
 *   - `transitionTaskState` mirrors `isolation-environments.ts:107-124` for
 *     the `rowCount === 0` throw pattern
 *
 * Schema-vs-graph split (per CLAUDE.md): cycle detection, unknown-id checks,
 * and other graph-level invariants live OUTSIDE this module (route handler in
 * batch 3). Here we expose primitives only:
 *   - createCoordinatorTask: persists, no graph validation
 *   - arePrerequisitesMet(taskId, allTasks): pure helper, no DB calls
 *   - getReadyTasks(coordinatorRunId): "state = 'ready' AND no active claim"
 *   - transitionTaskState: guarded UPDATE with terminal-state refusal
 *   - recordEvidence: MERGES via dialect.jsonMerge (does NOT replace)
 *
 * See: docs/adr/0001-multi-root-coordinator-model.md
 */
import { pool, getDialect } from './connection';
import type {
  CoordinatorTask,
  CoordinatorTaskState,
  Evidence,
} from '@archon/workflows/schemas/coordinator';
import { TERMINAL_COORDINATOR_TASK_STATES } from '@archon/workflows/schemas/coordinator';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.coordinator-tasks');
  return cachedLog;
}

/**
 * Normalize a CoordinatorTask row from the database.
 * SQLite stores JSONB columns as TEXT; PostgreSQL returns parsed objects.
 *
 * Three columns need normalization:
 *   - `depends_on` (string array of UUIDs)
 *   - `evidence` (typed object)
 *   - `metadata` (record)
 */
function normalizeCoordinatorTask<T extends CoordinatorTask>(row: T): T {
  if (typeof row.depends_on === 'string') {
    try {
      row.depends_on = JSON.parse(row.depends_on) as string[];
    } catch {
      row.depends_on = [];
    }
  }
  if (typeof row.evidence === 'string') {
    try {
      row.evidence = JSON.parse(row.evidence) as Evidence;
    } catch {
      row.evidence = {};
    }
  }
  if (typeof row.metadata === 'string') {
    try {
      row.metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      row.metadata = {};
    }
  }
  return row;
}

/**
 * Create a new coordinator task.
 *
 * Default state derivation:
 *   - empty `depends_on` → `'ready'` (immediately dispatchable)
 *   - non-empty `depends_on` → `'blocked'` (orchestrator promotes when satisfied)
 *
 * Cycle detection / unknown-dep-id detection are NOT performed here — graph-level
 * validation lives in the route handler (CLAUDE.md schema-vs-graph split).
 */
export async function createCoordinatorTask(data: {
  coordinator_run_id: string;
  external_key: string;
  title: string;
  body?: string;
  depends_on?: string[];
  metadata?: Record<string, unknown>;
}): Promise<CoordinatorTask> {
  const dependsOn = data.depends_on ?? [];
  const initialState: CoordinatorTaskState = dependsOn.length > 0 ? 'blocked' : 'ready';
  const dependsOnJson = JSON.stringify(dependsOn);
  const metadataJson = JSON.stringify(data.metadata ?? {});

  try {
    const result = await pool.query<CoordinatorTask>(
      `INSERT INTO remote_agent_coordinator_tasks
       (coordinator_run_id, external_key, title, body, state, depends_on, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        data.coordinator_run_id,
        data.external_key,
        data.title,
        data.body ?? null,
        initialState,
        dependsOnJson,
        metadataJson,
      ]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(
        `Failed to create coordinator task: INSERT returned no rows (key: ${data.external_key})`
      );
    }
    return normalizeCoordinatorTask(row);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.coordinator_task_create_failed');
    throw new Error(`Failed to create coordinator task: ${err.message}`);
  }
}

/**
 * Get a coordinator task by id. Returns null if not found.
 */
export async function getCoordinatorTask(id: string): Promise<CoordinatorTask | null> {
  try {
    const result = await pool.query<CoordinatorTask>(
      'SELECT * FROM remote_agent_coordinator_tasks WHERE id = $1',
      [id]
    );
    const row = result.rows[0];
    return row ? normalizeCoordinatorTask(row) : null;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.coordinator_task_get_failed');
    throw new Error(`Failed to get coordinator task: ${err.message}`);
  }
}

/**
 * List coordinator tasks (without coordinator-run filter).
 * Mirrors `listWorkflowRuns` shape, but for coordinator-tasks specifically.
 */
export async function listCoordinatorTasks(options?: {
  coordinatorRunId?: string;
  state?: CoordinatorTaskState | CoordinatorTaskState[];
  limit?: number;
}): Promise<CoordinatorTask[]> {
  const whereClauses: string[] = [];
  const values: unknown[] = [];

  if (options?.coordinatorRunId) {
    values.push(options.coordinatorRunId);
    whereClauses.push(`coordinator_run_id = $${String(values.length)}`);
  }
  if (options?.state !== undefined) {
    const states = Array.isArray(options.state) ? options.state : [options.state];
    if (states.length > 0) {
      const startIdx = values.length + 1;
      values.push(...states);
      const placeholders = states.map((_, i) => `$${String(startIdx + i)}`).join(', ');
      whereClauses.push(`state IN (${placeholders})`);
    }
  }

  const limit = options?.limit ?? 200;
  values.push(limit);
  const limitParam = `$${String(values.length)}`;

  const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  try {
    const result = await pool.query<CoordinatorTask>(
      `SELECT * FROM remote_agent_coordinator_tasks ${whereStr}
       ORDER BY created_at ASC LIMIT ${limitParam}`,
      values
    );
    return result.rows.map(normalizeCoordinatorTask);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.coordinator_task_list_failed');
    throw new Error(`Failed to list coordinator tasks: ${err.message}`);
  }
}

/**
 * List all tasks for a single coordinator run, ordered by created_at.
 * Convenience wrapper over `listCoordinatorTasks({ coordinatorRunId })`.
 */
export async function listCoordinatorTasksByRun(
  coordinatorRunId: string
): Promise<CoordinatorTask[]> {
  return listCoordinatorTasks({ coordinatorRunId, limit: 1000 });
}

/**
 * Pure helper: returns true iff every task ID in `task.depends_on` exists in
 * `allTasks` AND each of those dependency tasks is in state `'completed'`.
 *
 * Returns false if:
 *   - any dep ID is missing from `allTasks` (orphaned-dep guard)
 *   - any dep is in any state other than `'completed'` (including 'failed',
 *     'cancelled', 'blocked', 'ready', 'claimed', 'running')
 *
 * This is the contract the orchestrator (P4-B) calls before promoting a
 * blocked task to ready.
 */
export function arePrerequisitesMet(
  task: Pick<CoordinatorTask, 'depends_on'>,
  allTasks: readonly Pick<CoordinatorTask, 'id' | 'state'>[]
): boolean {
  if (task.depends_on.length === 0) return true;
  const byId = new Map(allTasks.map(t => [t.id, t]));
  for (const depId of task.depends_on) {
    const dep = byId.get(depId);
    if (!dep) return false; // orphaned dep
    if (dep.state !== 'completed') return false;
  }
  return true;
}

/**
 * Return tasks for a coordinator run that are:
 *   1. in state `'ready'` (already promoted by orchestrator), AND
 *   2. have no active (un-released) claim row
 *
 * Dependency-closure verification is the orchestrator's responsibility (use
 * `arePrerequisitesMet` before transitioning to `'ready'`); this query trusts
 * the state column.
 *
 * Active-claim filtering uses NOT EXISTS against the partial-unique-indexed
 * claims table, which has `idx_coordinator_claims_run_active` to back the
 * `released_at IS NULL` predicate.
 */
export async function getReadyTasks(coordinatorRunId: string): Promise<CoordinatorTask[]> {
  try {
    const result = await pool.query<CoordinatorTask>(
      `SELECT t.* FROM remote_agent_coordinator_tasks t
       WHERE t.coordinator_run_id = $1
         AND t.state = 'ready'
         AND NOT EXISTS (
           SELECT 1 FROM remote_agent_coordinator_task_claims c
           WHERE c.task_id = t.id AND c.released_at IS NULL
         )
       ORDER BY t.created_at ASC`,
      [coordinatorRunId]
    );
    return result.rows.map(normalizeCoordinatorTask);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, coordinatorRunId }, 'db.coordinator_task_get_ready_failed');
    throw new Error(`Failed to get ready coordinator tasks: ${err.message}`);
  }
}

/**
 * Atomic guarded state transition.
 *
 * Refuses to transition OUT of a terminal state (the `WHERE state NOT IN`
 * clause filters them at the SQL layer; `rowCount === 0` then throws —
 * mirroring `isolation-environments.ts` `updateStatus` pattern).
 *
 * Auto-sets:
 *   - `started_at` when transitioning into `'running'` (only if NULL)
 *   - `completed_at` when transitioning into a terminal state
 *   - `updated_at` always
 */
export async function transitionTaskState(
  taskId: string,
  newState: CoordinatorTaskState
): Promise<void> {
  const dialect = getDialect();

  const setClauses: string[] = ['state = $1', `updated_at = ${dialect.now()}`];
  if (newState === 'running') {
    // COALESCE preserves the original started_at on retransition.
    setClauses.push(`started_at = COALESCE(started_at, ${dialect.now()})`);
  }
  if (TERMINAL_COORDINATOR_TASK_STATES.includes(newState)) {
    setClauses.push(`completed_at = ${dialect.now()}`);
  }

  const values: unknown[] = [newState, taskId];
  const idParam = '$2';

  // Refuse to transition OUT of a terminal state.
  const terminalStartIdx = values.length + 1;
  values.push(...TERMINAL_COORDINATOR_TASK_STATES);
  const terminalPlaceholders = TERMINAL_COORDINATOR_TASK_STATES.map(
    (_, i) => `$${String(terminalStartIdx + i)}`
  ).join(', ');

  try {
    const result = await pool.query(
      `UPDATE remote_agent_coordinator_tasks
       SET ${setClauses.join(', ')}
       WHERE id = ${idParam} AND state NOT IN (${terminalPlaceholders})`,
      values
    );
    if (result.rowCount === 0) {
      throw new Error(
        `Failed to transition coordinator task: no task found with id '${taskId}' or task is already terminal`
      );
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('Failed to transition coordinator task:')
    ) {
      throw error;
    }
    const err = error as Error;
    getLog().error({ err, taskId, newState }, 'db.coordinator_task_transition_failed');
    throw new Error(`Failed to transition coordinator task: ${err.message}`);
  }
}

/**
 * MERGE evidence into a task's evidence column.
 *
 * Uses `dialect.jsonMerge('evidence', N)` to combine existing keys with
 * new ones. Does NOT replace — keys absent from `evidence` retain their
 * existing values.
 *
 * This is the contract a worker uses on success to record commit SHA, PR URL,
 * test output, etc. without clobbering anything a previous attempt wrote.
 */
export async function recordEvidence(taskId: string, evidence: Evidence): Promise<void> {
  const dialect = getDialect();
  try {
    const result = await pool.query(
      `UPDATE remote_agent_coordinator_tasks
       SET evidence = ${dialect.jsonMerge('evidence', 1)},
           updated_at = ${dialect.now()}
       WHERE id = $2`,
      [JSON.stringify(evidence), taskId]
    );
    if (result.rowCount === 0) {
      throw new Error(`Coordinator task not found (id: ${taskId})`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Coordinator task not found')) {
      throw error;
    }
    const err = error as Error;
    getLog().error({ err, taskId }, 'db.coordinator_task_record_evidence_failed');
    throw new Error(`Failed to record evidence: ${err.message}`);
  }
}
