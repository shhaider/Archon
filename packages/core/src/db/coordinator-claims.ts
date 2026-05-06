/**
 * Database operations for coordinator task claims (P4-A) — the invariant-bearing
 * core of the coordinator model.
 *
 * Invariants enforced here:
 *   1. At most one ACTIVE claim per task. Enforced by the partial unique index
 *      `unique_active_task_claim ON ... (task_id) WHERE released_at IS NULL`
 *      on both Postgres (SQLSTATE 23505) and SQLite (SQLITE_CONSTRAINT_UNIQUE).
 *      `claimTask` MUST insert first and catch the violation; pre-checking via
 *      `getActiveClaimForTask` and then INSERTing is a TOCTOU race.
 *
 *   2. Lease expiry is computed in SQL using `dialect.nowPlusSeconds(N)` —
 *      NEVER in JavaScript. Application clock skew can produce phantom
 *      lease-already-expired situations that the DB clock would not.
 *
 *   3. `recordEvidence` is fan-out from `releaseClaim` on `outcome === 'succeeded'`
 *      — uses `dialect.jsonMerge` (does NOT replace).
 *
 * Mirrors `packages/core/src/db/workflows.ts:911-932` `failOrphanedRuns`
 * pattern for the server-start sweep (`releaseExpiredClaims`).
 *
 * See: docs/adr/0001-multi-root-coordinator-model.md
 */
import { pool, getDialect, getDatabaseType } from './connection';
import * as coordinatorTaskDb from './coordinator-tasks';
import type {
  CoordinatorTaskClaim,
  ClaimOutcome,
  Evidence,
} from '@archon/workflows/schemas/coordinator';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.coordinator-claims');
  return cachedLog;
}

/**
 * Normalize a CoordinatorTaskClaim row.
 * SQLite stores `metadata` as TEXT; PostgreSQL returns parsed objects.
 */
function normalizeClaim<T extends CoordinatorTaskClaim>(row: T): T {
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
 * Detect a partial-unique-index violation across both DB backends.
 * Postgres: `code === '23505'` (SQLSTATE for unique-violation).
 * SQLite (`bun:sqlite`): error message contains `'unique constraint'` (case-insensitive).
 *
 * Implementation note: we use a case-insensitive substring match against
 * `'unique constraint'` because bun:sqlite emits messages like
 * `"UNIQUE constraint failed: remote_agent_coordinator_task_claims.task_id"`.
 */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  if (getDatabaseType() === 'postgresql') {
    return e.code === '23505';
  }
  return typeof e.message === 'string' && e.message.toLowerCase().includes('unique constraint');
}

/**
 * Attempt to claim a task. Returns the new claim row on success, or `null` if
 * the task already has an active claim (the partial-unique-index violation
 * signal — that's the "someone else got it" case the orchestrator's
 * dispatcher loop will treat as "pick the next ready task").
 *
 * `leaseSeconds` is the lease duration. `lease_expires_at` is computed in SQL
 * via `dialect.nowPlusSeconds(N)` — NEVER in JS — so the clock that gates
 * `releaseExpiredClaims` is the same clock that minted the lease.
 *
 * Other DB errors (connection lost, FK violation, etc.) are re-thrown.
 */
