import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { loadConfig, toDbConfig } from '../../src/config';
import { createHealthProbe, createPool } from '../../src/db';
import type { HealthResponse } from '../../src/routes/health';
import type { ErrorResponse } from '../../src/errors';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';
import { UpstreamError } from '../../src/market/upstream';
import { loadTradingCalendar } from '../../src/trading-calendar';
import { importHolidays } from '../../src/trading-calendar/holidays';
import cn2026 from '../../data/holidays/2026.json';
import {
  eastmoneySamples,
  estimateSamples,
  hostDown,
  quoteSamples,
  RecordedUpstream,
  upstreamDown,
} from '../support/recorded-upstream';

const NEVER = {
  eastmoney: { lastSuccessAt: null },
  tiantian: { lastSuccessAt: null },
  sina: { lastSuccessAt: null },
  tencent: { lastSuccessAt: null },
  ths: { lastSuccessAt: null },
};

function movableClock(iso: string) {
  let now = new Date(iso);
  return {
    now: () => now,
    set: (next: string) => {
      now = new Date(next);
    },
  };
}

describe('GET /v1/health over in-process HTTP against a real PostgreSQL test database', () => {
  let db: TestSchema;

  beforeEach(async () => {
    db = await createTestSchema();
  });

  afterEach(async () => {
    await dropTestSchema(db);
  });

  it('reports ok with database connectivity and the injected clock time', async () => {
    const fixed = new Date('2024-01-02T03:04:05.000Z');
    const app = createApp({
      db: createHealthProbe(db.pool),
      clock: { now: () => fixed },
      tradingCalendar: { isTradingDay: () => false },
    });
    const res = await app.request('/v1/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    expect(body.status).toBe('ok');
    expect(body.database.connected).toBe(true);
    expect(body.time).toBe(fixed.toISOString());
    expect(body.upstreams).toEqual(NEVER);
  });

  it('uses the default system clock when none is injected', async () => {
    const before = Date.now();
    const app = createApp({ db: createHealthProbe(db.pool) });
    const res = await app.request('/v1/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    const time = new Date(body.time).getTime();
    expect(time).toBeGreaterThanOrEqual(before);
    expect(time).toBeLessThanOrEqual(Date.now());
  });

  it('returns the unified 503 error when the database is unavailable', async () => {
    const closedPool = createPool(toDbConfig(loadConfig()));
    await closedPool.end();
    const app = createApp({ db: createHealthProbe(closedPool) });
    const res = await app.request('/v1/health');
    expect(res.status).toBe(503);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error.code).toBe('database_unavailable');
    expect(typeof body.error.message).toBe('string');
  });

  it('keeps serving and reports 503 after an idle database connection errors', async () => {
    const pool = createPool(toDbConfig(loadConfig()));
    try {
      const app = createApp({ db: createHealthProbe(pool) });
      expect((await app.request('/v1/health')).status).toBe(200);
      // pg emits this when the server terminates an idle connection (e.g. PostgreSQL restarts).
      expect(() => pool.emit('error', new Error('terminating connection'))).not.toThrow();
      await pool.end();
      const res = await app.request('/v1/health');
      expect(res.status).toBe(503);
      expect(((await res.json()) as ErrorResponse).error.code).toBe('database_unavailable');
    } finally {
      if (!pool.ended) await pool.end();
    }
  });

  it('returns the unified 500 error when the injected clock throws', async () => {
    const app = createApp({
      db: createHealthProbe(db.pool),
      clock: {
        now: () => {
          throw new Error('boom');
        },
      },
    });
    const res = await app.request('/v1/health');
    expect(res.status).toBe(500);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error.code).toBe('internal_error');
    expect(typeof body.error.message).toBe('string');
  });

  describe('upstream last success times', () => {
    let upstream: RecordedUpstream;
    let clock: ReturnType<typeof movableClock>;

    async function health(app: ReturnType<typeof createApp>): Promise<HealthResponse> {
      const res = await app.request('/v1/health');
      expect(res.status).toBe(200);
      return (await res.json()) as HealthResponse;
    }

    async function call(app: ReturnType<typeof createApp>, path: string, status = 200) {
      const res = await app.request(path);
      expect(res.status).toBe(status);
    }

    beforeEach(async () => {
      upstream = new RecordedUpstream(eastmoneySamples);
      // Friday 2026-11-06 21:00 Asia/Shanghai — both markets have closed for the day.
      clock = movableClock('2026-11-06T13:00:00.000Z');
    });

    it('lists every market upstream with null before any request succeeds', async () => {
      const app = createApp({ db: createHealthProbe(db.pool), upstream, clock });
      const body = await health(app);
      expect(body.upstreams).toEqual(NEVER);
    });

    it('records the time of the last validated response per upstream, without addresses', async () => {
      const app = createApp({ db: createHealthProbe(db.pool), upstream, clock });
      await call(app, '/v1/funds/search?q=000001');
      clock.set('2026-11-06T13:05:00.000Z');
      upstream.use(quoteSamples);
      await call(app, '/v1/market/indices');

      const res = await app.request('/v1/health');
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(JSON.parse(text).upstreams).toEqual({
        ...NEVER,
        eastmoney: { lastSuccessAt: '2026-11-06T13:00:00.000Z' },
        tencent: { lastSuccessAt: '2026-11-06T13:05:00.000Z' },
      });
      expect(text).not.toMatch(/https?:|eastmoney\.com|gtimg|10jqka|sinajs/);
    });

    it('records the fallback upstream and leaves the failing one untouched', async () => {
      upstream.use(hostDown('qt.gtimg.cn', quoteSamples));
      const app = createApp({ db: createHealthProbe(db.pool), upstream, clock });
      await call(app, '/v1/market/indices');
      const body = await health(app);
      expect(body.upstreams.tencent.lastSuccessAt).toBeNull();
      expect(body.upstreams.ths.lastSuccessAt).toBe('2026-11-06T13:00:00.000Z');
    });

    it('keeps the previous success time when later requests fail or return an invalid body', async () => {
      const app = createApp({ db: createHealthProbe(db.pool), upstream, clock });
      await call(app, '/v1/funds/search?q=000001');
      clock.set('2026-11-06T13:10:00.000Z');
      upstream.use(upstreamDown());
      await call(app, '/v1/funds/search?q=hxcz', 502);
      upstream.use(() => '{"ErrCode":1,"Datas":null}');
      await call(app, '/v1/funds/search?q=zzzzqqqxx', 502);
      upstream.use(() => new UpstreamError('http_status', 'recorded 500', 500));
      await call(app, '/v1/market/indices');
      const body = await health(app);
      expect(body.upstreams).toEqual({
        ...NEVER,
        eastmoney: { lastSuccessAt: '2026-11-06T13:00:00.000Z' },
      });
    });

    it('records Tiantian, and Sina when it is used as the estimate fallback', async () => {
      await importHolidays(db.pool, cn2026.year, cn2026.holidays);
      const tradingCalendar = await loadTradingCalendar(db.pool);
      // Friday 2026-11-06 10:00 Asia/Shanghai — trading.
      clock.set('2026-11-06T02:00:00.000Z');
      upstream.use(estimateSamples());
      const app = createApp({ db: createHealthProbe(db.pool), upstream, clock, tradingCalendar });
      await call(app, '/v1/funds/estimates?codes=110020');
      let body = await health(app);
      expect(body.upstreams.tiantian.lastSuccessAt).toBe('2026-11-06T02:00:00.000Z');

      clock.set('2026-11-06T02:01:00.000Z');
      upstream.use(estimateSamples({ tiantian: upstreamDown() }));
      await call(app, '/v1/funds/estimates?codes=000001');
      body = await health(app);
      expect(body.upstreams.tiantian.lastSuccessAt).toBe('2026-11-06T02:00:00.000Z');
      expect(body.upstreams.sina.lastSuccessAt).toBe('2026-11-06T02:01:00.000Z');
      expect(body.upstreams.eastmoney.lastSuccessAt).not.toBeNull();
    });

    it('still answers 503 when the database is unavailable, even after upstream successes', async () => {
      const closedPool = createPool(toDbConfig(loadConfig()));
      await closedPool.end();
      const app = createApp({ db: createHealthProbe(closedPool), upstream, clock });
      await call(app, '/v1/funds/search?q=000001');
      const res = await app.request('/v1/health');
      expect(res.status).toBe(503);
      expect(((await res.json()) as ErrorResponse).error.code).toBe('database_unavailable');
    });
  });
});
