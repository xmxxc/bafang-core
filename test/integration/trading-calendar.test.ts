import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { createHealthProbe } from '../../src/db';
import type { MarketStatusResponse } from '../../src/routes/market-status';
import { loadTradingCalendar } from '../../src/trading-calendar';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

interface HolidayFileEntry {
  date: string;
  name: string;
}

function writeHolidaysFile(year: number, holidays: HolidayFileEntry[]): string {
  const file = join(tmpdir(), `holidays-${year}-${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify({ year, holidays }));
  return file;
}

function fixedClock(iso: string) {
  const now = new Date(iso);
  return { now: () => now };
}

describe('trading calendar import via the CLI, observed over HTTP', () => {
  let db: TestSchema;
  const files: string[] = [];

  beforeEach(async () => {
    db = await createTestSchema();
  });

  afterEach(async () => {
    for (const file of files) rmSync(file, { force: true });
    files.length = 0;
    await dropTestSchema(db);
  });

  function importCli(args: string[]): { status: number | null; output: string } {
    const result = spawnSync('pnpm', ['trading-calendar:import', ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, PGSCHEMA: db.schema },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  }

  async function marketStatus(clockIso: string): Promise<MarketStatusResponse> {
    const calendar = await loadTradingCalendar(db.pool);
    const target = createApp({
      db: createHealthProbe(db.pool),
      clock: fixedClock(clockIso),
      tradingCalendar: calendar,
    });
    const res = await target.request('/v1/market/status');
    expect(res.status).toBe(200);
    return (await res.json()) as MarketStatusResponse;
  }

  it('imports a year via the CLI and the imported holiday takes effect over HTTP', async () => {
    const file = writeHolidaysFile(2027, [{ date: '2027-01-01', name: '元旦' }]);
    files.push(file);
    expect(importCli(['2027', '--file', file]).status).toBe(0);

    expect((await marketStatus('2027-01-01T02:00:00.000Z')).status).toBe('holiday');
    expect((await marketStatus('2027-01-04T02:00:00.000Z')).status).toBe('trading');
  });

  it('re-importing the same file is idempotent', async () => {
    const file = writeHolidaysFile(2027, [{ date: '2027-01-01', name: '元旦' }]);
    files.push(file);
    expect(importCli(['2027', '--file', file]).status).toBe(0);
    expect(importCli(['2027', '--file', file]).status).toBe(0);

    expect((await marketStatus('2027-01-01T02:00:00.000Z')).status).toBe('holiday');
    expect((await marketStatus('2027-01-04T02:00:00.000Z')).status).toBe('trading');
  });

  it('rejects duplicate dates and leaves the previously imported data intact', async () => {
    const good = writeHolidaysFile(2027, [{ date: '2027-01-01', name: '元旦' }]);
    files.push(good);
    expect(importCli(['2027', '--file', good]).status).toBe(0);

    const duplicated = writeHolidaysFile(2027, [
      { date: '2027-06-01', name: '某节' },
      { date: '2027-06-01', name: '某节重复' },
    ]);
    files.push(duplicated);
    expect(importCli(['2027', '--file', duplicated]).status).not.toBe(0);

    expect((await marketStatus('2027-01-01T02:00:00.000Z')).status).toBe('holiday');
    expect((await marketStatus('2027-06-01T02:00:00.000Z')).status).toBe('trading');
  });

  it('rejects an invalid date format and leaves the previously imported data intact', async () => {
    const good = writeHolidaysFile(2027, [{ date: '2027-01-01', name: '元旦' }]);
    files.push(good);
    expect(importCli(['2027', '--file', good]).status).toBe(0);

    const badFormat = writeHolidaysFile(2027, [{ date: '2027/01/05', name: '坏格式' }]);
    files.push(badFormat);
    expect(importCli(['2027', '--file', badFormat]).status).not.toBe(0);

    expect((await marketStatus('2027-01-01T02:00:00.000Z')).status).toBe('holiday');
    expect((await marketStatus('2027-01-05T02:00:00.000Z')).status).toBe('trading');
  });

  it('rejects a holiday belonging to another year and leaves the previously imported data intact', async () => {
    const good = writeHolidaysFile(2027, [{ date: '2027-01-01', name: '元旦' }]);
    files.push(good);
    expect(importCli(['2027', '--file', good]).status).toBe(0);

    const wrongYear = writeHolidaysFile(2027, [{ date: '2026-01-05', name: '跨年' }]);
    files.push(wrongYear);
    expect(importCli(['2027', '--file', wrongYear]).status).not.toBe(0);

    expect((await marketStatus('2027-01-01T02:00:00.000Z')).status).toBe('holiday');
    expect((await marketStatus('2027-01-04T02:00:00.000Z')).status).toBe('trading');
  });
});
