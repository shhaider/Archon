import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createQueryResult, mockPostgresDialect } from '../test/mocks/database';
import type { CoordinatorTask } from '@archon/workflows/schemas/coordinator';

const mockQuery = mock(() => Promise.resolve(createQueryResult([])));

mock.module('./connection', () => ({
  pool: {
    query: mockQuery,
  },
  getDialect: () => mockPostgresDialect,
  getDatabaseType: () => 'postgresql' as const,
}));

import {
  createCoordinatorTask,
  getCoordinatorTask,
  listCoordinatorTasks,
  listCoordinatorTasksByRun,
  arePrerequisitesMet,
  getReadyTasks,
  transitionTaskState,
  recordEvidence,
} from './coordinator-tasks';

describe('coordinator-tasks database', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(() => Promise.resolve(createQueryResult([])));
  });

  const mockTask: CoordinatorTask = {
    id: 'task-1',
    coordinator_run_id: 'run-1',
    external_key: 'P4-A',
    title: 'Coordinator schema',
    body: null,
    state: 'ready',
    depends_on: [],
    evidence: {},
    metadata: {},
    created_at: new Date('2026-05-06T00:00:00Z'),
    updated_at: new Date('2026-05-06T00:00:00Z'),
    started_at: null,
    completed_at: null,
  };

  describe('createCoordinatorTask', () => {
    test('with empty depends_on defaults to state="ready"', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockTask]));

      const result = await createCoordinatorTask({
        coordinator_run_id: 'run-1',
        external_key: 'P4-A',
        title: 'Coordinator schema',
      });

      expect(result.state).toBe('ready');
      const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      // params: [run_id, external_key, title, body, state, depends_on, metadata]
      expect(params[4]).toBe('ready');
      expect(params[5]).toBe('[]');
    });

    test('with non-empty depends_on defaults to state="blocked"', async () => {
      const blocked = { ...mockTask, state: 'blocked' as const, depends_on: ['t-prev'] };
      mockQuery.mockResolvedValueOnce(createQueryResult([blocked]));

      const result = await createCoordinatorTask({
        coordinator_run_id: 'run-1',
        external_key: 'P4-B',
        title: 'Dispatcher',
        depends_on: ['t-prev'],
      });

      expect(result.state).toBe('blocked');
      const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(params[4]).toBe('blocked');
      expect(params[5]).toBe('["t-prev"]');
    });

    test('serializes depends_on and metadata to JSON for the JSONB columns', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockTask]));

      await createCoordinatorTask({
        coordinator_run_id: 'run-1',
        external_key: 'P4-A',
        title: 'Coordinator schema',
        depends_on: ['a', 'b'],
        metadata: { source: 'cli' },
      });

      const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(params[5]).toBe('["a","b"]');
      expect(params[6]).toBe('{"source":"cli"}');
    });

    test('throws on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('pkey violation'));

      await expect(
        createCoordinatorTask({
          coordinator_run_id: 'run-1',
          external_key: 'dup',
          title: 'x',
        })
      ).rejects.toThrow('Failed to create coordinator task: pkey violation');
    });
  });

  describe('getCoordinatorTask', () => {
    test('parses string-shaped JSONB columns into objects (SQLite shape)', async () => {
      const sqliteRow = {
        ...mockTask,
        depends_on: '["t-prev"]' as unknown as string[],
        evidence: '{"commit_sha":"abc"}' as unknown as Record<string, unknown>,
        metadata: '{"k":"v"}' as unknown as Record<string, unknown>,
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([sqliteRow]));

      const result = await getCoordinatorTask('task-1');

      expect(result?.depends_on).toEqual(['t-prev']);
      expect(result?.evidence).toEqual({ commit_sha: 'abc' });
      expect(result?.metadata).toEqual({ k: 'v' });
    });

    test('returns null when no row matches', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      expect(await getCoordinatorTask('missing')).toBeNull();
    });
  });

  describe('listCoordinatorTasks / listCoordinatorTasksByRun', () => {
    test('filters by coordinator_run_id and state', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await listCoordinatorTasks({ coordinatorRunId: 'run-1', state: 'ready' });

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('coordinator_run_id = $1');
      expect(query).toContain('state IN ($2)');
      expect(params.slice(0, 2)).toEqual(['run-1', 'ready']);
    });

    test('listCoordinatorTasksByRun forwards to listCoordinatorTasks', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await listCoordinatorTasksByRun('run-1');

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('coordinator_run_id = $1');
      expect(params[0]).toBe('run-1');
    });
  });

  describe('arePrerequisitesMet (pure helper)', () => {
    const mk = (id: string, state: CoordinatorTask['state']) =>
      ({ id, state }) as Pick<CoordinatorTask, 'id' | 'state'>;

    test('returns true for an empty depends_on', () => {
      expect(arePrerequisitesMet({ depends_on: [] }, [])).toBe(true);
    });

    test('returns false when any dep is in a non-completed state', () => {
      const all = [mk('a', 'completed'), mk('b', 'running'), mk('c', 'completed')];
      expect(arePrerequisitesMet({ depends_on: ['a', 'b'] }, all)).toBe(false);
      expect(arePrerequisitesMet({ depends_on: ['a', 'c'] }, all)).toBe(true);
    });

    test('returns false when any dep is failed or cancelled', () => {
      const all = [mk('a', 'failed'), mk('b', 'cancelled'), mk('c', 'completed')];
      expect(arePrerequisitesMet({ depends_on: ['a', 'c'] }, all)).toBe(false);
      expect(arePrerequisitesMet({ depends_on: ['b'] }, all)).toBe(false);
    });

    test('returns false when a dep ID is missing from allTasks (orphaned-dep guard)', () => {
      const all = [mk('a', 'completed')];
      expect(arePrerequisitesMet({ depends_on: ['a', 'missing'] }, all)).toBe(false);
    });

    test('returns true only when EVERY dep is in completed state', () => {
      const all = [mk('a', 'completed'), mk('b', 'completed'), mk('c', 'completed')];
      expect(arePrerequisitesMet({ depends_on: ['a', 'b', 'c'] }, all)).toBe(true);
    });
  });

  describe('getReadyTasks', () => {
    test('SQL filters state="ready" AND excludes tasks with active claims', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await getReadyTasks('run-1');

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain("t.state = 'ready'");
      expect(query).toContain('NOT EXISTS');
      expect(query).toContain('remote_agent_coordinator_task_claims');
      expect(query).toContain('c.released_at IS NULL');
      expect(params).toEqual(['run-1']);
    });

    test('SQL does NOT include "blocked" tasks', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await getReadyTasks('run-1');

      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).not.toContain("t.state = 'blocked'");
    });
  });

  describe('transitionTaskState', () => {
    test('legal transition succeeds', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await transitionTaskState('task-1', 'running');

      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('state = $1');
      // Auto-stamps started_at via COALESCE on entering 'running'.
      expect(query).toContain('started_at = COALESCE(started_at, NOW())');
    });

    test('terminal-state transition stamps completed_at', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await transitionTaskState('task-1', 'completed');

      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('completed_at = NOW()');
    });

    test('refuses to transition OUT of a terminal state (rowCount === 0 throws)', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0));

      await expect(transitionTaskState('task-1', 'ready')).rejects.toThrow('no task found with id');

      // SQL must filter terminal rows out — otherwise the guard isn't enforced.
      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('state NOT IN');
    });
  });

  describe('recordEvidence', () => {
    test('uses dialect.jsonMerge to MERGE evidence (does not REPLACE)', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await recordEvidence('task-1', { commit_sha: 'abc', pr_url: 'https://example.com/pr/1' });

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('evidence = evidence || ');
      // Regression guard: NEVER use a REPLACE pattern (`evidence = $N`)
      expect(query).not.toMatch(/evidence = \$\d/);
      expect(params).toContain(
        JSON.stringify({ commit_sha: 'abc', pr_url: 'https://example.com/pr/1' })
      );
    });

    test('throws when no row matches', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0));

      await expect(recordEvidence('missing', { commit_sha: 'abc' })).rejects.toThrow(
        'Coordinator task not found'
      );
    });
  });
});
