import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createQueryResult, mockPostgresDialect } from '../test/mocks/database';
import type { CoordinatorRun } from '@archon/workflows/schemas/coordinator';

const mockQuery = mock(() => Promise.resolve(createQueryResult([])));

// Mock the connection module before importing the module under test.
// Per CLAUDE.md "Test isolation (mock.module pollution)" — this mock
// is process-wide; this file is run in its own bun test invocation.
mock.module('./connection', () => ({
  pool: {
    query: mockQuery,
  },
  getDialect: () => mockPostgresDialect,
  getDatabaseType: () => 'postgresql' as const,
}));

import {
  createCoordinatorRun,
  getCoordinatorRun,
  listCoordinatorRuns,
  updateCoordinatorRunStatus,
  deleteCoordinatorRun,
} from './coordinator-runs';

describe('coordinator-runs database', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(() => Promise.resolve(createQueryResult([])));
  });

  const mockRun: CoordinatorRun = {
    id: 'run-1',
    conversation_id: 'conv-1',
    codebase_id: 'cb-1',
    parent_run_id: null,
    name: 'P4 Phase',
    status: 'planning',
    max_parallel_workers: 3,
    metadata: {},
    created_at: new Date('2026-05-06T00:00:00Z'),
    updated_at: new Date('2026-05-06T00:00:00Z'),
    completed_at: null,
  };

  describe('createCoordinatorRun', () => {
    test('inserts a new coordinator run with defaults', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockRun]));

      const result = await createCoordinatorRun({
        conversation_id: 'conv-1',
        codebase_id: 'cb-1',
        name: 'P4 Phase',
      });

      expect(result).toEqual(mockRun);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO remote_agent_coordinator_runs'),
        ['conv-1', 'cb-1', null, 'P4 Phase', 3, '{}']
      );
    });

    test('serializes metadata to JSON for the JSONB column', async () => {
      const withMeta = { ...mockRun, metadata: { source: 'cli' } };
      mockQuery.mockResolvedValueOnce(createQueryResult([withMeta]));

      await createCoordinatorRun({
        conversation_id: 'conv-1',
        codebase_id: 'cb-1',
        name: 'P4 Phase',
        metadata: { source: 'cli' },
      });

      const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(params[5]).toBe('{"source":"cli"}');
    });

    test('honours custom max_parallel_workers and parent_run_id', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockRun]));

      await createCoordinatorRun({
        conversation_id: 'conv-1',
        codebase_id: 'cb-1',
        name: 'P4 Phase',
        max_parallel_workers: 5,
        parent_run_id: 'parent-1',
      });

      const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(params).toEqual(['conv-1', 'cb-1', 'parent-1', 'P4 Phase', 5, '{}']);
    });

    test('throws on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(
        createCoordinatorRun({
          conversation_id: 'conv-1',
          codebase_id: 'cb-1',
          name: 'P4 Phase',
        })
      ).rejects.toThrow('Failed to create coordinator run: Connection refused');
    });
  });

  describe('getCoordinatorRun', () => {
    test('returns the row by id', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockRun]));

      const result = await getCoordinatorRun('run-1');

      expect(result).toEqual(mockRun);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM remote_agent_coordinator_runs WHERE id = $1',
        ['run-1']
      );
    });

    test('returns null when no row matches', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await getCoordinatorRun('missing');

      expect(result).toBeNull();
    });

    test('parses string metadata into an object (SQLite shape)', async () => {
      const sqliteRow = {
        ...mockRun,
        metadata: '{"source":"cli"}' as unknown as Record<string, unknown>,
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([sqliteRow]));

      const result = await getCoordinatorRun('run-1');

      expect(result?.metadata).toEqual({ source: 'cli' });
    });
  });

  describe('listCoordinatorRuns', () => {
    test('composes filters by codebaseId, conversationId, and status', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await listCoordinatorRuns({
        codebaseId: 'cb-1',
        conversationId: 'conv-1',
        status: 'active',
      });

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('conversation_id = $1');
      expect(query).toContain('codebase_id = $2');
      expect(query).toContain('status IN ($3)');
      expect(params.slice(0, 3)).toEqual(['conv-1', 'cb-1', 'active']);
    });

    test('honors a status array using IN clause', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await listCoordinatorRuns({ status: ['active', 'paused'] });

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('status IN ($1, $2)');
      expect(params.slice(0, 2)).toEqual(['active', 'paused']);
    });

    test('uses default limit and offset when not provided', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await listCoordinatorRuns();

      const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      // Last two values are limit (50) then offset (0).
      expect(params[params.length - 2]).toBe(50);
      expect(params[params.length - 1]).toBe(0);
    });
  });

  describe('updateCoordinatorRunStatus', () => {
    test('transitions to a non-terminal status without setting completed_at', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateCoordinatorRunStatus('run-1', 'active');

      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('status = $1');
      expect(query).not.toContain('completed_at = NOW()');
    });

    test('auto-sets completed_at when transitioning to a terminal status', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateCoordinatorRunStatus('run-1', 'completed');

      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('completed_at = NOW()');
    });

    test('refuses to transition out of a terminal status (rowCount === 0 throws)', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0));

      await expect(updateCoordinatorRunStatus('run-1', 'active')).rejects.toThrow(
        'no run found with id'
      );

      // SQL must filter out terminal rows, otherwise the guard isn't enforced.
      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('status NOT IN');
    });

    test('merges metadata via dialect.jsonMerge (does not REPLACE)', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateCoordinatorRunStatus('run-1', 'paused', { reason: 'user' });

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('metadata = metadata || ');
      expect(params).toContain('{"reason":"user"}');
    });
  });

  describe('deleteCoordinatorRun', () => {
    test('returns true when a row was deleted', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      const result = await deleteCoordinatorRun('run-1');

      expect(result).toBe(true);
      expect(mockQuery).toHaveBeenCalledWith(
        'DELETE FROM remote_agent_coordinator_runs WHERE id = $1',
        ['run-1']
      );
    });

    test('returns false when no row matched', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0));

      const result = await deleteCoordinatorRun('missing');

      expect(result).toBe(false);
    });
  });
});
