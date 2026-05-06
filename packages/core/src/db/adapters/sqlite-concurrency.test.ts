import { describe, test, expect, afterEach } from 'bun:test';
import { unlinkSync } from 'fs';
import { join } from 'path';

let currentDbPath = '';

function freshDbPath(): string {
  currentDbPath = join(
    import.meta.dir,
    `.test-sqlite-concurrency-${String(Date.now())}-${Math.random().toString(36).slice(2)}.db`
  );
  return currentDbPath;
}

async function spawnWorker(dbPath: string): Promise<{ exitCode: number; stderr: string }> {
  const workerPath = join(import.meta.dir, 'sqlite-concurrency-worker.ts');
  // Use process.execPath (the running bun binary) instead of bare "bun" so
  // the test works on PATH-restricted CI runners where `bun` isn't on PATH.
  const proc = Bun.spawn({
    cmd: [process.execPath, 'run', workerPath, dbPath],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { exitCode, stderr };
}

describe('SqliteAdapter concurrent multi-process access', () => {
  afterEach(() => {
    try {
      unlinkSync(currentDbPath);
    } catch {
      /* may not exist */
    }
    try {
      unlinkSync(currentDbPath + '-wal');
    } catch {
      /* may not exist */
    }
    try {
      unlinkSync(currentDbPath + '-shm');
    } catch {
      /* may not exist */
    }
  });

  test('two simultaneous worker processes both succeed without lock errors', async () => {
    const dbPath = freshDbPath();
    const [a, b] = await Promise.all([spawnWorker(dbPath), spawnWorker(dbPath)]);
    expect({ exitCode: a.exitCode, stderr: a.stderr }).toEqual({ exitCode: 0, stderr: '' });
    expect({ exitCode: b.exitCode, stderr: b.stderr }).toEqual({ exitCode: 0, stderr: '' });
    expect(a.stderr + b.stderr).not.toMatch(/database is locked/i);
  }, 30_000);

  test('5 simultaneous workers all succeed (stress)', async () => {
    const dbPath = freshDbPath();
    const results = await Promise.all([
      spawnWorker(dbPath),
      spawnWorker(dbPath),
      spawnWorker(dbPath),
      spawnWorker(dbPath),
      spawnWorker(dbPath),
    ]);
    for (const r of results) {
      expect({ exitCode: r.exitCode, stderr: r.stderr }).toEqual({ exitCode: 0, stderr: '' });
    }
  }, 60_000);
});
