/**
 * SQLite adapter using bun:sqlite
 */
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { IDatabase, QueryResult, SqlDialect } from './types';
import { createLogger } from '@archon/paths';

/**
 * Bumped when the DDL block in `createSchema()` or `migrateColumns()` changes
 * in a way that requires re-running on existing DBs. `PRAGMA user_version` is
 * compared against this on every adapter open; when they match, schema init is
 * skipped entirely so concurrent CLI processes don't all fight over the
 * write-lock for an idempotent no-op.
 */
const CURRENT_SCHEMA_VERSION = 2;

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.sqlite');
  return cachedLog;
}

/**
 * Detect bun:sqlite's "database is locked" / SQLITE_BUSY family. Treats
 * SQLITE_LOCKED (shared-cache contention) the same as SQLITE_BUSY because the
 * retry strategy is identical for both.
 */
function isSqliteBusyError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = (e as Error & { code?: string }).code;
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return true;
  return /database is locked/i.test(e.message);
}

/**
 * Windows can surface a simultaneous first-open WAL activation race as
 * SQLITE_IOERR_TRUNCATE instead of SQLITE_BUSY. Treat that as retryable only
 * for the idempotent WAL PRAGMA; the same code elsewhere is a real disk I/O
 * failure and should not be hidden.
 */
function isSqliteRetryableError(label: string, e: unknown): boolean {
  if (isSqliteBusyError(e)) return true;
  if (!(e instanceof Error)) return false;

  const code = (e as Error & { code?: string }).code;
  return label === 'pragma-wal' && code === 'SQLITE_IOERR_TRUNCATE';
}

function retryDelaysFor(label: string): number[] {
  return label === 'pragma-wal' ? [50, 100, 250, 500, 1000, 2000] : [50, 150, 450];
}

export class SqliteAdapter implements IDatabase {
  private db: Database;
  readonly dialect = 'sqlite' as const;
  readonly sql: SqlDialect = sqliteDialect;

  constructor(dbPath: string) {
    // Ensure directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);

    // busy_timeout MUST be set first: it arbitrates every other PRAGMA / DDL
    // below. Setting WAL before busy_timeout means the WAL upgrade itself has
    // a zero retry budget against a concurrent writer, which is exactly the
    // race we hit when two CLI processes start simultaneously.
    this.db.run('PRAGMA busy_timeout = 5000');

    // Enable WAL mode for better concurrent read+write performance.
    // The WAL upgrade itself takes a write lock — when two processes open the
    // same fresh DB simultaneously, busy_timeout alone is not always enough
    // (observed: SQLITE_BUSY here even with timeout=5s). Route through the
    // retry helper as a backstop.
    this.runWithBusyRetry('pragma-wal', () => this.db.run('PRAGMA journal_mode = WAL'));

    // synchronous=NORMAL is the SQLite-recommended pairing with WAL: durable
    // across crashes, ~2-3× faster commits, only weakens durability of the
    // very last commit on hard power-loss (acceptable for a developer tool).
    this.db.run('PRAGMA synchronous = NORMAL');

    // Enable foreign keys
    this.db.run('PRAGMA foreign_keys = ON');

    // Initialize schema if needed
    this.initSchema();
  }