export async function claimTask(opts: {
  taskId: string;
  coordinatorRunId: string;
  workerRunId?: string;
  workerLabel?: string;
  leaseSeconds: number;
}): Promise<CoordinatorTaskClaim | null> {
  const dialect = getDialect();

  // SQL params: $1=task_id, $2=coordinator_run_id, $3=worker_run_id (nullable),
  // $4=worker_label (nullable), $5=leaseSeconds (used by dialect.nowPlusSeconds)
  const sql = `INSERT INTO remote_agent_coordinator_task_claims
     (task_id, coordinator_run_id, worker_run_id, worker_label, lease_expires_at)
     VALUES ($1, $2, $3, $4, ${dialect.nowPlusSeconds(5)})
     RETURNING *`;
  const params = [
    opts.taskId,
    opts.coordinatorRunId,
    opts.workerRunId ?? null,
    opts.workerLabel ?? null,
    opts.leaseSeconds,
  ];

  try {
    const result = await pool.query<CoordinatorTaskClaim>(sql, params);
    const row = result.rows[0];
    if (!row) {
      throw new Error(
        `Failed to claim coordinator task: INSERT returned no rows (taskId: ${opts.taskId})`
      );
    }
    return normalizeClaim(row);
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Task already has an active claim — return null so the dispatcher can
      // try the next ready task.
      getLog().debug(
        { taskId: opts.taskId, coordinatorRunId: opts.coordinatorRunId },
        'db.coordinator_claim_unique_violation'
      );
      return null;
    }
    const err = error as Error;
    getLog().error(
      { err, taskId: opts.taskId, coordinatorRunId: opts.coordinatorRunId },
      'db.coordinator_claim_failed'
    );
    throw new Error(`Failed to claim coordinator task: ${err.message}`);
  }
}

/**
 * Release a claim with the given outcome.
 *
 * Idempotent: if the claim is already released (`released_at IS NOT NULL`),
 * the UPDATE matches zero rows and we return the existing row instead of
 * double-writing. The caller should treat the returned row as the final
 * claim state regardless of which call released it.
 *
 * On `outcome === 'succeeded'` and `evidence` provided, fans out to
 * `coordinatorTaskDb.recordEvidence(claim.task_id, evidence)`.
 */
export async function releaseClaim(
  claimId: string,
  opts: { outcome: ClaimOutcome; evidence?: Evidence }
): Promise<CoordinatorTaskClaim> {
  const dialect = getDialect();

  // Update first, only matching un-released rows.
  // SQLite does not support RETURNING on UPDATE; we split into UPDATE + SELECT.
  let updateResult: Awaited<ReturnType<typeof pool.query>>;
  try {
    updateResult = await pool.query(
      `UPDATE remote_agent_coordinator_task_claims
       SET released_at = ${dialect.now()}, outcome = $1
       WHERE id = $2 AND released_at IS NULL`,
      [opts.outcome, claimId]
    );
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, claimId }, 'db.coordinator_claim_release_failed');
    throw new Error(`Failed to release coordinator claim: ${err.message}`);
  }

  // Fetch the row regardless — needed for fan-out + return value.
  let selectResult: Awaited<ReturnType<typeof pool.query<CoordinatorTaskClaim>>>;
  try {
    selectResult = await pool.query<CoordinatorTaskClaim>(
      'SELECT * FROM remote_agent_coordinator_task_claims WHERE id = $1',
      [claimId]
    );
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, claimId }, 'db.coordinator_claim_release_select_failed');
    throw new Error(`Failed to read coordinator claim after release: ${err.message}`);
  }

  const row = selectResult.rows[0];
  if (!row) {
    throw new Error(`Coordinator claim not found (id: ${claimId})`);
  }
  const claim = normalizeClaim(row);

  // Fan-out to evidence recording — only on (a) we just released it (rowCount===1)
  // AND (b) succeeded outcome AND (c) evidence provided. If the row was already
  // released by an earlier call, we skip evidence-recording to keep release
  // idempotent and avoid evidence-clobber.
  if (updateResult.rowCount === 1 && opts.outcome === 'succeeded' && opts.evidence !== undefined) {
    try {
      await coordinatorTaskDb.recordEvidence(claim.task_id, opts.evidence);
    } catch (error) {
      const err = error as Error;
      // Evidence-recording failure should not unwind the release. Log and continue.
      getLog().error(
        { err, claimId, taskId: claim.task_id },
        'db.coordinator_claim_release_evidence_failed'
      );
    }
  }

  return claim;
}

/**
 * Extend an active claim's lease by `leaseSeconds`. Returns true if the lease
 * was extended (the row was active); false if the claim is already released
 * (no-op).
 *
 * `lease_expires_at` is computed in SQL via `dialect.nowPlusSeconds`, NOT in JS.
 */
