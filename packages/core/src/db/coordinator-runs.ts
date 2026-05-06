/**
 * Database operations for coordinator runs (P4-A).
 *
 * Mirrors `packages/core/src/db/workflows.ts` patterns:
 *   - lazy `getLog()`
 *   - `pool.query<T>()` + `getDialect()`
 *   - `INSERT … RETURNING *`
 *   - `normalize*` helper for JSONB-string-on-SQLite columns
 *   - terminal-status guard mirrors `isolation-environments.ts:107-124`
 *
 * See: docs/adr/0001-multi-root-coordinator-model.md
 */
import { pool, getDialect } from './connection';
import type { CoordinatorRun, CoordinatorRunStatus } from '@archon/workflows/schemas/coordinator';
import { TERMINAL_COORDINATOR_RUN_STATUSES } from '@archon/workflows/schemas/coordinator';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.coordinator-runs');
  return cachedLog;
}

/**
 * Normalize a CoordinatorRun row from the database.
 * SQLite stores JSONB columns as TEXT; PostgreSQL returns parsed objects.
 */
function normalizeCoordinatorRun<T extends CoordinatorRun>(row: T): T {
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
 * Create a new coordinator run.
 * Returns the inserted row with all default columns populated.
 */
export async function createCoordinatorRun(data: {
  conversation_id: string;
  codebase_id: string;
  name: string;
  parent_run_id?: string;
  max_parallel_workers?: number;
  metadata?: Record<string, unknown>;
}): Promise<CoordinatorRun> {
  const metadataJson = JSON.stringify(data.metadata ?? {});

  try {
    const result = await pool.query<CoordinatorRun>(
      `INSERT INTO remote_agent_coordinator_runs
       (conversation_id, codebase_id, parent_run_id, name, max_parallel_workers, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        data.conversation_id,
        data.codebase_id,
        data.parent_run_id ?? null,
        data.name,
        data.max_parallel_workers ?? 3,
        metadataJson,
      ]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(
        `Failed to create coordinator run: INSERT returned no rows (name: ${data.name})`
      );
    }
    return normalizeCoordinatorRun(row);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.coordinator_run_create_failed');
    throw new Error(`Failed to create coordinator run: ${err.message}`);
  }
}

/**
 * Get a coordinator run by id. Returns null if not found.
 */
export async function getCoordinatorRun(id: string): Promise<CoordinatorRun | null> {
  try {
    const result = await pool.query<CoordinatorRun>(
      'SELECT * FROM remote_agent_coordinator_runs WHERE id = $1',
      [id]
    );
    const row = result.rows[0];
    return row ? normalizeCoordinatorRun(row) : null;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.coordinator_run_get_failed');
    throw new Error(`Failed to get coordinator run: ${err.message}`);
  }
}

/**
 * List coordinator runs with optional filters.
 * Mirrors `listWorkflowRuns` dynamic-WHERE pattern.
 */
export async function listCoordinatorRuns(options?: {
  conversationId?: string;
  codebaseId?: string;
  status?: CoordinatorRunStatus | CoordinatorRunStatus[];
  limit?: number;
  offset?: number;
}): Promise<CoordinatorRun[]> {
  const whereClauses: string[] = [];
  const values: unknown[] = [];

  if (options?.conversationId) {
    values.push(options.conversationId);
    whereClauses.push(`conversation_id = $${String(values.length)}`);
  }
  if (options?.codebaseId) {
    values.push(options.codebaseId);
    whereClauses.push(`codebase_id = $${String(values.length)}`);
  }
  if (options?.status !== undefined) {
    const statuses = Array.isArray(options.status) ? options.status : [options.status];
    if (statuses.length > 0) {
      const startIdx = values.length + 1;
      values.push(...statuses);
      const placeholders = statuses.map((_, i) => `$${String(startIdx + i)}`).join(', ');
      whereClauses.push(`status IN (${placeholders})`);
    }
  }

  const limit = options?.limit ?? 50;
  values.push(limit);
  const limitParam = `$${String(values.length)}`;

  const offset = options?.offset ?? 0;
  values.push(offset);
  const offsetParam = `$${String(values.length)}`;

  const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  try {
    const result = await pool.query<CoordinatorRun>(
      `SELECT * FROM remote_agent_coordinator_runs ${whereStr}
       ORDER BY created_at DESC LIMIT ${limitParam} OFFSET ${offsetParam}`,
      values
    );
    return result.rows.map(normalizeCoordinatorRun);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.coordinator_run_list_failed');
    throw new Error(`Failed to list coordinator runs: ${err.message}`);
  }
}

/**
 * Update a coordinator run's status.
 *
 * Terminal-status guard: mirrors `isolation-environments.ts:107-124`'s
 * `rowCount === 0` throw pattern. Specifically:
 *   - rejects transitions OUT of a terminal state (the `WHERE status NOT IN`
 *     clause filters them at the SQL layer; rowCount===0 then throws)
 *   - auto-sets `completed_at` when the new status is terminal
 *   - merges metadata via `dialect.jsonMerge` (does NOT replace) when provided
 */
export async function updateCoordinatorRunStatus(
  id: string,
  newStatus: CoordinatorRunStatus,
  metadata?: Record<string, unknown>
): Promise<void> {
  const dialect = getDialect();

  const setClauses: string[] = ['status = $1'];
  const values: unknown[] = [newStatus];

  if (TERMINAL_COORDINATOR_RUN_STATUSES.includes(newStatus)) {
    setClauses.push(`completed_at = ${dialect.now()}`);
  }
  setClauses.push(`updated_at = ${dialect.now()}`);

  if (metadata !== undefined) {
    values.push(JSON.stringify(metadata));
    setClauses.push(`metadata = ${dialect.jsonMerge('metadata', values.length)}`);
  }

  values.push(id);
  const idParam = `$${String(values.length)}`;

  // Terminal-status guard: refuse to transition OUT of a terminal state.
  // The placeholder list for the IN clause is built from the constant array.
  const terminalStartIdx = values.length + 1;
  values.push(...TERMINAL_COORDINATOR_RUN_STATUSES);
  const terminalPlaceholders = TERMINAL_COORDINATOR_RUN_STATUSES.map(
    (_, i) => `$${String(terminalStartIdx + i)}`
  ).join(', ');

  try {
    const result = await pool.query(
      `UPDATE remote_agent_coordinator_runs
       SET ${setClauses.join(', ')}
       WHERE id = ${idParam} AND status NOT IN (${terminalPlaceholders})`,
      values
    );
    if (result.rowCount === 0) {
      // Either the run doesn't exist, or it's already terminal.
      throw new Error(
        `Failed to update coordinator run status: no run found with id '${id}' or run is already terminal`
      );
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('Failed to update coordinator run status:')
    ) {
      throw error;
    }
    const err = error as Error;
    getLog().error({ err, runId: id, newStatus }, 'db.coordinator_run_update_status_failed');
    throw new Error(`Failed to update coordinator run status: ${err.message}`);
  }
}

/**
 * Delete a coordinator run by id. Cascades to tasks and claims via FK.
 * Returns whether the row was deleted.
 */
export async function deleteCoordinatorRun(id: string): Promise<boolean> {
  try {
    const result = await pool.query('DELETE FROM remote_agent_coordinator_runs WHERE id = $1', [
      id,
    ]);
    return (result.rowCount ?? 0) > 0;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, runId: id }, 'db.coordinator_run_delete_failed');
    throw new Error(`Failed to delete coordinator run: ${err.message}`);
  }
}
