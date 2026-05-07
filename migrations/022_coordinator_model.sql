-- Multi-Root Coordinator Model — P4-A
-- See: docs/adr/0001-multi-root-coordinator-model.md
-- Adds: coordinator_runs, coordinator_tasks, coordinator_task_claims
-- Plus: codebases.max_parallel_workers (forward-compatible; not enforced this slice)

-- coordinator_runs: one row per root coordinator chat
CREATE TABLE IF NOT EXISTS remote_agent_coordinator_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES remote_agent_conversations(id) ON DELETE CASCADE,
  codebase_id UUID NOT NULL REFERENCES remote_agent_codebases(id) ON DELETE CASCADE,
  parent_run_id UUID REFERENCES remote_agent_coordinator_runs(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'planning',  -- planning | active | paused | completed | abandoned
  max_parallel_workers INTEGER NOT NULL DEFAULT 3,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_coordinator_runs_conversation
  ON remote_agent_coordinator_runs(conversation_id);
CREATE INDEX IF NOT EXISTS idx_coordinator_runs_codebase
  ON remote_agent_coordinator_runs(codebase_id);
CREATE INDEX IF NOT EXISTS idx_coordinator_runs_status
  ON remote_agent_coordinator_runs(status);

-- coordinator_tasks: nodes of the task DAG
CREATE TABLE IF NOT EXISTS remote_agent_coordinator_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coordinator_run_id UUID NOT NULL REFERENCES remote_agent_coordinator_runs(id) ON DELETE CASCADE,
  external_key VARCHAR(255) NOT NULL,           -- e.g. 'P4-A', 'P3-A.1'
  title TEXT NOT NULL,
  body TEXT,                                    -- task brief / prompt-pack source
  state VARCHAR(20) NOT NULL DEFAULT 'blocked', -- blocked | ready | claimed | running | completed | failed | cancelled
  depends_on JSONB NOT NULL DEFAULT '[]',       -- array of coordinator_task UUIDs
  evidence JSONB NOT NULL DEFAULT '{}',         -- {commit_sha, pushed_branch, pr_url, changed_files[], test_output, workflow_run_ids[]}
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  UNIQUE (coordinator_run_id, external_key)
);

CREATE INDEX IF NOT EXISTS idx_coordinator_tasks_run
  ON remote_agent_coordinator_tasks(coordinator_run_id);
CREATE INDEX IF NOT EXISTS idx_coordinator_tasks_run_state
  ON remote_agent_coordinator_tasks(coordinator_run_id, state);

-- coordinator_task_claims: lease + audit trail of all claim attempts on a task
CREATE TABLE IF NOT EXISTS remote_agent_coordinator_task_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES remote_agent_coordinator_tasks(id) ON DELETE CASCADE,
  coordinator_run_id UUID NOT NULL REFERENCES remote_agent_coordinator_runs(id) ON DELETE CASCADE,
  worker_run_id UUID REFERENCES remote_agent_workflow_runs(id) ON DELETE SET NULL,
  worker_label VARCHAR(255),
  claimed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  lease_expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  released_at TIMESTAMP WITH TIME ZONE,
  outcome VARCHAR(20),                            -- null while active; succeeded | failed | abandoned | expired when released
  metadata JSONB DEFAULT '{}'
);

-- Active-claim invariant: at most one active claim per task
CREATE UNIQUE INDEX IF NOT EXISTS unique_active_task_claim
  ON remote_agent_coordinator_task_claims (task_id)
  WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_coordinator_claims_run_active
  ON remote_agent_coordinator_task_claims (coordinator_run_id)
  WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_coordinator_claims_lease
  ON remote_agent_coordinator_task_claims (lease_expires_at)
  WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_coordinator_claims_worker_run
  ON remote_agent_coordinator_task_claims (worker_run_id);

-- Forward-compatible: per-repo max-parallel column. Not enforced this slice.
ALTER TABLE remote_agent_codebases
  ADD COLUMN IF NOT EXISTS max_parallel_workers INTEGER;

COMMENT ON TABLE remote_agent_coordinator_runs IS
  'Root coordinator chat. Owns a DAG of coordinator_tasks. See docs/adr/0001-multi-root-coordinator-model.md';
COMMENT ON TABLE remote_agent_coordinator_tasks IS
  'Node in a coordinator run''s task DAG. depends_on stores task UUIDs as JSONB array.';
COMMENT ON TABLE remote_agent_coordinator_task_claims IS
  'Worker claim on a task. UNIQUE(task_id) WHERE released_at IS NULL enforces single active claim.';