export async function heartbeatClaim(claimId: string, leaseSeconds: number): Promise<boolean> {
  const dialect = getDialect();
  try {
    const result = await pool.query(
      `UPDATE remote_agent_coordinator_task_claims
       SET lease_expires_at = ${dialect.nowPlusSeconds(1)}
       WHERE id = $2 AND released_at IS NULL`,
      [leaseSeconds, claimId]
    );
    return (result.rowCount ?? 0) > 0;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, claimId }, 'db.coordinator_claim_heartbeat_failed');
    throw new Error(`Failed to heartbeat coordinator claim: ${err.message}`);
  }
}

/**
 * Sweep all active claims whose lease has expired in the DB clock and mark
 * them released with `outcome = 'expired'`. Mirrors the
 * `failOrphanedRuns` pattern from `workflows.ts:911-932`.
 *
 * Returns the count of claims released. Caller (server start, P4-B wiring) is
 * responsible for invoking this; the schema slice (P4-A) only exposes the
 * function.
 */
export async function releaseExpiredClaims(): Promise<{ count: number }> {
  const dialect = getDialect();
  try {
    const result = await pool.query(
      `UPDATE remote_agent_coordinator_task_claims
       SET released_at = ${dialect.now()}, outcome = 'expired'
       WHERE released_at IS NULL AND lease_expires_at < ${dialect.now()}`
    );
    const count = result.rowCount ?? 0;
    if (count > 0) {
      getLog().info({ count }, 'db.coordinator_claims_expired_swept');
    }
    return { count };
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'db.coordinator_claims_expire_sweep_failed');
    throw new Error(`Failed to release expired coordinator claims: ${err.message}`);
  }
}

/**
 * Count active (un-released) claims for a coordinator run.
 * Used to enforce `max_parallel_workers` in the dispatcher (P4-B).
 */
export async function countActiveClaimsForRun(coordinatorRunId: string): Promise<number> {
  try {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM remote_agent_coordinator_task_claims
       WHERE coordinator_run_id = $1 AND released_at IS NULL`,
      [coordinatorRunId]
    );
    return parseInt(result.rows[0]?.count ?? '0', 10);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, coordinatorRunId }, 'db.coordinator_claim_count_active_failed');
    throw new Error(`Failed to count active coordinator claims: ${err.message}`);
  }
}

/**
 * Get the active (un-released) claim for a task, or null if none.
 *
 * NOTE: Do NOT call this before `claimTask` as a "is-this-task-free" check —
 * that's a TOCTOU race. `claimTask` insert-first-catch-violation is the
 * correct path. This helper is for after-the-fact lookups (UI, audit, tests).
 */
export async function getActiveClaimForTask(taskId: string): Promise<CoordinatorTaskClaim | null> {
  try {
    const result = await pool.query<CoordinatorTaskClaim>(
      `SELECT * FROM remote_agent_coordinator_task_claims
       WHERE task_id = $1 AND released_at IS NULL
       LIMIT 1`,
      [taskId]
    );
    const row = result.rows[0];
    return row ? normalizeClaim(row) : null;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, taskId }, 'db.coordinator_claim_get_active_failed');
    throw new Error(`Failed to get active coordinator claim: ${err.message}`);
  }
}

/**
 * List the full claim history for a task (active + released) in chronological order.
 * Useful for audit trail / UI / tests.
 */
export async function listClaimsForTask(taskId: string): Promise<CoordinatorTaskClaim[]> {
  try {
    const result = await pool.query<CoordinatorTaskClaim>(
      `SELECT * FROM remote_agent_coordinator_task_claims
       WHERE task_id = $1
       ORDER BY claimed_at ASC`,
      [taskId]
    );
    return result.rows.map(normalizeClaim);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, taskId }, 'db.coordinator_claim_list_failed');
    throw new Error(`Failed to list coordinator claims: ${err.message}`);
  }
}
