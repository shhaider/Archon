/**
 * Standalone concurrency-test worker (NOT a test file — name does not match
 * `*.test.ts` so `bun test` ignores it). Spawned by sqlite-concurrency.test.ts
 * via `Bun.spawn` to reproduce the multi-process workload that surfaced the
 * original `database is locked` race:
 *
 *   archon workflow status   → SELECT remote_agent_workflow_runs
 *   archon isolation list    → SELECT remote_agent_isolation_environments
 *                              + UPDATE via reconcileGhosts
 *
 * Each worker opens a fresh SqliteAdapter against the DB path passed as
 * argv[2] and runs an INSERT + multi-SELECT + UPDATE workload mirroring the
 * two CLI commands above. workflow_id includes process.pid so concurrent
 * workers don't violate the partial unique index on active environments.
 *
 * Exit codes: 0 on success, 1 with stderr message on any caught error.
 */
import { SqliteAdapter } from './sqlite';

async function main(): Promise<void> {
  const dbPath = process.argv[2];
  if (!dbPath) {
    process.stderr.write('error: missing dbPath argv[2]\n');
    process.exit(1);
  }

  const db = new SqliteAdapter(dbPath);
  try {
    const codebaseId = 'concurrency-test-codebase';
    const workflowId = `wf-${String(process.pid)}`;
    const envId = `env-${String(process.pid)}`;

    // Shared parent codebase — INSERT OR IGNORE so multiple workers can
    // coexist without racing each other on the unique-id constraint.
    await db.query(
      `INSERT OR IGNORE INTO remote_agent_codebases (id, name, default_cwd)
       VALUES ($1, $2, $3)`,
      [codebaseId, 'concurrency-test', '/tmp/concurrency-test-cwd']
    );

    // Per-pid isolation env so the partial unique index on active envs
    // doesn't trip when N workers run in parallel.
    await db.query(
      `INSERT INTO remote_agent_isolation_environments
       (id, codebase_id, workflow_type, workflow_id, working_path, branch_name)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [envId, codebaseId, 'issue', workflowId, '/tmp/concurrency-worker', `branch-${workflowId}`]
    );

    // Mirror `archon workflow status`: bounded SELECT on workflow_runs.
    await db.query('SELECT * FROM remote_agent_workflow_runs LIMIT 100');

    // Mirror `archon isolation list`: SELECT WHERE status='active'.
    await db.query('SELECT * FROM remote_agent_isolation_environments WHERE status = $1', [
      'active',
    ]);

    // Mirror `reconcileGhosts` issuing an UPDATE during list — this is the
    // write that, racing across processes, used to trip the lock on dev.
    await db.query(
      `UPDATE remote_agent_isolation_environments
       SET status = $1
       WHERE workflow_id = $2`,
      ['destroyed', workflowId]
    );

    // Final flush SELECT to ensure the writes are visible from this handle
    // before close(). Mirrors the read-after-write pattern in the CLI.
    await db.query('SELECT * FROM remote_agent_isolation_environments WHERE workflow_id = $1', [
      workflowId,
    ]);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    await db.close();
    process.exit(1);
  }

  await db.close();
  process.exit(0);
}

void main();
