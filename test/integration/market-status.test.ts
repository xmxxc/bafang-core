import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../../src/app';
import { createHealthProbe } from '../../src/db';
import type { MarketStatusResponse } from '../../src/routes/market-status';
import { ChineseTradingCalendar, type TradingCalendar } from '../../src/trading-calendar';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';

function fixedClock(iso: string) {
  const now = new Date(iso);
  return { now: () => now };
}

/** 读取随仓库发布的 2026 年休市日数据。 */
function holidaysFromDataFile(): string[] {
  const url = new URL('../../data/holidays/2026.json', import.meta.url);
  const parsed = JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as {
    holidays: { date: string }[];
  };
  return parsed.holidays.map((entry) => entry.date);
}

describe('GET /v1/market/status over in-process HTTP', () => {
  let db: TestSchema;

  function app(deps: AppDeps, clock: { now: () => Date }) {
    return createApp({ db: createHealthProbe(db.pool), clock, ...deps });
  }

  beforeEach(async () => {
    db = await createTestSchema();
  });

  afterEach(async () => {
    await dropTestSchema(db);
  });

  const alwaysTrading: TradingCalendar = { isTradingDay: () => true };

  it('reports pre_market before 09:30 on a trading day', async () => {
    const res = await app(
      { tradingCalendar: alwaysTrading },
      fixedClock('2026-11-06T01:00:00.000Z'),
    ).request('/v1/market/status');
    expect(res.status).toBe(200);
    expect(((await res.json()) as MarketStatusResponse).status).toBe('pre_market');
  });

  it('reports trading during 09:30–15:00 on a trading day', async () => {
    const res = await app(
      { tradingCalendar: alwaysTrading },
      fixedClock('2026-11-06T02:00:00.000Z'),
    ).request('/v1/market/status');
    expect(res.status).toBe(200);
    expect(((await res.json()) as MarketStatusResponse).status).toBe('trading');
  });

  it('reports closed after 15:00 on a trading day', async () => {
    const res = await app(
      { tradingCalendar: alwaysTrading },
      fixedClock('2026-11-06T07:30:00.000Z'),
    ).request('/v1/market/status');
    expect(res.status).toBe(200);
    expect(((await res.json()) as MarketStatusResponse).status).toBe('closed');
  });

  it('reports holiday on a weekend', async () => {
    // 2026-11-07 is a Saturday
    const res = await app(
      { tradingCalendar: new ChineseTradingCalendar() },
      fixedClock('2026-11-07T02:00:00.000Z'),
    ).request('/v1/market/status');
    expect(res.status).toBe(200);
    expect(((await res.json()) as MarketStatusResponse).status).toBe('holiday');
  });

  it('reports holiday on a weekday holiday', async () => {
    // 2026-10-01 is National Day, a Thursday
    const res = await app(
      { tradingCalendar: new ChineseTradingCalendar(['2026-10-01']) },
      fixedClock('2026-10-01T02:00:00.000Z'),
    ).request('/v1/market/status');
    expect(res.status).toBe(200);
    expect(((await res.json()) as MarketStatusResponse).status).toBe('holiday');
  });

  it('treats the shipped 2026 holidays as holidays and the following weekday as trading', async () => {
    const calendar = new ChineseTradingCalendar(holidaysFromDataFile());
    const holiday = await app(
      { tradingCalendar: calendar },
      fixedClock('2026-10-01T02:00:00.000Z'),
    ).request('/v1/market/status');
    expect(((await holiday.json()) as MarketStatusResponse).status).toBe('holiday');

    const nextTradingDay = await app(
      { tradingCalendar: calendar },
      fixedClock('2026-10-08T02:00:00.000Z'),
    ).request('/v1/market/status');
    expect(((await nextTradingDay.json()) as MarketStatusResponse).status).toBe('trading');
  });

  it('serves the market status anonymously and includes the reference time', async () => {
    const res = await app(
      { tradingCalendar: alwaysTrading },
      fixedClock('2026-11-06T02:00:00.000Z'),
    ).request('/v1/market/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as MarketStatusResponse;
    expect(body.status).toBe('trading');
    expect(body.time).toBe('2026-11-06T02:00:00.000Z');
  });
});
