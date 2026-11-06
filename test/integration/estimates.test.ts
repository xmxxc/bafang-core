import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../../src/app';
import { createHealthProbe } from '../../src/db';
import type { ErrorResponse } from '../../src/errors';
import { UpstreamError } from '../../src/market/upstream';
import type { EstimateBatchResponse } from '../../src/routes/estimates';
import { ChineseTradingCalendar } from '../../src/trading-calendar';
import {
  estimateSamples,
  RecordedUpstream,
  sample,
  tiantianSamples,
  upstreamDown,
  type Replay,
} from '../support/recorded-upstream';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';

function movableClock(iso: string) {
  let now = new Date(iso);
  return {
    now: () => now,
    set: (next: string) => {
      now = new Date(next);
    },
  };
}

/** 一旦被调用就让请求以 500 失败：用来说明盘前、休市不会去访问上游。 */
const mustNotFetch: Replay = (url) => {
  throw new Error(`unexpected upstream request ${url.href}`);
};

/** 改写录制的天天基金样本里某只基金的字段。 */
function tiantianWith(code: string, patch: Record<string, unknown>): Replay {
  const body = JSON.parse(sample('tiantian/valuation-000001-110020-040046-999999.json')) as {
    data: Record<string, unknown>[];
  };
  body.data = body.data.map((row) => (row.FCODE === code ? { ...row, ...patch } : row));
  return tiantianSamples(JSON.stringify(body));
}

// 录制样本的估值时间（Asia/Shanghai 2026-11-06）
const TIANTIAN_110020 = {
  changePercent: -1.44,
  value: '1.6785',
  time: '2026-11-06T07:00:00.000Z',
  source: 'tiantian',
  sourceName: '天天基金',
  fallback: false,
  referenceOnly: true,
};
const SINA_000001 = {
  changePercent: -1.5738,
  value: '0.9843',
  time: '2026-11-06T08:02:00.000Z',
  source: 'sina',
  sourceName: '新浪财经',
  fallback: true,
  referenceOnly: true,
};
const SINA_110020 = {
  changePercent: -1.3531,
  value: '1.6800',
  time: '2026-11-06T08:03:00.000Z',
  source: 'sina',
  sourceName: '新浪财经',
  fallback: true,
  referenceOnly: true,
};

