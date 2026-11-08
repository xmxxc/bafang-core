import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { loadConfig, toDbConfig } from '../../src/config';
import { createHealthProbe, createPool } from '../../src/db';
import type { Pool } from 'pg';
import type { MarketStatusResponse } from '../../src/routes/market-status';
import { loadTradingCalendar } from '../../src/trading-calendar';

// 双份全量测试并发时，CLI 用例实测最慢约 6.5 秒；取 2 倍余量并向上取整。
vi.setConfig({ testTimeout: 15_000 });

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function runCli(
  args: string[],
  env: Record<string, string>,
): { status: number | null; output: string } {
  const result = spawnSync('pnpm', args, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

describe('db:migrate and the import honor the same custom schema, observed over HTTP', () => {
  let schema: string;
  let pool: Pool;
  const files: string[] = [];

  beforeEach(() => {
    schema = `s7_${randomUUID().replaceAll('-', '')}`;
    pool = createPool({ ...toDbConfig(loadConfig()), schema });
  });

  afterEach(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await pool.end();
    for (const file of files) rmSync(file, { force: true });
    files.length = 0;
  });

  it('migrates, imports and serves a holiday end to end under a custom schema', async () => {
    const holidayFile = join(tmpdir(), `holidays-${randomUUID()}.json`);
    writeFileSync(
      holidayFile,
      JSON.stringify({ year: 2027, holidays: [{ date: '2027-01-01', name: '元旦' }] }),
    );
    files.push(holidayFile);

    const migrated = runCli(['db:migrate'], { PGSCHEMA: schema });
    expect(migrated.status).toBe(0);

    const imported = runCli(['trading-calendar:import', '2027', '--file', holidayFile], {
      PGSCHEMA: schema,
    });
    expect(imported.status).toBe(0);

    const calendar = await loadTradingCalendar(pool);
    const app = createApp({
      db: createHealthProbe(pool),
      clock: { now: () => new Date('2027-01-01T02:00:00.000Z') },
      tradingCalendar: calendar,
    });
    const res = await app.request('/v1/market/status');
    expect(res.status).toBe(200);
    expect(((await res.json()) as MarketStatusResponse).status).toBe('holiday');
  });
});
