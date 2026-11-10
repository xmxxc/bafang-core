import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';

let db: TestSchema;
let child: ChildProcess | undefined;
let output: string;
let exited: Promise<[number | null, NodeJS.Signals | null]>;
const port = 3147;

beforeEach(async () => {
  db = await createTestSchema();
  output = '';
});
afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
  child = undefined;
  await dropTestSchema(db);
});

async function waitFor(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for child: ${output}`);
}

async function start(entry = 'src/index.ts', extraEnv = {}) {
  child = spawn(process.execPath, ['--import', 'tsx', entry], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      MAIL_TRANSPORT: 'dev-log',
      PGSCHEMA: db.schema,
      PORT: String(port),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  exited = once(child, 'exit') as typeof exited;
  child.stdout!.on('data', (data) => (output += String(data)));
  child.stderr!.on('data', (data) => (output += String(data)));
  await waitFor(() => output.includes('listening'));
}

async function expectReleased() {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(port, resolve);
  });
  await new Promise<void>((resolve, reject) =>
    listener.close((err) => (err ? reject(err) : resolve())),
  );
}

it.each(['SIGTERM', 'SIGINT'] as const)(
  '%s exits normally and releases the HTTP port',
  async (signal) => {
    await start();
    expect((await fetch(`http://localhost:${port}/v1/health`)).status).toBe(200);
    child!.kill(signal);
    await waitFor(() => child!.exitCode !== null || child!.signalCode !== null);
    expect(await exited).toEqual([0, null]);
    expect(output).not.toContain('Called end on pool more than once');
    await expectReleased();
  },
);

it('drains a real application request before closing its pool on repeated signals', async () => {
  const lock = await db.pool.connect();
  let request: Promise<Response> | undefined;
  try {
    await lock.query('BEGIN');
    await lock.query('LOCK TABLE email_verification_codes IN ACCESS EXCLUSIVE MODE');
    await start();
    request = fetch(`http://localhost:${port}/v1/auth/email/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ email: 'shutdown@example.com' }),
    });
    // Observe the child's actual database query waiting on our transaction.
    await waitFor(async () => {
      const result = await db.pool.query(
        'SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
        [(await lock.query('SELECT pg_backend_pid() AS pid')).rows[0].pid],
      );
      return result.rowCount !== 0;
    });
    child!.kill('SIGTERM');
    await waitFor(() => output.includes('shutdown started'));
    child!.kill('SIGINT');
    await delay(100);
    child!.kill('SIGINT');
    expect(child!.exitCode).toBeNull();
    await lock.query('COMMIT');
    expect((await request).status).toBe(200);
    await waitFor(() => child!.exitCode !== null);
    expect(await exited).toEqual([0, null]);
    expect(output).toContain('shutdown complete');
    await expectReleased();
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
    // Ensure a failed assertion cannot leave an unobserved fetch rejection.
    await request?.catch(() => undefined);
  }
});

it('drains HTTP and settlement database work despite repeated mixed signals', async () => {
  const lock = await db.pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock(64001), pg_advisory_lock(64002)');
    await start('test/fixtures/shutdown/service.ts');
    const request = fetch(`http://localhost:${port}/work`, { headers: { Connection: 'close' } });
    await waitFor(
      () => output.includes('request started') && output.includes('settlement started'),
    );
    child!.kill('SIGTERM');
    await waitFor(() => output.includes('shutdown started'));
    child!.kill('SIGINT');
    await delay(100);
    child!.kill('SIGTERM');
    expect(child!.exitCode).toBeNull();
    await expect(fetch(`http://localhost:${port}/new`)).rejects.toThrow();
    await lock.query('SELECT pg_advisory_unlock_all()');
    expect(await (await request).text()).toBe('finished');
    await waitFor(() => child!.exitCode !== null);
    expect(await exited).toEqual([0, null]);
    expect(output).toContain('settlement finished');
    expect(output).toContain('shutdown complete');
    expect(output).not.toMatch(
      /settlement failed|shutdown failed|more than once|after calling end/,
    );
    await expectReleased();
  } finally {
    await lock.query('SELECT pg_advisory_unlock_all()');
    lock.release();
  }
});

it('logs a deadline and exits nonzero when work cannot drain', async () => {
  const lock = await db.pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock(64002)');
    await start('test/fixtures/shutdown/service.ts', { SHORT_DEADLINE: '1' });
    child!.kill('SIGINT');
    await waitFor(() => child!.exitCode !== null);
    expect(await exited).toEqual([1, null]);
    expect(output).toContain('shutdown timed out after 300ms');
    await expectReleased();
  } finally {
    await lock.query('SELECT pg_advisory_unlock_all()');
    lock.release();
  }
});

it('logs a close failure and exits nonzero', async () => {
  await start('test/fixtures/shutdown/service.ts', { FAIL_CLOSE: '1' });
  child!.kill('SIGTERM');
  await waitFor(() => child!.exitCode !== null);
  expect(await exited).toEqual([1, null]);
  expect(output).toContain('shutdown failed');
  expect(output).toContain('injected close failure');
  await expectReleased();
});
