import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { loadConfig, toDbConfig } from '../../src/config';
import { createHealthProbe, createPool } from '../../src/db';
import type { HealthResponse } from '../../src/routes/health';
import type { ErrorResponse } from '../../src/errors';
import type { Pool } from 'pg';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';
import { PgFaultProxy } from '../support/pg-fault-proxy';
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
  sample,
  tiantianSamples,
  upstreamDown,
  type Replay,
} from '../support/recorded-upstream';

/** 健康检查在数据库无响应时的返回期限（连接 2 秒 + 探针查询 2 秒，留出余量）。 */
const DB_PROBE_BUDGET_MS = 5_000;

/**
 * 盘中样子的天天基金样本：录制样本取自当晚，110020 的基准已是当天净值；还原成 2026-11-05 的
 * 基准（与录制的东方财富净值一致），估值才会通过基准核对被采纳。
 */
function intradayTiantian(): Replay {
  const body = JSON.parse(sample('tiantian/valuation-000001-110020-040046-999999.json')) as {
    data: Record<string, unknown>[];
  };
  body.data = body.data.map((row) =>
    row.FCODE === '110020' ? { ...row, PDATE: '2026-11-05', NAV: 1.703 } : row,
  );
  return tiantianSamples(JSON.stringify(body));
}

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

  describe('database faults injected outside the process', () => {
    let proxy: PgFaultProxy;
    let pool: Pool;
    let app: ReturnType<typeof createApp>;

    async function status(path: string): Promise<{ status: number; ms: number; code?: string }> {
      const started = Date.now();
      const res = await app.request(path);
      const body = (await res.json()) as Partial<ErrorResponse>;
      return { status: res.status, ms: Date.now() - started, code: body.error?.code };
    }

    beforeEach(async () => {
      const config = toDbConfig(loadConfig());
      proxy = new PgFaultProxy({ host: config.host, port: config.port });
      await proxy.start();
      // 本用例的临时 schema，连接经过可控代理。
      pool = createPool({ ...config, host: '127.0.0.1', port: proxy.port, schema: db.schema });
      app = createApp({ db: createHealthProbe(pool), clock: { now: () => new Date() } });
    });

    afterEach(async () => {
      await proxy.stop();
      await pool.end();
    });

    it('keeps serving when PostgreSQL drops its connections, reports 503 while it is down and reconnects after it returns', async () => {
      expect((await status('/v1/health')).status).toBe(200);

      // 断开池里的空闲连接并拒绝新连接，等同数据库重启期间。
      await proxy.refuse();
      const down = await status('/v1/health');
      expect(down).toMatchObject({ status: 503, code: 'database_unavailable' });
      // 进程仍在服务不依赖数据库的接口。
      expect((await app.request('/v1/openapi')).status).toBe(200);

      await proxy.restore();
      expect((await status('/v1/health')).status).toBe(200);

      // 只终止现有连接（不拒绝新连接）：下一次检查重新连上。
      proxy.cut();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect((await status('/v1/health')).status).toBe(200);
    });

    it('answers 503 within a few seconds when new connections hang', async () => {
      await proxy.refuse();
      proxy.stall();
      await proxy.restore();
      proxy.stall();
      const result = await status('/v1/health');
      expect(result).toMatchObject({ status: 503, code: 'database_unavailable' });
      expect(result.ms).toBeLessThan(DB_PROBE_BUDGET_MS);
    }, 15_000);

    it('answers 503 within a few seconds when an open connection stops responding', async () => {
      expect((await status('/v1/health')).status).toBe(200);
      proxy.stall();
      const result = await status('/v1/health');
      expect(result).toMatchObject({ status: 503, code: 'database_unavailable' });
      expect(result.ms).toBeLessThan(DB_PROBE_BUDGET_MS);

      proxy.cut();
      await proxy.refuse();
      await proxy.restore();
      expect((await status('/v1/health')).status).toBe(200);
    }, 15_000);
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
      upstream.use(estimateSamples({ tiantian: intradayTiantian() }));
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

    describe('bad data does not count as success', () => {
      const primaryDown = (url: URL) =>
        url.hostname === 'qt.gtimg.cn'
          ? new UpstreamError('timeout', 'primary unavailable')
          : thsInconsistent(url);
      const thsInconsistent: Replay = (url) => {
        if (url.pathname.includes('/realhead/'))
          return 'callback({"items":{"10":"3000","6":"2900"}})';
        const symbol = url.pathname.split('/')[3]!;
        return `callback(${JSON.stringify({ [symbol]: { pre: '2800', date: '20261106', data: '1500,3000,100,3000,100' } })})`;
      };

      it.each([
        [
          'tencent',
          'non-empty malformed quote lines',
          (url: URL) =>
            url.hostname === 'qt.gtimg.cn'
              ? 'v_sh000001="garbage";'
              : new UpstreamError('timeout', 'backup unavailable'),
        ],
        ['ths', 'snapshot and minutes that disagree', primaryDown],
      ] as const)(
        'keeps %s at null after %s leave every index unavailable',
        async (source, _what, replay) => {
          upstream.use(replay);
          const app = createApp({ db: createHealthProbe(db.pool), upstream, clock });
          const res = await app.request('/v1/market/indices');
          expect(res.status).toBe(200);
          const body = (await res.json()) as { items: { available: boolean }[] };
          expect(body.items.every((item) => !item.available)).toBe(true);
          expect((await health(app)).upstreams[source].lastSuccessAt).toBeNull();
        },
      );

      it.each([
        [
          'tiantian',
          {
            tiantian: () =>
              '{"success":true,"errorCode":0,"data":[{"FCODE":"000001","GSZ":"garbage"}]}',
            sina: upstreamDown(),
          },
        ],
        ['sina', { tiantian: upstreamDown(), sina: () => 'var hq_str_fu_000001="garbage";' }],
      ] as const)(
        'keeps %s at null after a malformed estimate row leaves the fund unavailable',
        async (source, overrides) => {
          await importHolidays(db.pool, cn2026.year, cn2026.holidays);
          const tradingCalendar = await loadTradingCalendar(db.pool);
          clock.set('2026-11-06T02:00:00.000Z');
          upstream.use(estimateSamples(overrides));
          const app = createApp({
            db: createHealthProbe(db.pool),
            upstream,
            clock,
            tradingCalendar,
          });
          const res = await app.request('/v1/funds/estimates?codes=000001');
          expect(res.status).toBe(200);
          expect(((await res.json()) as { items: unknown[] }).items).toEqual([
            { code: '000001', status: 'unavailable', estimate: null },
          ]);
          expect((await health(app)).upstreams[source].lastSuccessAt).toBeNull();
        },
      );

      it('keeps eastmoney at null for malformed NAV rows and for legal empty results', async () => {
        const app = createApp({ db: createHealthProbe(db.pool), upstream, clock });
        // 合法空结果：搜索无匹配、基金不存在。上游正常应答但没有给出可用数据，不算成功也不算失败。
        await call(app, '/v1/funds/search?q=~~');
        await call(app, '/v1/funds/999999', 404);
        upstream.use(
          () =>
            '{"ErrCode":0,"Data":{"LSJZList":[{"FSRQ":"garbage","DWJZ":"n/a","LJJZ":null,"JZZZL":null}]}}',
        );
        await app.request('/v1/funds/000001/nav');
        expect((await health(app)).upstreams.eastmoney.lastSuccessAt).toBeNull();
      });
    });

    it('does not refresh the time when a request is answered from cache', async () => {
      const app = createApp({ db: createHealthProbe(db.pool), upstream, clock });
      upstream.use(quoteSamples);
      await call(app, '/v1/market/indices');
      clock.set('2026-11-06T13:01:00.000Z');
      await call(app, '/v1/market/indices');
      upstream.use(eastmoneySamples);
      await call(app, '/v1/funds/search?q=000001');
      clock.set('2026-11-06T13:02:00.000Z');
      await call(app, '/v1/funds/search?q=000001');
      const body = await health(app);
      expect(body.upstreams.tencent.lastSuccessAt).toBe('2026-11-06T13:00:00.000Z');
      expect(body.upstreams.eastmoney.lastSuccessAt).toBe('2026-11-06T13:01:00.000Z');
    });

    it('does not refresh estimate sources when estimates are answered from cache', async () => {
      await importHolidays(db.pool, cn2026.year, cn2026.holidays);
      const tradingCalendar = await loadTradingCalendar(db.pool);
      clock.set('2026-11-06T02:00:00.000Z');
      upstream.use(estimateSamples({ tiantian: intradayTiantian() }));
      const app = createApp({ db: createHealthProbe(db.pool), upstream, clock, tradingCalendar });
      await call(app, '/v1/funds/estimates?codes=110020');
      clock.set('2026-11-06T02:00:10.000Z');
      await call(app, '/v1/funds/estimates?codes=110020');
      expect((await health(app)).upstreams.tiantian.lastSuccessAt).toBe('2026-11-06T02:00:00.000Z');
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