  /**
   * Retry a synchronous SQLite operation on SQLITE_BUSY / "database is locked".
   * `busy_timeout=5s` already covers most contention; this is a backstop for
   * the residual case where a writer holds the lock longer than that
   * (e.g., DDL on a slow disk, large WAL checkpoint). Bounded total wait of
   * ≤650ms, only spent on real contention — happy path pays nothing.
   */
  private runWithBusyRetry<T>(label: string, op: () => T): T {
    const delays = retryDelaysFor(label);
    let lastErr: unknown;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        return op();
      } catch (e) {
        lastErr = e;
        const retryable = isSqliteRetryableError(label, e);
        if (!retryable || attempt === delays.length) {
          if (retryable) {
            getLog().error(
              { err: e as Error, label, attempts: attempt + 1 },
              'db.sqlite_retry_exhausted'
            );
          }
          throw e;
        }
        const waitMs = delays[attempt];
        getLog().warn({ err: e as Error, label, attempt: attempt + 1, waitMs }, 'db.sqlite_retry');
        // Synchronous busy-wait: bun:sqlite's run/all/run are all sync, so an
        // `await setTimeout` in this hot path would force every SELECT to
        // yield even on success. The wait fires only on actual SQLITE_BUSY,
        // which by definition is already the slow path; ≤650ms is strictly
        // better than failing the way the unfixed code did.
        const start = Date.now();
        while (Date.now() - start < waitMs) {
          /* bounded busy-wait — only fires on real lock contention */
        }
      }
    }
    throw lastErr;
  }

  async query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    // Convert $1, $2, etc. to ? placeholders and reorder params to match
    const { sql: convertedSql, params: reorderedParams } = this.convertPlaceholders(
      sql,
      params ?? []
    );

    try {
      return this.runWithBusyRetry('query', () => {
        // Determine if this is a SELECT or mutation
        const trimmedSql = sql.trim().toUpperCase();
        const isSelect = trimmedSql.startsWith('SELECT') || trimmedSql.startsWith('WITH');

        // Cast params to SQLite's expected type
        const sqliteParams = reorderedParams as SQLQueryBindings[];

        if (isSelect) {
          const stmt = this.db.prepare(convertedSql);
          const rows = stmt.all(...sqliteParams) as T[];
          return { rows, rowCount: rows.length };
        } else {
          const upperSql = sql.toUpperCase();

          // Handle INSERT with RETURNING using native SQLite RETURNING (3.35+)
          // We must use .all() instead of .run() because .run() discards
          // RETURNING results, and its lastInsertRowid is unreliable when
          // ON CONFLICT DO UPDATE fires.
          if (upperSql.includes('RETURNING') && upperSql.includes('INSERT')) {
            const stmt = this.db.prepare(convertedSql);
            const rows = stmt.all(...sqliteParams) as T[];
            return { rows, rowCount: rows.length };
          }

          // UPDATE/DELETE with RETURNING not supported
          if (upperSql.includes('RETURNING')) {
            throw new Error(
              'SQLite adapter does not support RETURNING clause on UPDATE/DELETE statements. ' +
                `Query: ${convertedSql.substring(0, 100)}... ` +
                'Hint: Use a SELECT before the mutation if you need the row data.'
            );
          }

          // Standard INSERT/UPDATE/DELETE without RETURNING
          const stmt = this.db.prepare(convertedSql);
          const result = stmt.run(...sqliteParams);
          return { rows: [], rowCount: result.changes };
        }
      });
    } catch (error) {
      const err = error as Error;
      getLog().error({ err, sql: convertedSql, params }, 'db.sqlite_query_failed');
      throw error;
    }
  }

  async withTransaction<T>(
    fn: (query: <U>(sql: string, params?: unknown[]) => Promise<QueryResult<U>>) => Promise<T>
  ): Promise<T> {
    // Retry only the initial BEGIN — once we hold the transaction the inner
    // statements go through `query()` which already retries per-statement.
    // Retrying a partially-applied transaction is unsafe, so we don't.
    this.runWithBusyRetry('tx-begin', () => this.db.run('BEGIN'));
    try {
      const result = await fn(this.query.bind(this));
      await this.query('COMMIT');
      return result;
    } catch (e) {
      try {
        await this.query('ROLLBACK');
      } catch (rollbackError) {
        getLog().error({ err: rollbackError as Error }, 'db.sqlite_transaction_rollback_failed');
      }
      throw e;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }

  /**
   * Convert PostgreSQL $1, $2 placeholders to SQLite ? placeholders.
   *
   * PostgreSQL uses explicit indices ($1, $2) so params can appear in any order
   * in SQL. SQLite uses positional ? — so params must be reordered to match the
   * left-to-right order of placeholders in the SQL string.
   *
   * Example: SQL has "$2 ... $1" with params [id, json] →
   *   converted SQL: "? ... ?" with reordered params [json, id]
   */
  private convertPlaceholders(sql: string, params: unknown[]): { sql: string; params: unknown[] } {
    // Collect $N placeholders in order of appearance
    const placeholderOrder: number[] = [];
    const convertedSql = sql
      .replace(/\$(\d+)/g, (_match, indexStr: string) => {
        placeholderOrder.push(Number(indexStr));
        return '?';
      })
      .replace(/::jsonb/g, '')
      .replace(/::INTERVAL/g, '');

    // Reorder params to match the positional order of ? in the SQL.
    // $N is 1-based, so $1 → params[0], $2 → params[1], etc.
    const reordered =
      placeholderOrder.length > 0 ? placeholderOrder.map(idx => params[idx - 1]) : params;

    return { sql: convertedSql, params: reordered };
  }

  /**
   * Initialize database schema, gated by `PRAGMA user_version`.
   *
   * Concurrent CLI invocations all opened a fresh adapter and unconditionally
   * ran the DDL block — every CREATE/ALTER takes the write lock, so the second
   * process saw `SQLITE_BUSY`. This now reads `user_version` first; when it
   * matches `CURRENT_SCHEMA_VERSION` we return immediately (no lock taken).
   *
   * When a real upgrade is needed the DDL runs inside a single `BEGIN
   * IMMEDIATE` block. `busy_timeout` makes the loser of the race wait up to
   * 5s for the winner; once it gets the lock it re-reads `user_version`
   * inside the transaction and skips DDL if the winner already migrated.
   */
  private initSchema(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as
      | { user_version: number }
      | undefined;
    const currentVersion = row?.user_version ?? 0;

    if (currentVersion === CURRENT_SCHEMA_VERSION) {
      getLog().debug({ version: currentVersion }, 'db.sqlite_schema_skip_already_current');
      return;
    }

    getLog().info(
      { fromVersion: currentVersion, toVersion: CURRENT_SCHEMA_VERSION },
      'db.sqlite_schema_init_started'
    );

    this.db.run('BEGIN IMMEDIATE');
    try {
      // Re-check inside the transaction: if we lost the race for the lock,
      // the winner has already bumped user_version and we should skip DDL.
      const inner = this.db.prepare('PRAGMA user_version').get() as
        | { user_version: number }
        | undefined;
      if ((inner?.user_version ?? 0) === CURRENT_SCHEMA_VERSION) {
        this.db.run('COMMIT');
        getLog().info('db.sqlite_schema_skip_after_lock');
        return;
      }

      this.createSchema();
      this.migrateColumns();
      this.db.run(`PRAGMA user_version = ${String(CURRENT_SCHEMA_VERSION)}`);
      this.db.run('COMMIT');
      getLog().info({ version: CURRENT_SCHEMA_VERSION }, 'db.sqlite_schema_init_completed');
    } catch (e) {
      try {
        this.db.run('ROLLBACK');
      } catch {
        /* best-effort — original error is the one to surface */
      }
      throw e;
    }
  }

  /**
   * Add columns to existing tables that predate newer schema additions.
   * SQLite's CREATE TABLE IF NOT EXISTS skips entirely for existing tables,
   * so new columns must be added via ALTER TABLE for databases created before
   * the columns were added to createSchema().
   */
  private migrateColumns(): void {
    // Conversations columns
    try {
      const cols = this.db.prepare("PRAGMA table_info('remote_agent_conversations')").all() as {
        name: string;
      }[];
      const colNames = new Set(cols.map(c => c.name));

      if (!colNames.has('title')) {
        this.db.run('ALTER TABLE remote_agent_conversations ADD COLUMN title TEXT');
      }
      if (!colNames.has('deleted_at')) {
        this.db.run('ALTER TABLE remote_agent_conversations ADD COLUMN deleted_at TEXT');
      }
      if (!colNames.has('hidden')) {
        this.db.run('ALTER TABLE remote_agent_conversations ADD COLUMN hidden INTEGER DEFAULT 0');
      }
    } catch (e: unknown) {
      getLog().warn({ err: e as Error }, 'db.sqlite_migration_conversations_columns_failed');
    }

    // Workflow runs columns
    try {
      const wfCols = this.db.prepare("PRAGMA table_info('remote_agent_workflow_runs')").all() as {
        name: string;
      }[];
      const wfColNames = new Set(wfCols.map(c => c.name));

      if (!wfColNames.has('parent_conversation_id')) {
        this.db.run(
          'ALTER TABLE remote_agent_workflow_runs ADD COLUMN parent_conversation_id TEXT'
        );
      }

      if (!wfColNames.has('working_path')) {
        this.db.run('ALTER TABLE remote_agent_workflow_runs ADD COLUMN working_path TEXT');
      }
    } catch (e: unknown) {
      getLog().warn({ err: e as Error }, 'db.sqlite_migration_workflow_runs_columns_failed');
    }

    // Sessions columns
    try {
      const sessCols = this.db.prepare("PRAGMA table_info('remote_agent_sessions')").all() as {
        name: string;
      }[];
      const sessColNames = new Set(sessCols.map(c => c.name));

      if (!sessColNames.has('ended_reason')) {
        this.db.run('ALTER TABLE remote_agent_sessions ADD COLUMN ended_reason TEXT');
      }
    } catch (e: unknown) {
      getLog().warn({ err: e as Error }, 'db.sqlite_migration_session_columns_failed');
    }

    // Codebases columns (P4-A) — forward-compatible per-repo max-parallel cap
    try {
      const cbCols = this.db.prepare("PRAGMA table_info('remote_agent_codebases')").all() as {
        name: string;
      }[];
      const cbColNames = new Set(cbCols.map(c => c.name));

      if (!cbColNames.has('max_parallel_workers')) {
        this.db.run('ALTER TABLE remote_agent_codebases ADD COLUMN max_parallel_workers INTEGER');
      }
    } catch (e: unknown) {
      getLog().warn({ err: e as Error }, 'db.sqlite_migration_codebases_columns_failed');
    }
  }

  /**
   * Create all tables.
   *
   * NOTE: NOT NULL constraint changes on existing columns (e.g., branch_name in
   * isolation_environments, user_message in workflow_runs, name in codebases) are only
   * enforced for new databases. For existing databases, CREATE TABLE IF NOT EXISTS is a
   * no-op so the old schema remains. SQLite lacks ALTER COLUMN support; enforcing new
   * constraints on existing tables would require a table rebuild via migrateColumns().
   */
  private createSchema(): void {
    this.db.run(`
      -- Codebases table
      CREATE TABLE IF NOT EXISTS remote_agent_codebases (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        name TEXT NOT NULL,
        repository_url TEXT,
        default_cwd TEXT NOT NULL,
        default_branch TEXT DEFAULT 'main',
        ai_assistant_type TEXT DEFAULT 'claude',
        commands TEXT DEFAULT '{}',
        max_parallel_workers INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Codebase env vars table
      CREATE TABLE IF NOT EXISTS remote_agent_codebase_env_vars (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        codebase_id TEXT NOT NULL REFERENCES remote_agent_codebases(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(codebase_id, key)
      );

      -- Conversations table
      CREATE TABLE IF NOT EXISTS remote_agent_conversations (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        platform_type TEXT NOT NULL,
        platform_conversation_id TEXT NOT NULL,
        ai_assistant_type TEXT DEFAULT 'claude',
        codebase_id TEXT REFERENCES remote_agent_codebases(id) ON DELETE SET NULL,
        cwd TEXT,
        isolation_env_id TEXT,
        title TEXT,
        deleted_at TEXT,
        hidden INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        last_activity_at TEXT DEFAULT (datetime('now')),
        UNIQUE(platform_type, platform_conversation_id)
      );

      -- Sessions table
      CREATE TABLE IF NOT EXISTS remote_agent_sessions (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        conversation_id TEXT NOT NULL REFERENCES remote_agent_conversations(id) ON DELETE CASCADE,
        codebase_id TEXT REFERENCES remote_agent_codebases(id) ON DELETE SET NULL,
        ai_assistant_type TEXT NOT NULL DEFAULT 'claude',
        assistant_session_id TEXT,
        active INTEGER DEFAULT 1,
        metadata TEXT DEFAULT '{}',
        started_at TEXT DEFAULT (datetime('now')),
        ended_at TEXT,
        parent_session_id TEXT REFERENCES remote_agent_sessions(id),
        transition_reason TEXT,
        ended_reason TEXT
      );

      -- Isolation environments table
      CREATE TABLE IF NOT EXISTS remote_agent_isolation_environments (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        codebase_id TEXT NOT NULL REFERENCES remote_agent_codebases(id) ON DELETE CASCADE,
        workflow_type TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'worktree',
        working_path TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        created_by_platform TEXT,
        metadata TEXT DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
        -- Note: uniqueness enforced via partial index below (only active environments)
      );

      -- Partial unique index: only active environments need uniqueness
      CREATE UNIQUE INDEX IF NOT EXISTS unique_active_workflow
        ON remote_agent_isolation_environments (codebase_id, workflow_type, workflow_id)
        WHERE status = 'active';

      -- Coordinator runs table (P4-A) — see docs/adr/0001-multi-root-coordinator-model.md
      CREATE TABLE IF NOT EXISTS remote_agent_coordinator_runs (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        conversation_id TEXT NOT NULL REFERENCES remote_agent_conversations(id) ON DELETE CASCADE,
        codebase_id TEXT NOT NULL REFERENCES remote_agent_codebases(id) ON DELETE CASCADE,
        parent_run_id TEXT REFERENCES remote_agent_coordinator_runs(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'planning',
        max_parallel_workers INTEGER NOT NULL DEFAULT 3,
        metadata TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT
      );

      -- Coordinator tasks table (P4-A) — DAG nodes
      CREATE TABLE IF NOT EXISTS remote_agent_coordinator_tasks (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        coordinator_run_id TEXT NOT NULL REFERENCES remote_agent_coordinator_runs(id) ON DELETE CASCADE,
        external_key TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        state TEXT NOT NULL DEFAULT 'blocked',
        depends_on TEXT NOT NULL DEFAULT '[]',
        evidence TEXT NOT NULL DEFAULT '{}',
        metadata TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        started_at TEXT,
        completed_at TEXT,
        UNIQUE (coordinator_run_id, external_key)
      );

      -- Coordinator task claims table (P4-A) — lease + audit trail
      CREATE TABLE IF NOT EXISTS remote_agent_coordinator_task_claims (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        task_id TEXT NOT NULL REFERENCES remote_agent_coordinator_tasks(id) ON DELETE CASCADE,
        coordinator_run_id TEXT NOT NULL REFERENCES remote_agent_coordinator_runs(id) ON DELETE CASCADE,
        worker_run_id TEXT REFERENCES remote_agent_workflow_runs(id) ON DELETE SET NULL,
        worker_label TEXT,
        claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
        lease_expires_at TEXT NOT NULL,
        released_at TEXT,
        outcome TEXT,
        metadata TEXT DEFAULT '{}'
      );

      -- Active-claim invariant: at most one active claim per task
      CREATE UNIQUE INDEX IF NOT EXISTS unique_active_task_claim
        ON remote_agent_coordinator_task_claims (task_id)
        WHERE released_at IS NULL;

      -- Workflow runs table
      CREATE TABLE IF NOT EXISTS remote_agent_workflow_runs (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        conversation_id TEXT NOT NULL REFERENCES remote_agent_conversations(id) ON DELETE CASCADE,
        codebase_id TEXT REFERENCES remote_agent_codebases(id) ON DELETE SET NULL,
        workflow_name TEXT NOT NULL,
        user_message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        current_step_index INTEGER,
        metadata TEXT DEFAULT '{}',
        parent_conversation_id TEXT REFERENCES remote_agent_conversations(id) ON DELETE SET NULL,
        started_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT,
        last_activity_at TEXT DEFAULT (datetime('now')),
        working_path TEXT
      );

      -- Workflow events table
      CREATE TABLE IF NOT EXISTS remote_agent_workflow_events (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        workflow_run_id TEXT NOT NULL REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        step_index INTEGER,
        step_name TEXT,
        data TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Messages table (conversation history for Web UI)
      CREATE TABLE IF NOT EXISTS remote_agent_messages (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        conversation_id TEXT NOT NULL REFERENCES remote_agent_conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        metadata TEXT DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_codebase_env_vars_codebase_id ON remote_agent_codebase_env_vars(codebase_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_platform ON remote_agent_conversations(platform_type, platform_conversation_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_conversation ON remote_agent_sessions(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_active ON remote_agent_sessions(active);
      CREATE INDEX IF NOT EXISTS idx_isolation_codebase ON remote_agent_isolation_environments(codebase_id);
      CREATE INDEX IF NOT EXISTS idx_isolation_workflow ON remote_agent_isolation_environments(workflow_type, workflow_id);
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_conversation ON remote_agent_workflow_runs(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON remote_agent_workflow_runs(status);
      CREATE INDEX IF NOT EXISTS idx_workflow_events_run_id ON remote_agent_workflow_events(workflow_run_id);
      CREATE INDEX IF NOT EXISTS idx_workflow_events_type ON remote_agent_workflow_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON remote_agent_messages(conversation_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_parent_conv ON remote_agent_workflow_runs(parent_conversation_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_hidden ON remote_agent_conversations(hidden);
      DROP INDEX IF EXISTS idx_conversations_codebase;
      CREATE INDEX IF NOT EXISTS idx_conversations_codebase ON remote_agent_conversations(codebase_id) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_conversations_isolation_env_id ON remote_agent_conversations(isolation_env_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_codebase ON remote_agent_sessions(codebase_id);
      CREATE INDEX IF NOT EXISTS idx_isolation_env_status ON remote_agent_isolation_environments(status);

      -- From PG migration 009: staleness detection for running workflows
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_last_activity
        ON remote_agent_workflow_runs(last_activity_at) WHERE status = 'running';

      -- From PG migration 010: session audit trail
      CREATE INDEX IF NOT EXISTS idx_sessions_parent
        ON remote_agent_sessions(parent_session_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_conversation_started
        ON remote_agent_sessions(conversation_id, started_at DESC);

      -- From PG migration 022: coordinator-model indexes (P4-A)
      CREATE INDEX IF NOT EXISTS idx_coordinator_runs_conversation
        ON remote_agent_coordinator_runs(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_coordinator_runs_codebase
        ON remote_agent_coordinator_runs(codebase_id);
      CREATE INDEX IF NOT EXISTS idx_coordinator_runs_status
        ON remote_agent_coordinator_runs(status);
      CREATE INDEX IF NOT EXISTS idx_coordinator_tasks_run
        ON remote_agent_coordinator_tasks(coordinator_run_id);
      CREATE INDEX IF NOT EXISTS idx_coordinator_tasks_run_state
        ON remote_agent_coordinator_tasks(coordinator_run_id, state);
      CREATE INDEX IF NOT EXISTS idx_coordinator_claims_run_active
        ON remote_agent_coordinator_task_claims(coordinator_run_id)
        WHERE released_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_coordinator_claims_lease
        ON remote_agent_coordinator_task_claims(lease_expires_at)
        WHERE released_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_coordinator_claims_worker_run
        ON remote_agent_coordinator_task_claims(worker_run_id);
    `);
    getLog().info('db.sqlite_schema_initialized');
  }
}

