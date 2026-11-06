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
import { loadHongKongTradingCalendar, loadTradingCalendar } from '../../src/trading-calendar';
import type { MarketIndicesResponse } from '../../src/routes/market-indices';
import { quoteSamples, RecordedUpstream } from '../support/recorded-upstream';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

interface HolidayFileEntry {
  date: string;
  name: string;
  earlyClose?: string;
}

function writeHolidaysFile(year: number, holidays: HolidayFileEntry[], market?: string): string {
  const file = join(tmpdir(), `holidays-${year}-${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify({ year, ...(market ? { market } : {}), holidays }));
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

  async function hangSengStatus(clockIso: string): Promise<string> {
    const target = createApp({
      db: createHealthProbe(db.pool),
      clock: fixedClock(clockIso),
      tradingCalendar: await loadTradingCalendar(db.pool),
      hkTradingCalendar: await loadHongKongTradingCalendar(db.pool),
      upstream: new RecordedUpstream(quoteSamples),
    });
    const res = await target.request('/v1/market/indices');
    expect(res.status).toBe(200);
    const body = (await res.json()) as MarketIndicesResponse;
    return body.items.find((item) => item.code === 'HSI.HK')!.marketStatus;
  }

  describe('Hong Kong market (--market hk)', () => {
    it('imports Hong Kong holidays and half-days that take effect over HTTP without touching A-shares', async () => {
      const file = writeHolidaysFile(
        2027,
        [
          { date: '2027-01-01', name: '元旦' },
          { date: '2027-03-26', name: '耶稣受难节' },
          { date: '2027-12-24', name: '圣诞节前夕', earlyClose: '12:10' },
        ],
        'hk',
      );
      files.push(file);
      expect(importCli(['2027', '--market', 'hk', '--file', file]).status).toBe(0);

      // 2027-03-26 (Fri): Hong Kong holiday only.
      expect(await hangSengStatus('2027-03-26T02:00:00.000Z')).toBe('holiday');
      expect((await marketStatus('2027-03-26T02:00:00.000Z')).status).toBe('trading');
      // 2027-12-24 (Fri) 14:00: Hong Kong half-day has closed; a normal day is still trading.
      expect(await hangSengStatus('2027-12-24T06:00:00.000Z')).toBe('closed');
      expect(await hangSengStatus('2027-12-24T03:00:00.000Z')).toBe('trading');
      expect(await hangSengStatus('2027-12-23T06:00:00.000Z')).toBe('trading');
    });

    it('keeps each market separate when the other market re-imports the same year', async () => {
      const cn = writeHolidaysFile(2027, [{ date: '2027-02-11', name: '春节' }]);
      const hk = writeHolidaysFile(2027, [{ date: '2027-03-26', name: '耶稣受难节' }], 'hk');
      files.push(cn, hk);
      expect(importCli(['2027', '--market', 'hk', '--file', hk]).status).toBe(0);
      expect(importCli(['2027', '--file', cn]).status).toBe(0);
      expect(importCli(['2027', '--market', 'hk', '--file', hk]).status).toBe(0);

      expect((await marketStatus('2027-02-11T02:00:00.000Z')).status).toBe('holiday');
      expect(await hangSengStatus('2027-02-11T02:00:00.000Z')).toBe('trading');
      expect(await hangSengStatus('2027-03-26T02:00:00.000Z')).toBe('holiday');
      expect((await marketStatus('2027-03-26T02:00:00.000Z')).status).toBe('trading');
    });

    it.each<[string, HolidayFileEntry[], string | undefined, string[]]>([
      [
        'a half-day in the A-share calendar',
        [{ date: '2027-12-24', name: '半日', earlyClose: '12:10' }],
        undefined,
        [],
      ],
      [
        'a malformed half-day close time',
        [{ date: '2027-12-24', name: '半日', earlyClose: '12点' }],
        'hk',
        ['--market', 'hk'],
      ],
      [
        'a file declaring another market',
        [{ date: '2027-03-26', name: '耶稣受难节' }],
        'cn',
        ['--market', 'hk'],
      ],
    ])(
      'rejects %s and leaves the previously imported data intact',
      async (_name, entries, market, flags) => {
        const good = writeHolidaysFile(2027, [{ date: '2027-03-26', name: '耶稣受难节' }], 'hk');
        files.push(good);
        expect(importCli(['2027', '--market', 'hk', '--file', good]).status).toBe(0);

        const bad = writeHolidaysFile(2027, entries, market);
        files.push(bad);
        expect(importCli(['2027', ...flags, '--file', bad]).status).not.toBe(0);

        expect(await hangSengStatus('2027-03-26T02:00:00.000Z')).toBe('holiday');
        expect(await hangSengStatus('2027-12-24T06:00:00.000Z')).toBe('trading');
      },
    );

    it('imports the shipped 2026 Hong Kong calendar from its default path', async () => {
      expect(importCli(['2026', '--market', 'hk']).status).toBe(0);
      expect(await hangSengStatus('2026-12-25T02:00:00.000Z')).toBe('holiday');
      expect(await hangSengStatus('2026-12-24T06:00:00.000Z')).toBe('closed');
      expect(await hangSengStatus('2026-10-05T02:00:00.000Z')).toBe('trading');
      expect((await marketStatus('2026-12-25T02:00:00.000Z')).status).toBe('trading');
    });
  });
});
