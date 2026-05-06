/**
 * Smoke tests for coordinator endpoints (P4-A).
 *
 * Covers happy path + 1 error path per endpoint. Mirrors
 * `api.workflow-runs.test.ts` setup (mock.module for DB layer + workflow
 * modules; OpenAPIHono with validationErrorHook).
 *
 * NOTE: This file is loaded into its own `bun test` invocation via the test
 * script in `packages/server/package.json` (T15) to keep `mock.module()` from
 * cross-contaminating the other api.*.test.ts files.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';
import { mockAllWorkflowModules } from '../test/workflow-mock-factories';

// ---------------------------------------------------------------------------
// Mocks for DB and shared modules — must be set up before importing api.ts
// ---------------------------------------------------------------------------

type MockRun = {
  id: string;
  conversation_id: string;
  codebase_id: string;
  parent_run_id: string | null;
  name: string;
  status: 'planning' | 'active' | 'paused' | 'completed' | 'abandoned';
  max_parallel_workers: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type MockTask = {
  id: string;
  coordinator_run_id: string;
  external_key: string;
  title: string;
  body: string | null;
  state: 'blocked' | 'ready' | 'claimed' | 'running' | 'completed' | 'failed' | 'cancelled';
  depends_on: string[];
  evidence: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
};

type MockClaim = {
  id: string;
  task_id: string;
  coordinator_run_id: string;
  worker_run_id: string | null;
  worker_label: string | null;
  claimed_at: string;
  lease_expires_at: string;
  released_at: string | null;
  outcome: 'succeeded' | 'failed' | 'abandoned' | 'expired' | null;
  metadata: Record<string, unknown>;
};

const mockListCoordinatorRuns = mock(async () => [] as MockRun[]);
const mockCreateCoordinatorRun = mock(async (_d: unknown) => ({}) as MockRun);
const mockGetCoordinatorRun = mock(async (_id: string) => null as null | MockRun);

const mockListCoordinatorTasksByRun = mock(async (_id: string) => [] as MockTask[]);
const mockCreateCoordinatorTask = mock(async (_d: unknown) => ({}) as MockTask);
const mockGetCoordinatorTask = mock(async (_id: string) => null as null | MockTask);
const mockGetReadyTasks = mock(async (_id: string) => [] as MockTask[]);
const mockTransitionTaskState = mock(async (_id: string, _s: string) => {});
const mockRecordEvidence = mock(async (_id: string, _e: unknown) => {});

const mockClaimTask = mock(async (_o: unknown) => null as null | MockClaim);
const mockReleaseClaim = mock(async (_id: string, _o: unknown) => ({}) as MockClaim);
const mockHeartbeatClaim = mock(async (_id: string, _s: number) => true);
const mockReleaseExpiredClaims = mock(async () => ({ count: 0 }));
const mockCountActiveClaimsForRun = mock(async (_id: string) => 0);
const mockGetActiveClaimForTask = mock(async (_id: string) => null as null | MockClaim);
const mockListClaimsForTask = mock(async (_id: string) => [] as MockClaim[]);

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: () => 'sqlite',
  loadConfig: mock(async () => ({})),
  cloneRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  registerRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  ConversationNotFoundError: class extends Error {},
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  generateAndSetTitle: mock(async () => {}),
  createLogger: () => ({
    fatal: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
    child: mock(function (this: unknown) {
      return this;
    }),
    bindings: mock(() => ({ module: 'test' })),
    isLevelEnabled: mock(() => true),
    level: 'info',
  }),
}));

mock.module('@archon/paths', () => ({
  createLogger: () => ({
    fatal: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
    child: mock(function (this: unknown) {
      return this;
    }),
    bindings: mock(() => ({ module: 'test' })),
    isLevelEnabled: mock(() => true),
    level: 'info',
  }),
  getWorkflowFolderSearchPaths: mock(() => ['.archon/workflows']),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands']),
  getDefaultCommandsPath: mock(() => '/tmp/.archon-test-nonexistent/commands/defaults'),
  getDefaultWorkflowsPath: mock(() => '/tmp/.archon-test-nonexistent/workflows/defaults'),
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
}));

mockAllWorkflowModules();

mock.module('@archon/git', () => ({
  removeWorktree: mock(async () => {}),
  toRepoPath: (p: string) => p,
  toWorktreePath: (p: string) => p,
}));

mock.module('@archon/core/db/conversations', () => ({
  findConversationByPlatformId: mock(async () => null),
  listConversations: mock(async () => []),
  getOrCreateConversation: mock(async () => null),
  softDeleteConversation: mock(async () => {}),
  updateConversationTitle: mock(async () => {}),
  getConversationById: mock(async () => null),
}));

mock.module('@archon/core/db/codebases', () => ({
  listCodebases: mock(async () => [{ default_cwd: '/tmp/project' }]),
  getCodebase: mock(async () => null),
  deleteCodebase: mock(async () => {}),
}));

mock.module('@archon/core/db/isolation-environments', () => ({
  listByCodebase: mock(async () => []),
  updateStatus: mock(async () => {}),
}));

mock.module('@archon/core/db/workflows', () => ({
  listWorkflowRuns: mock(async () => []),
  listDashboardRuns: mock(async () => ({
    runs: [],
    total: 0,
    counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0, paused: 0 },
  })),
  getWorkflowRun: mock(async () => null),
  cancelWorkflowRun: mock(async () => {}),
  deleteWorkflowRun: mock(async () => {}),
  updateWorkflowRun: mock(async () => {}),
  getWorkflowRunByWorkerPlatformId: mock(async () => null),
}));

mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: mock(async () => []),
  createWorkflowEvent: mock(async () => {}),
}));

mock.module('@archon/core/db/messages', () => ({
  addMessage: mock(async () => null),
  listMessages: mock(async () => []),
}));

mock.module('@archon/core/utils/commands', () => ({
  findMarkdownFilesRecursive: mock(async () => []),
}));

mock.module('@archon/core/db/coordinator-runs', () => ({
  listCoordinatorRuns: mockListCoordinatorRuns,
  createCoordinatorRun: mockCreateCoordinatorRun,
  getCoordinatorRun: mockGetCoordinatorRun,
  updateCoordinatorRunStatus: mock(async () => {}),
  deleteCoordinatorRun: mock(async () => true),
}));

mock.module('@archon/core/db/coordinator-tasks', () => ({
  listCoordinatorTasksByRun: mockListCoordinatorTasksByRun,
  listCoordinatorTasks: mock(async () => [] as MockTask[]),
  createCoordinatorTask: mockCreateCoordinatorTask,
  getCoordinatorTask: mockGetCoordinatorTask,
  getReadyTasks: mockGetReadyTasks,
  transitionTaskState: mockTransitionTaskState,
  recordEvidence: mockRecordEvidence,
  arePrerequisitesMet: () => true,
}));

mock.module('@archon/core/db/coordinator-claims', () => ({
  claimTask: mockClaimTask,
  releaseClaim: mockReleaseClaim,
  heartbeatClaim: mockHeartbeatClaim,
  releaseExpiredClaims: mockReleaseExpiredClaims,
  countActiveClaimsForRun: mockCountActiveClaimsForRun,
  getActiveClaimForTask: mockGetActiveClaimForTask,
  listClaimsForTask: mockListClaimsForTask,
}));

import { registerApiRoutes } from './api';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date().toISOString();

const MOCK_RUN: MockRun = {
  id: 'run-1',
  conversation_id: 'conv-1',
  codebase_id: 'cb-1',
  parent_run_id: null,
  name: 'P4 Phase',
  status: 'planning',
  max_parallel_workers: 3,
  metadata: {},
  created_at: NOW,
  updated_at: NOW,
  completed_at: null,
};

const MOCK_TASK: MockTask = {
  id: 'task-1',
  coordinator_run_id: 'run-1',
  external_key: 'P4-A',
  title: 'Coordinator schema',
  body: null,
  state: 'ready',
  depends_on: [],
  evidence: {},
  metadata: {},
  created_at: NOW,
  updated_at: NOW,
  started_at: null,
  completed_at: null,
};

const MOCK_CLAIM: MockClaim = {
  id: 'claim-1',
  task_id: 'task-1',
  coordinator_run_id: 'run-1',
  worker_run_id: null,
  worker_label: null,
  claimed_at: NOW,
  lease_expires_at: NOW,
  released_at: null,
  outcome: null,
  metadata: {},
};

function makeApp(): OpenAPIHono {
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  const mockWebAdapter = {
    setConversationDbId: mock(() => {}),
    emitSSE: mock(async () => {}),
    emitLockEvent: mock(async () => {}),
  } as unknown as WebAdapter;
  const mockLockManager = {
    acquireLock: mock(async (_id: string, fn: () => Promise<void>) => {
      await fn();
      return { status: 'started' };
    }),
    getStats: mock(() => ({ active: 0, queued: 0 })),
  } as unknown as ConversationLockManager;
  registerApiRoutes(app, mockWebAdapter, mockLockManager);
  return app;
}

function resetAllMocks(): void {
  mockListCoordinatorRuns.mockReset();
  mockCreateCoordinatorRun.mockReset();
  mockGetCoordinatorRun.mockReset();
  mockListCoordinatorTasksByRun.mockReset();
  mockCreateCoordinatorTask.mockReset();
  mockGetCoordinatorTask.mockReset();
  mockGetReadyTasks.mockReset();
  mockTransitionTaskState.mockReset();
  mockRecordEvidence.mockReset();
  mockClaimTask.mockReset();
  mockReleaseClaim.mockReset();
  mockHeartbeatClaim.mockReset();
  mockCountActiveClaimsForRun.mockReset();
  mockGetActiveClaimForTask.mockReset();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/coordinators', () => {
  beforeEach(resetAllMocks);

  test('returns the list of coordinator runs', async () => {
    mockListCoordinatorRuns.mockImplementationOnce(async () => [MOCK_RUN]);

    const app = makeApp();
    const response = await app.request('/api/coordinators');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { runs: Array<{ id: string }> };
    expect(body.runs.length).toBe(1);
    expect(body.runs[0]?.id).toBe('run-1');
  });

  test('returns 500 when DB throws', async () => {
    mockListCoordinatorRuns.mockImplementationOnce(async () => {
      throw new Error('DB down');
    });

    const app = makeApp();
    const response = await app.request('/api/coordinators');
    expect(response.status).toBe(500);
  });
});

describe('POST /api/coordinators', () => {
  beforeEach(resetAllMocks);

  test('creates a coordinator run', async () => {
    mockCreateCoordinatorRun.mockImplementationOnce(async () => MOCK_RUN);

    const app = makeApp();
    const response = await app.request('/api/coordinators', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation_id: 'conv-1',
        codebase_id: 'cb-1',
        name: 'P4 Phase',
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { run: { id: string } };
    expect(body.run.id).toBe('run-1');
  });

  test('returns 400 when name is missing', async () => {
    const app = makeApp();
    const response = await app.request('/api/coordinators', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: 'conv-1', codebase_id: 'cb-1' }),
    });
    expect(response.status).toBe(400);
  });
});

describe('GET /api/coordinators/:id', () => {
  beforeEach(resetAllMocks);

  test('returns run with tasks and active claims', async () => {
    mockGetCoordinatorRun.mockImplementationOnce(async () => MOCK_RUN);
    mockListCoordinatorTasksByRun.mockImplementationOnce(async () => [MOCK_TASK]);
    mockGetActiveClaimForTask.mockImplementationOnce(async () => MOCK_CLAIM);

    const app = makeApp();
    const response = await app.request('/api/coordinators/run-1');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      run: { id: string };
      tasks: Array<{ id: string }>;
      active_claims: Array<{ id: string }>;
    };
    expect(body.run.id).toBe('run-1');
    expect(body.tasks.length).toBe(1);
    expect(body.active_claims.length).toBe(1);
    expect(body.active_claims[0]?.id).toBe('claim-1');
  });

  test('returns 404 when run not found', async () => {
    mockGetCoordinatorRun.mockImplementationOnce(async () => null);

    const app = makeApp();
    const response = await app.request('/api/coordinators/missing');
    expect(response.status).toBe(404);
  });
});

describe('POST /api/coordinators/:id/tasks', () => {
  beforeEach(resetAllMocks);

  test('creates a task with no dependencies', async () => {
    mockGetCoordinatorRun.mockImplementationOnce(async () => MOCK_RUN);
    mockCreateCoordinatorTask.mockImplementationOnce(async () => MOCK_TASK);

    const app = makeApp();
    const response = await app.request('/api/coordinators/run-1/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ external_key: 'P4-A', title: 'Coordinator schema' }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { task: { id: string } };
    expect(body.task.id).toBe('task-1');
  });

  test('returns 400 when adding a dependency would create a cycle', async () => {
    mockGetCoordinatorRun.mockImplementationOnce(async () => MOCK_RUN);
    // Existing tasks form a chain: A → B (B depends on A).
    // Now add new task C with depends_on=[B] AND a re-target where A depends on C.
    // We build this by giving A a depends_on=['__candidate__'] up-front, simulating
    // the cycle that the candidate would close. The handler validates that a new
    // task's depends_on cannot create a cycle in the existing graph.
    //
    // For a simpler cycle test: existing has task X with depends_on=['__candidate__'],
    // and the new candidate also has depends_on=['X'] — directly cyclic.
    mockListCoordinatorTasksByRun.mockImplementationOnce(async () => [
      { ...MOCK_TASK, id: 'X', external_key: 'X', depends_on: ['__candidate__'] },
    ]);

    const app = makeApp();
    const response = await app.request('/api/coordinators/run-1/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ external_key: 'NEW', title: 'cycle', depends_on: ['X'] }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Cycle');
  });

  test('returns 400 when depending on an unknown task', async () => {
    mockGetCoordinatorRun.mockImplementationOnce(async () => MOCK_RUN);
    mockListCoordinatorTasksByRun.mockImplementationOnce(async () => []);

    const app = makeApp();
    const response = await app.request('/api/coordinators/run-1/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        external_key: 'NEW',
        title: 'orphan dep',
        depends_on: ['nonexistent-id'],
      }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('unknown task');
  });

  test('returns 404 when coordinator run does not exist', async () => {
    mockGetCoordinatorRun.mockImplementationOnce(async () => null);

    const app = makeApp();
    const response = await app.request('/api/coordinators/missing/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ external_key: 'P4-A', title: 'Coordinator schema' }),
    });
    expect(response.status).toBe(404);
  });
});

describe('PATCH /api/coordinators/:runId/tasks/:taskId', () => {
  beforeEach(resetAllMocks);

  test('transitions state', async () => {
    mockGetCoordinatorTask.mockImplementationOnce(async () => MOCK_TASK);
    mockGetCoordinatorTask.mockImplementationOnce(async () => ({
      ...MOCK_TASK,
      state: 'running',
    }));

    const app = makeApp();
    const response = await app.request('/api/coordinators/run-1/tasks/task-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'running' }),
    });
    expect(response.status).toBe(200);
    expect(mockTransitionTaskState).toHaveBeenCalledWith('task-1', 'running');
  });

  test('returns 404 when task does not belong to the run', async () => {
    mockGetCoordinatorTask.mockImplementationOnce(async () => ({
      ...MOCK_TASK,
      coordinator_run_id: 'other-run',
    }));

    const app = makeApp();
    const response = await app.request('/api/coordinators/run-1/tasks/task-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'running' }),
    });
    expect(response.status).toBe(404);
  });

  test('returns 400 when transitioning out of a terminal state', async () => {
    mockGetCoordinatorTask.mockImplementationOnce(async () => ({
      ...MOCK_TASK,
      state: 'completed',
    }));
    mockTransitionTaskState.mockImplementationOnce(async () => {
      throw new Error(
        'Failed to transition coordinator task: no task found ... or task is already terminal'
      );
    });

    const app = makeApp();
    const response = await app.request('/api/coordinators/run-1/tasks/task-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'ready' }),
    });
    expect(response.status).toBe(400);
  });
});

describe('GET /api/coordinators/:id/ready-tasks', () => {
  beforeEach(resetAllMocks);

  test('returns ready tasks', async () => {
    mockGetReadyTasks.mockImplementationOnce(async () => [MOCK_TASK]);

    const app = makeApp();
    const response = await app.request('/api/coordinators/run-1/ready-tasks');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { tasks: Array<{ id: string }> };
    expect(body.tasks.length).toBe(1);
  });

  test('returns 500 when DB throws', async () => {
    mockGetReadyTasks.mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    const app = makeApp();
    const response = await app.request('/api/coordinators/run-1/ready-tasks');
    expect(response.status).toBe(500);
  });
});

describe('POST /api/coordinators/:runId/tasks/:taskId/claim', () => {
  beforeEach(resetAllMocks);

  test('returns the claim row on successful claim', async () => {
    mockGetCoordinatorRun.mockImplementationOnce(async () => MOCK_RUN);
    mockGetCoordinatorTask.mockImplementationOnce(async () => MOCK_TASK);
    mockCountActiveClaimsForRun.mockImplementationOnce(async () => 0);
    mockClaimTask.mockImplementationOnce(async () => MOCK_CLAIM);

    const app = makeApp();
    const response = await app.request('/api/coordinators/run-1/tasks/task-1/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lease_seconds: 900 }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { claim: { id: string } | null };
    expect(body.claim?.id).toBe('claim-1');
  });

  test('returns 200 { claim: null } when contended (NOT 409)', async () => {
    mockGetCoordinatorRun.mockImplementationOnce(async () => MOCK_RUN);
    mockGetCoordinatorTask.mockImplementationOnce(async () => MOCK_TASK);
    mockCountActiveClaimsForRun.mockImplementationOnce(async () => 0);
    mockClaimTask.mockImplementationOnce(async () => null);

    const app = makeApp();
    const response = await app.request('/api/coordinators/run-1/tasks/task-1/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lease_seconds: 900 }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { claim: null };
    expect(body.claim).toBeNull();
  });

  test('returns 429 when at max_parallel_workers', async () => {
    mockGetCoordinatorRun.mockImplementationOnce(async () => ({
      ...MOCK_RUN,
      max_parallel_workers: 2,
    }));
    mockGetCoordinatorTask.mockImplementationOnce(async () => MOCK_TASK);
    mockCountActiveClaimsForRun.mockImplementationOnce(async () => 2);

    const app = makeApp();
    const response = await app.request('/api/coordinators/run-1/tasks/task-1/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lease_seconds: 900 }),
    });
    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('max_parallel_workers');
    // Verify claimTask was NOT called when budget was hit.
    expect(mockClaimTask).not.toHaveBeenCalled();
  });

  test('returns 404 when run not found', async () => {
    mockGetCoordinatorRun.mockImplementationOnce(async () => null);

    const app = makeApp();
    const response = await app.request('/api/coordinators/missing/tasks/task-1/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lease_seconds: 900 }),
    });
    expect(response.status).toBe(404);
  });
});

describe('POST /api/coordinators/claims/:claimId/release', () => {
  beforeEach(resetAllMocks);

  test('releases the claim and returns the released row', async () => {
    mockReleaseClaim.mockImplementationOnce(async () => ({
      ...MOCK_CLAIM,
      released_at: NOW,
      outcome: 'succeeded',
    }));

    const app = makeApp();
    const response = await app.request('/api/coordinators/claims/claim-1/release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'succeeded', evidence: { commit_sha: 'abc' } }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { claim: { outcome: string } };
    expect(body.claim.outcome).toBe('succeeded');
    expect(mockReleaseClaim).toHaveBeenCalledWith('claim-1', {
      outcome: 'succeeded',
      evidence: { commit_sha: 'abc' },
    });
  });

  test('returns 404 when claim does not exist', async () => {
    mockReleaseClaim.mockImplementationOnce(async () => {
      throw new Error('Coordinator claim not found (id: claim-x)');
    });

    const app = makeApp();
    const response = await app.request('/api/coordinators/claims/claim-x/release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'failed' }),
    });
    expect(response.status).toBe(404);
  });
});

describe('POST /api/coordinators/claims/:claimId/heartbeat', () => {
  beforeEach(resetAllMocks);

  test('returns extended=true when lease was extended', async () => {
    mockHeartbeatClaim.mockImplementationOnce(async () => true);

    const app = makeApp();
    const response = await app.request('/api/coordinators/claims/claim-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lease_seconds: 600 }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { extended: boolean };
    expect(body.extended).toBe(true);
    expect(mockHeartbeatClaim).toHaveBeenCalledWith('claim-1', 600);
  });

  test('returns extended=false when claim is already released', async () => {
    mockHeartbeatClaim.mockImplementationOnce(async () => false);

    const app = makeApp();
    const response = await app.request('/api/coordinators/claims/claim-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lease_seconds: 600 }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { extended: boolean };
    expect(body.extended).toBe(false);
  });
});