/**
 * SQLite SQL dialect helpers
 */
export const sqliteDialect: SqlDialect = {
  generateUuid(): string {
    return crypto.randomUUID();
  },

  now(): string {
    return "datetime('now')";
  },

  jsonMerge(column: string, paramIndex: number): string {
    // SQLite json_patch: merges two JSON objects
    // Use $N placeholder (not raw ?) so convertPlaceholders can reorder params correctly
    return `json_patch(${column}, $${String(paramIndex)})`;
  },

  jsonArrayContains(column: string, path: string, paramIndex: number): string {
    // SQLite: check if JSON array contains value using instr
    // Use $N placeholder for consistent param ordering
    return `instr(json_extract(${column}, '$.${path}'), $${String(paramIndex)}) > 0`;
  },

  nowMinusDays(paramIndex: number): string {
    return `datetime('now', '-' || $${String(paramIndex)} || ' days')`;
  },

  daysSince(column: string): string {
    return `(julianday('now') - julianday(${column}))`;
  },

  nowPlusSeconds(paramIndex: number): string {
    return `datetime('now', '+' || $${String(paramIndex)} || ' seconds')`;
  },
};

export const sqliteTestHooks = {
  isSqliteBusyError,
  isSqliteRetryableError,
  retryDelaysFor,
};
