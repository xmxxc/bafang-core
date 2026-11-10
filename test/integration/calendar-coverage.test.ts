import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { createDb } from '../../src/db';
import {
  ChineseTradingCalendar,
  loadTradingCalendar,
  type TradingCalendar,
} from '../../src/trading-calendar';
import { eastmoneySamples, RecordedUpstream } from '../support/recorded-upstream';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';

vi.setConfig({ testTimeout: 20_000 });
const run = promisify(execFile);

describe('年度日历覆盖与估值（生产加载器和 HTTP）', () => {
  let db: TestSchema;
  const files: string[] = [];
  let now: Date;
  let baseDate: string;

  beforeEach(async () => {
    db = await createTestSchema();
    now = new Date('2026-10-01T02:00:00Z');
    baseDate = '2026-09-30';
  });
  afterEach(async () => {
    await dropTestSchema(db);
    for (const file of files) rmSync(file, { force: true });
    files.length = 0;
  });

  async function importYear(
    year: number,
    holidays: { date: string; name: string }[],
    market = 'cn',
  ) {
    const file = join(tmpdir(), `coverage-${randomUUID()}.json`);
    files.push(file);
    writeFileSync(file, JSON.stringify({ year, market, holidays }));
    return run(
      'pnpm',
      ['trading-calendar:import', String(year), '--market', market, '--file', file],
      {
        env: { ...process.env, PGSCHEMA: db.schema },
        timeout: 15_000,
      },
    );
  }

  async function app(calendar?: TradingCalendar) {
    return createApp({
      database: createDb(db.pool),
      clock: { now: () => now },
      tradingCalendar: calendar ?? (await loadTradingCalendar(db.pool)),
      upstream: new RecordedUpstream((url) => {
        if (url.hostname === 'fundcomapi.tiantianfunds.com') {
          return JSON.stringify({
            success: true,
            data: [
              {
                FCODE: '000001',
                GSZ: '1.0100',
                GSZZL: 1,
                GZTIME: `${now.toISOString().slice(0, 10)} 15:00`,
                PDATE: baseDate,
                NAV: '1.0000',
              },
            ],
          });
        }
        if (url.hostname === 'api.fund.eastmoney.com') {
          return JSON.stringify({
            ErrCode: 0,
            Data: { LSJZList: [{ FSRQ: baseDate, DWJZ: '1.0000', LJJZ: '1.0000', JZZZL: '0' }] },
          });
        }
        if (url.hostname === 'hq.sinajs.cn') return 'var hq_str_fu_000001="";';
        return eastmoneySamples(url);
      }),
      wechat: { openid: async (code) => code },
    });
  }
  async function estimate(target: Awaited<ReturnType<typeof app>>) {
    const res = await target.request('/v1/funds/estimates?codes=000001');
    expect(res.status).toBe(200);
    return (await res.json()) as {
      marketStatus: string;
      items: { status: string; estimate: unknown }[];
    };
  }

  it('拒绝空日历的未知工作日，即使来源日期和净值完全匹配', async () => {
    expect((await estimate(await app(new ChineseTradingCalendar()))).items).toEqual([
      { code: '000001', status: 'unavailable', estimate: null },
    ]);
  });

  it('兼容旧日历调用方，但缺少覆盖方法时估值不可用', async () => {
    const target = await app({ isTradingDay: () => true });
    expect((await estimate(target)).items[0]?.status).toBe('unavailable');
    expect(await (await target.request('/v1/market/status')).json()).toMatchObject({
      status: 'trading',
    });
  });

  it('完整年度导入后区分已知节假日和正常交易日，且旧年份保持可用', async () => {
    await importYear(2026, [{ date: '2026-10-01', name: '国庆节' }]);
    const target = await app();
    expect((await estimate(target)).items[0]?.status).toBe('holiday');
    now = new Date('2026-10-02T02:00:00Z');
    // This explicitly imported test year has only one holiday.
    expect((await estimate(target)).items[0]?.status).toBe('estimated');
    await importYear(2028, []);
    expect((await estimate(await app())).items[0]?.status).toBe('estimated');
  });

  it('合法空年度只覆盖指定市场和年份', async () => {
    await importYear(2026, [], 'hk');
    expect((await estimate(await app())).items[0]?.status).toBe('unavailable');
    await importYear(2026, []);
    expect((await estimate(await app())).items[0]?.status).toBe('estimated');
    now = new Date('2027-10-01T02:00:00Z');
    baseDate = '2027-09-30';
    expect((await estimate(await app())).items[0]?.status).toBe('unavailable');
  });

  it('跨年向前检索遇到未知年度立即拒绝，不跳过未知日期', async () => {
    await importYear(2027, [{ date: '2027-01-01', name: '元旦' }]);
    now = new Date('2027-01-04T02:00:00Z');
    baseDate = '2026-12-31';
    expect((await estimate(await app())).items[0]?.status).toBe('unavailable');
    await importYear(2026, []);
    expect((await estimate(await app())).items[0]?.status).toBe('estimated');
  });

  it('数据库写入失败回滚休市日与覆盖，首次失败不会制造覆盖证明', async () => {
    // The shape passes CLI validation; PostgreSQL rejects the impossible date after DELETE.
    await expect(importYear(2026, [{ date: '2026-02-30', name: '无效日期' }])).rejects.toThrow();
    expect((await estimate(await app())).items[0]?.status).toBe('unavailable');
    await importYear(2026, [{ date: '2026-10-01', name: '国庆节' }]);
    await expect(importYear(2026, [{ date: '2026-02-30', name: '无效日期' }])).rejects.toThrow();
    expect((await estimate(await app())).items[0]?.status).toBe('holiday');
    now = new Date('2026-10-02T02:00:00Z');
    expect((await estimate(await app())).items[0]?.status).toBe('estimated');
  });

  it('同市场同年并发导入不会混合两个年度清单', async () => {
    await Promise.all([
      importYear(2026, [{ date: '2026-10-01', name: '清单A' }]),
      importYear(2026, [{ date: '2026-10-02', name: '清单B' }]),
    ]);
    const target = await app();
    const first = (await estimate(target)).items[0]?.status;
    now = new Date('2026-10-02T02:00:00Z');
    baseDate = first === 'holiday' ? '2026-09-30' : '2026-10-01';
    const second = (await estimate(await app())).items[0]?.status;
    expect([
      ['holiday', 'estimated'],
      ['estimated', 'holiday'],
    ]).toContainEqual([first, second]);
  });

  it('缓存的收盘估值跨入未覆盖年度后不会继续返回', async () => {
    await importYear(2026, []);
    now = new Date('2026-12-31T08:30:00Z');
    baseDate = '2026-12-30';
    const target = await app();
    expect((await estimate(target)).items[0]?.status).toBe('estimated');
    now = new Date('2027-01-01T02:00:00Z');
    baseDate = '2026-12-31';
    expect((await estimate(target)).items[0]?.status).toBe('unavailable');
    await importYear(2027, []);
    expect((await estimate(await app())).items[0]?.status).toBe('estimated');
  });

  it('生产加载器缺少覆盖时持仓今日收益不可用，导入后恢复', async () => {
    const target = await app();
    const login = await target.request('/v1/auth/wechat/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'coverage-user' }),
    });
    expect(login.status).toBe(200);
    const { token } = (await login.json()) as { token: string };
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const { items } = (await (await target.request('/v1/channels', { headers })).json()) as {
      items: { id: string }[];
    };
    const created = await target.request('/v1/positions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        channelId: items[0]!.id,
        fundCode: '000001',
        shares: '1000',
        totalCost: '1000',
      }),
    });
    expect(created.status).toBe(201);
    const position = (await created.json()) as { id: string };
    expect(position).toMatchObject({
      todayGain: null,
      todayGainRate: null,
      todayGainStatus: 'unavailable',
    });
    await importYear(2026, []);
    const reloaded = await app();
    expect(
      await (await reloaded.request(`/v1/positions/${position.id}`, { headers })).json(),
    ).toMatchObject({ todayGain: '10.00', todayGainStatus: 'estimated' });
  });

  it('空数据库生产加载器不会从未知工作日推断交易日覆盖', async () => {
    expect((await estimate(await app())).items[0]?.status).toBe('unavailable');
  });
});
