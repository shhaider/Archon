import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createQueryResult, mockPostgresDialect } from '../test/mocks/database';
import type { CoordinatorTaskClaim } from '@archon/workflows/schemas/coordinator';

const mockQuery = mock(() => Promise.resolve(createQueryResult([])));

mock.module('./connection', () => ({
  pool: {
    query: mockQuery,
  },
  getDialect: () => mockPostgresDialect,
  getDatabaseType: () => 'postgresql' as const,
}));

// Mock coordinator-tasks so we can assert that releaseClaim fans out to recordEvidence.
const mockRecordEvidence = mock(() => Promise.resolve());
const mockTransitionTaskState = mock(() => Promise.resolve());
mock.module('./coordinator-tasks', () => ({
  recordEvidence: mockRecordEvidence,
  transitionTaskState: mockTransitionTaskState,
}));

import {
  claimTask,
  releaseClaim,
  heartbeatClaim,
  releaseExpiredClaims,
  countActiveClaimsForRun,
  getActiveClaimForTask,
  listClaimsForTask,
} from './coordinator-claims';

describe('coordinator-claims database', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(() => Promise.resolve(createQueryResult([])));
    mockRecordEvidence.mockReset();
    mockRecordEvidence.mockImplementation(() => Promise.resolve());
    mockTransitionTaskState.mockReset();
    mockTransitionTaskState.mockImplementation(() => Promise.resolve());
  });

  const mockClaim: CoordinatorTaskClaim = {
    id: 'claim-1',
    task_id: 'task-1',
    coordinator_run_id: 'run-1',
    worker_run_id: null,
    worker_label: null,
    claimed_at: new Date('2026-05-06T00:00:00Z'),
    lease_expires_at: new Date('2026-05-06T00:15:00Z'),
    released_at: null,
    outcome: null,
    metadata: {},
  };

  describe('claimTask', () => {
    test('returns the inserted claim row on success', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockClaim]));

      const result = await claimTask({
        taskId: 'task-1',
        coordinatorRunId: 'run-1',
        leaseSeconds: 900,
      });

      expect(result).toEqual(mockClaim);
      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('INSERT INTO remote_agent_coordinator_task_claims');
      // Lease MUST be computed in SQL via dialect.nowPlusSeconds, NOT in JS.
      // The mockPostgresDialect emits NOW() + ($N || ' seconds')::INTERVAL.
      expect(query).toContain("NOW() + ($5 || ' seconds')::INTERVAL");
      // params: [taskId, runId, workerRunId(null), workerLabel(null), leaseSeconds]
      expect(params).toEqual(['task-1', 'run-1', null, null, 900]);
    });

    test('returns null on a Postgres unique-violation (SQLSTATE 23505)', async () => {
      const violation = Object.assign(new Error('duplicate key value'), { code: '23505' });
      mockQuery.mockRejectedValueOnce(violation);

      const result = await claimTask({
        taskId: 'task-1',
        coordinatorRunId: 'run-1',
        leaseSeconds: 900,
      });

      expect(result).toBeNull();
    });

    test('throws on non-unique-violation database errors', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(
        claimTask({ taskId: 'task-1', coordinatorRunId: 'run-1', leaseSeconds: 900 })
      ).rejects.toThrow('Failed to claim coordinator task: Connection refused');
    });

    test('passes worker_run_id and worker_label when provided', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockClaim]));

      await claimTask({
        taskId: 'task-1',
        coordinatorRunId: 'run-1',
        workerRunId: 'workflow-42',
        workerLabel: 'impl-team-a',
        leaseSeconds: 900,
      });

      const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(params[2]).toBe('workflow-42');
      expect(params[3]).toBe('impl-team-a');
    });
  });

  describe('releaseClaim', () => {
    test('marks the claim released and returns the row', async () => {
      const released = { ...mockClaim, released_at: new Date(), outcome: 'succeeded' as const };
      // UPDATE → rowCount 1; SELECT → released row
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      mockQuery.mockResolvedValueOnce(createQueryResult([released]));

      const result = await releaseClaim('claim-1', { outcome: 'succeeded' });

      expect(result.outcome).toBe('succeeded');
      const [updateSql] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(updateSql).toContain('UPDATE remote_agent_coordinator_task_claims');
      expect(updateSql).toContain('released_at = NOW()');
      // Active-row guard MUST be present.
      expect(updateSql).toContain('released_at IS NULL');
    });

    test('on succeeded + evidence provided, fans out to coordinatorTaskDb.recordEvidence', async () => {
      const released = {
        ...mockClaim,
        released_at: new Date(),
        outcome: 'succeeded' as const,
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      mockQuery.mockResolvedValueOnce(createQueryResult([released]));

      await releaseClaim('claim-1', {
        outcome: 'succeeded',
        evidence: { commit_sha: 'abc' },
      });

      expect(mockTransitionTaskState).toHaveBeenCalledWith('task-1', 'completed');
      expect(mockRecordEvidence).toHaveBeenCalledWith('task-1', { commit_sha: 'abc' });
    });

    test('on failed outcome, transitions the task to failed without evidence fan-out', async () => {
      const released = {
        ...mockClaim,
        released_at: new Date(),
        outcome: 'failed' as const,
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      mockQuery.mockResolvedValueOnce(createQueryResult([released]));

      await releaseClaim('claim-1', { outcome: 'failed' });

      expect(mockTransitionTaskState).toHaveBeenCalledWith('task-1', 'failed');
      expect(mockRecordEvidence).not.toHaveBeenCalled();
    });

    test('idempotent: when UPDATE matches no rows, returns existing row WITHOUT calling recordEvidence', async () => {
      // UPDATE rowCount = 0 (already released by an earlier call)
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0));
      // SELECT returns the previously-released claim
      const prev = {
        ...mockClaim,
        released_at: new Date('2026-05-06T00:01:00Z'),
        outcome: 'succeeded' as const,
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([prev]));

      const result = await releaseClaim('claim-1', {
        outcome: 'succeeded',
        evidence: { commit_sha: 'late' },
      });

      expect(result).toEqual(prev);
      // Skipped — release was already done by an earlier call.
      expect(mockTransitionTaskState).not.toHaveBeenCalled();
      expect(mockRecordEvidence).not.toHaveBeenCalled();
    });

    test('throws when claim not found at all', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0));
      mockQuery.mockResolvedValueOnce(createQueryResult([])); // SELECT empty

      await expect(releaseClaim('missing', { outcome: 'failed' })).rejects.toThrow(
        'Coordinator claim not found'
      );
    });
  });

  describe('heartbeatClaim', () => {
    test('extends lease using SQL nowPlusSeconds expression', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      const ok = await heartbeatClaim('claim-1', 600);

      expect(ok).toBe(true);
      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain("lease_expires_at = NOW() + ($1 || ' seconds')::INTERVAL");
      expect(query).toContain('released_at IS NULL');
      expect(params).toEqual([600, 'claim-1']);
    });

    test('returns false when claim is already released (no-op)', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0));

      const ok = await heartbeatClaim('claim-1', 600);

      expect(ok).toBe(false);
    });
  });

  describe('releaseExpiredClaims', () => {
    test('SQL sweeps active claims past lease using DB clock and reports count', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 5));

      const result = await releaseExpiredClaims();

      expect(result.count).toBe(5);
      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('UPDATE remote_agent_coordinator_task_claims');
      expect(query).toContain("outcome = 'expired'");
      // Lease comparison MUST use the DB clock (NOW()), not a JS-supplied value.
      expect(query).toContain('lease_expires_at < NOW()');
      expect(query).toContain('released_at IS NULL');
    });

    test('returns 0 when no claims are expired', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0));

      const result = await releaseExpiredClaims();

      expect(result.count).toBe(0);
    });
  });

  describe('countActiveClaimsForRun', () => {
    test('returns COUNT for a coordinator run filtered by released_at IS NULL', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([{ count: '3' }]));

      const result = await countActiveClaimsForRun('run-1');

      expect(result).toBe(3);
      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('COUNT(*)');
      expect(query).toContain('released_at IS NULL');
      expect(params).toEqual(['run-1']);
    });
  });

  describe('getActiveClaimForTask', () => {
    test('returns the un-released claim or null', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockClaim]));

      const result = await getActiveClaimForTask('task-1');

      expect(result).toEqual(mockClaim);
      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('released_at IS NULL');
    });
  });

  describe('listClaimsForTask', () => {
    test('returns full audit trail in chronological order', async () => {
      const released = {
        ...mockClaim,
        id: 'claim-0',
        released_at: new Date(),
        outcome: 'expired' as const,
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([released, mockClaim]));

      const result = await listClaimsForTask('task-1');

      expect(result.length).toBe(2);
      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('ORDER BY claimed_at ASC');
    });
  });
});