describe('GET /v1/funds/estimates over in-process HTTP against a real PostgreSQL test database', () => {
  let db: TestSchema;
  let upstream: RecordedUpstream;
  let clock: ReturnType<typeof movableClock>;

  function app(deps: AppDeps = {}) {
    return createApp({
      db: createHealthProbe(db.pool),
      upstream,
      clock,
      tradingCalendar: new ChineseTradingCalendar(),
      ...deps,
    });
  }

  async function get(target: ReturnType<typeof app>, codes: string) {
    const res = await target.request(`/v1/funds/estimates?codes=${codes}`);
    expect(res.status).toBe(200);
    return (await res.json()) as EstimateBatchResponse;
  }

  beforeEach(async () => {
    db = await createTestSchema();
    upstream = new RecordedUpstream(estimateSamples());
    // Friday 2026-11-06 10:00 Asia/Shanghai — trading
    clock = movableClock('2026-11-06T02:00:00.000Z');
  });

  afterEach(async () => {
    await dropTestSchema(db);
  });

  describe('batch request', () => {
    it('accepts several fund codes in one request and answers each in request order', async () => {
      const body = await get(app(), '110020,000001,040046');
      expect(body.marketStatus).toBe('trading');
      expect(body.time).toBe('2026-11-06T02:00:00.000Z');
      expect(body.items).toEqual([
        { code: '110020', status: 'estimated', estimate: TIANTIAN_110020 },
        { code: '000001', status: 'estimated', estimate: SINA_000001 },
        { code: '040046', status: 'unavailable', estimate: null },
      ]);
    });

    it('returns each duplicated code only once', async () => {
      const body = await get(app(), '110020,110020,000001');
      expect(body.items.map((item) => item.code)).toEqual(['110020', '000001']);
    });

    it.each([
      ['missing codes', '/v1/funds/estimates'],
      ['an empty list', '/v1/funds/estimates?codes='],
      ['a non 6-digit code', '/v1/funds/estimates?codes=000001,12345'],
      ['a trailing comma', '/v1/funds/estimates?codes=000001,'],
      [
        'more than 50 codes',
        `/v1/funds/estimates?codes=${Array.from({ length: 51 }, (_, i) => String(i).padStart(6, '0')).join(',')}`,
      ],
    ])('rejects %s with validation_error (400)', async (_name, path) => {
      const res = await app().request(path);
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorResponse).error.code).toBe('validation_error');
    });

    it('accepts exactly 50 codes', async () => {
      const codes = Array.from({ length: 50 }, (_, i) => String(i).padStart(6, '0'));
      const body = await get(app(), codes.join(','));
      expect(body.items).toHaveLength(50);
    });
  });

  describe('source fallback', () => {
    it('uses Tiantian as the primary source when it has an estimate', async () => {
      const body = await get(app(), '110020');
      expect(body.items).toEqual([
        { code: '110020', status: 'estimated', estimate: TIANTIAN_110020 },
      ]);
    });

    it('falls back to Sina when Tiantian has no estimate for the fund', async () => {
      // The recorded Tiantian sample has GSZ/GSZZL null for 000001 (its NAV is already out).
      const body = await get(app(), '000001');
      expect(body.items).toEqual([{ code: '000001', status: 'estimated', estimate: SINA_000001 }]);
    });

    it.each<[string, Replay]>([
      ['times out', upstreamDown()],
      ['responds 503', upstreamDown(new UpstreamError('http_status', 'recorded 503', 503))],
      ['returns a non-JSON body', () => '<html>502 Bad Gateway</html>'],
      [
        'reports success: false',
        () => '{"data":null,"errorCode":61136403,"success":false,"firstError":"网络繁忙"}',
      ],
      ['returns an unexpected shape', () => '{"success":true,"data":"nope"}'],
    ])('falls back to Sina for every fund when Tiantian %s', async (_name, tiantian) => {
      upstream.use(estimateSamples({ tiantian }));
      const body = await get(app(), '110020,000001');
      expect(body.items).toEqual([
        { code: '110020', status: 'estimated', estimate: SINA_110020 },
        { code: '000001', status: 'estimated', estimate: SINA_000001 },
      ]);
    });

    it.each<[string, Record<string, unknown>]>([
      ['a missing change', { GSZZL: undefined }],
      ['a placeholder change', { GSZZL: '--' }],
      ['a zero estimate value', { GSZ: 0 }],
      ['a missing estimate time', { GZTIME: null }],
      ['an estimate from a previous day', { GZTIME: '2026-11-05 15:00' }],
    ])('falls back to Sina when the Tiantian row has %s', async (_name, patch) => {
      upstream.use(estimateSamples({ tiantian: tiantianWith('110020', patch) }));
      const body = await get(app(), '110020');
      expect(body.items).toEqual([{ code: '110020', status: 'estimated', estimate: SINA_110020 }]);
    });

    it('keeps a genuine 0% estimate from Tiantian', async () => {
      upstream.use(estimateSamples({ tiantian: tiantianWith('110020', { GSZZL: 0 }) }));
      const body = await get(app(), '110020');
      expect(body.items[0]?.estimate).toMatchObject({ source: 'tiantian', changePercent: 0 });
    });
  });

  describe('unavailable', () => {
    it.each<[string, Replay]>([
      ['both sources time out', upstreamDown()],
      [
        'both sources reject the request',
        upstreamDown(new UpstreamError('http_status', 'recorded 403', 403)),
      ],
      [
        'Tiantian fails and Sina answers without fund lines',
        estimateSamples({ tiantian: upstreamDown(), sina: () => 'Kinsoku jikou desu!' }),
      ],
    ])('marks every fund unavailable, without any 0%%, when %s', async (_name, replay) => {
      upstream.use(replay);
      const res = await app().request('/v1/funds/estimates?codes=110020,000001');
      expect(res.status).toBe(200);
      const text = await res.text();
      const body = JSON.parse(text) as EstimateBatchResponse;
      expect(body.marketStatus).toBe('trading');
      expect(body.items).toEqual([
        { code: '110020', status: 'unavailable', estimate: null },
        { code: '000001', status: 'unavailable', estimate: null },
      ]);
      expect(text).not.toContain('changePercent');
    });

    it('marks a fund unavailable when neither source knows it', async () => {
      const body = await get(app(), '999999,110020');
      expect(body.items).toEqual([
        { code: '999999', status: 'unavailable', estimate: null },
        { code: '110020', status: 'estimated', estimate: TIANTIAN_110020 },
      ]);
    });

    it("never serves a previous trading day's estimate", async () => {
      // Monday 2026-11-09 10:00 — both recorded samples are dated Friday 2026-11-06.
      clock.set('2026-11-09T02:00:00.000Z');
      const body = await get(app(), '110020,000001');
      expect(body.items).toEqual([
        { code: '110020', status: 'unavailable', estimate: null },
        { code: '000001', status: 'unavailable', estimate: null },
      ]);
    });
  });

  describe('estimate base check', () => {
    it('marks a QDII estimate unavailable when its base NAV is older than the latest published NAV', async () => {
      // Recorded 2026-11-06: Tiantian has no estimate for 040046; Sina's line estimates on base
      // 7.8140, which is the 11-04 NAV, while the 11-05 NAV 7.3159 is already published.
      const body = await get(app(), '040046');
      expect(body.items).toEqual([{ code: '040046', status: 'unavailable', estimate: null }]);
    });

    it("adopts a regular fund's Sina estimate whose base is the latest published NAV", async () => {
      // 000001: Sina base 1.0000 equals the latest published NAV (2026-11-05).
      const body = await get(app(), '000001');
      expect(body.items).toEqual([{ code: '000001', status: 'estimated', estimate: SINA_000001 }]);
    });

    it("checks the base against the previous NAV once the estimate day's NAV is already out", async () => {
      // 110020's 2026-11-06 NAV is published; Sina's base 1.7030 is the 11-05 NAV, so it still matches.
      upstream.use(estimateSamples({ tiantian: upstreamDown() }));
      clock.set('2026-11-06T12:30:00.000Z'); // 20:30
      const body = await get(app(), '110020');
      expect(body.items).toEqual([{ code: '110020', status: 'estimated', estimate: SINA_110020 }]);
    });

    it('falls back to Sina when the Tiantian base NAV does not match the latest published NAV', async () => {
      upstream.use(
        estimateSamples({
          tiantian: tiantianWith('110020', { PDATE: '2026-11-05', NAV: 1.6983 }),
        }),
      );
      const body = await get(app(), '110020');
      expect(body.items).toEqual([{ code: '110020', status: 'estimated', estimate: SINA_110020 }]);
    });

    it('falls back to Sina when the Tiantian base date is not the latest published NAV date', async () => {
      upstream.use(
        estimateSamples({
          tiantian: tiantianWith('110020', { PDATE: '2026-11-04', NAV: 1.703 }),
        }),
      );
      const body = await get(app(), '110020');
      expect(body.items[0]?.estimate?.source).toBe('sina');
    });

    it('adopts the Tiantian estimate when its base matches the latest published NAV', async () => {
      upstream.use(
        estimateSamples({
          tiantian: tiantianWith('110020', { PDATE: '2026-11-05', NAV: 1.703 }),
        }),
      );
      const body = await get(app(), '110020');
      expect(body.items).toEqual([
        { code: '110020', status: 'estimated', estimate: TIANTIAN_110020 },
      ]);
    });

    it('ignores a Sina line without a usable base NAV', async () => {
      upstream.use(
        estimateSamples({
          tiantian: upstreamDown(),
          sina: () =>
            'var hq_str_fu_000001="华夏成长混合A,16:02:00,0.9843,--,3.5730,0,-1.5738,2026-11-06,0.9805,-1.9459";',
        }),
      );
      const body = await get(app(), '000001');
      expect(body.items).toEqual([{ code: '000001', status: 'unavailable', estimate: null }]);
    });

    it('keeps serving estimates when the NAV upstream fails, re-checking once it recovers', async () => {
      const target = app();
      upstream.use(estimateSamples({ nav: upstreamDown() }));
      const first = await get(target, '040046,000001');
      // The base cannot be checked, so the estimates are not discarded…
      expect(first.items.map((item) => [item.code, item.status, item.estimate?.source])).toEqual([
        ['040046', 'estimated', 'sina'],
        ['000001', 'estimated', 'sina'],
      ]);

      // …but they are only short-cached: once the NAV is reachable again the stale QDII
      // estimate is caught, while the regular fund's estimate stays.
      upstream.use(estimateSamples());
      clock.set('2026-11-06T02:00:30.000Z');
      const second = await get(target, '040046,000001');
      expect(second.items).toEqual([
        { code: '040046', status: 'unavailable', estimate: null },
        { code: '000001', status: 'estimated', estimate: SINA_000001 },
      ]);
    });

    it('does not keep an unchecked closing estimate until the next open', async () => {
      const target = app();
      upstream.use(estimateSamples({ nav: upstreamDown() }));
      clock.set('2026-11-06T08:30:00.000Z'); // 16:30
      expect((await get(target, '000001')).items[0]?.estimate).toEqual(SINA_000001);

      upstream.use(upstreamDown());
      clock.set('2026-11-06T08:30:30.000Z'); // 30 s later — re-fetched instead of cached
      expect((await get(target, '000001')).items[0]?.status).toBe('unavailable');
    });
  });

  describe('market hours', () => {
    it('returns pre_market for every fund before the open, without asking the upstream', async () => {
      upstream.use(mustNotFetch);
      clock.set('2026-11-06T01:29:59.000Z'); // 09:29:59
      const body = await get(app(), '110020,000001');
      expect(body.marketStatus).toBe('pre_market');
      expect(body.items).toEqual([
        { code: '110020', status: 'pre_market', estimate: null },
        { code: '000001', status: 'pre_market', estimate: null },
      ]);
    });

    it('returns pre_market just after midnight on a trading day', async () => {
      upstream.use(mustNotFetch);
      clock.set('2026-11-05T16:30:00.000Z'); // Friday 00:30
      const body = await get(app(), '110020');
      expect(body.items).toEqual([{ code: '110020', status: 'pre_market', estimate: null }]);
    });

    it('returns holiday on a weekend', async () => {
      upstream.use(mustNotFetch);
      clock.set('2026-11-07T02:00:00.000Z'); // Saturday 10:00
      const body = await get(app(), '110020');
      expect(body.marketStatus).toBe('holiday');
      expect(body.items).toEqual([{ code: '110020', status: 'holiday', estimate: null }]);
    });

    it('returns holiday on a weekday market holiday', async () => {
      upstream.use(mustNotFetch);
      clock.set('2026-10-01T02:00:00.000Z'); // National Day, Thursday 10:00
      const body = await get(
        app({ tradingCalendar: new ChineseTradingCalendar(['2026-10-01']) }),
        '110020',
      );
      expect(body.items).toEqual([{ code: '110020', status: 'holiday', estimate: null }]);
    });

    it('serves estimates during the lunch break', async () => {
      clock.set('2026-11-06T04:00:00.000Z'); // 12:00
      const body = await get(app(), '110020');
      expect(body.marketStatus).toBe('trading');
      expect(body.items[0]?.status).toBe('estimated');
    });

    it("serves the day's closing estimate after the close", async () => {
      clock.set('2026-11-06T08:30:00.000Z'); // 16:30
      const body = await get(app(), '110020,000001');
      expect(body.marketStatus).toBe('closed');
      expect(body.items).toEqual([
        { code: '110020', status: 'estimated', estimate: TIANTIAN_110020 },
        { code: '000001', status: 'estimated', estimate: SINA_000001 },
      ]);
    });
  });

  describe('caching', () => {
    it('caches estimates for seconds during trading hours', async () => {
      const target = app();
      expect((await get(target, '110020')).items[0]?.estimate).toEqual(TIANTIAN_110020);

      upstream.use(upstreamDown());
      clock.set('2026-11-06T02:00:29.000Z'); // 29 s later — still cached
      expect((await get(target, '110020')).items[0]?.estimate).toEqual(TIANTIAN_110020);

      clock.set('2026-11-06T02:00:30.000Z'); // 30 s later — expired, upstream asked again
      expect((await get(target, '110020')).items[0]).toEqual({
        code: '110020',
        status: 'unavailable',
        estimate: null,
      });
    });

    it('caches each fund separately so a later batch only fetches the new codes', async () => {
      const target = app();
      await get(target, '110020');
      // Tiantian now fails, so only a fresh fetch would fall back to Sina.
      upstream.use(estimateSamples({ tiantian: upstreamDown() }));
      clock.set('2026-11-06T02:00:10.000Z');
      const body = await get(target, '110020,000001');
      expect(body.items).toEqual([
        { code: '110020', status: 'estimated', estimate: TIANTIAN_110020 },
        { code: '000001', status: 'estimated', estimate: SINA_000001 },
      ]);
    });

    it('keeps the closing estimate after the close, across midnight, until the next open', async () => {
      const target = app();
      clock.set('2026-11-06T08:30:00.000Z'); // Friday 16:30
      expect((await get(target, '110020')).items[0]?.estimate).toEqual(TIANTIAN_110020);

      upstream.use(upstreamDown());
      clock.set('2026-11-06T15:59:59.000Z'); // Friday 23:59:59 — hours later, still cached
      expect((await get(target, '110020')).items[0]?.estimate).toEqual(TIANTIAN_110020);

      clock.set('2026-11-06T16:00:30.000Z'); // Saturday 00:00:30 — weekend, no estimate
      expect((await get(target, '110020')).items[0]?.status).toBe('holiday');

      clock.set('2026-11-09T01:29:00.000Z'); // Monday 09:29 — before the open
      expect((await get(target, '110020')).items[0]?.status).toBe('pre_market');

      clock.set('2026-11-09T01:30:00.000Z'); // Monday 09:30 — cache expired, upstream asked again
      expect((await get(target, '110020')).items[0]?.status).toBe('unavailable');
    });

    it('keeps the closing estimate until the open after a holiday', async () => {
      // Monday 2026-11-09 is a market holiday; the next open is Tuesday 09:30.
      const target = app({ tradingCalendar: new ChineseTradingCalendar(['2026-11-09']) });
      clock.set('2026-11-06T08:30:00.000Z'); // Friday 16:30
      expect((await get(target, '110020')).items[0]?.estimate).toEqual(TIANTIAN_110020);

      upstream.use(upstreamDown());
      clock.set('2026-11-09T02:00:00.000Z'); // Monday 10:00 — holiday
      expect((await get(target, '110020')).items[0]?.status).toBe('holiday');

      clock.set('2026-11-10T01:30:00.000Z'); // Tuesday 09:30 — the next open
      expect((await get(target, '110020')).items[0]?.status).toBe('unavailable');
    });

    it('re-fetches after the close when the estimate it got predates 15:00', async () => {
      const target = app();
      upstream.use(
        estimateSamples({ tiantian: tiantianWith('110020', { GZTIME: '2026-11-06 14:58' }) }),
      );
      clock.set('2026-11-06T07:01:00.000Z'); // 15:01
      expect((await get(target, '110020')).items[0]?.estimate?.time).toBe(
        '2026-11-06T06:58:00.000Z',
      );

      upstream.use(estimateSamples());
      clock.set('2026-11-06T07:01:30.000Z'); // 30 s later — short cache expired
      expect((await get(target, '110020')).items[0]?.estimate).toEqual(TIANTIAN_110020);
    });

    it('does not keep an unavailable result after the close until the next open', async () => {
      const target = app();
      upstream.use(upstreamDown());
      clock.set('2026-11-06T08:30:00.000Z'); // Friday 16:30
      expect((await get(target, '110020')).items[0]?.status).toBe('unavailable');

      upstream.use(estimateSamples());
      clock.set('2026-11-06T08:30:30.000Z');
      expect((await get(target, '110020')).items[0]?.estimate).toEqual(TIANTIAN_110020);
    });
  });
});
