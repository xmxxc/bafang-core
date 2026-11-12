import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../../src/app';
import { createHealthProbe } from '../../src/db';
import type { ErrorResponse } from '../../src/errors';
import { UpstreamError } from '../../src/market/upstream';
import type { EstimateBatchResponse } from '../../src/routes/estimates';
import {
  ChineseTradingCalendar,
  loadTradingCalendar,
  type TradingCalendar,
} from '../../src/trading-calendar';
import { importHolidays } from '../../src/trading-calendar/holidays';
import cn2026 from '../../data/holidays/2026.json';
import {
  estimateSamples,
  eastmoneySamples,
  RecordedUpstream,
  sample,
  sinaSamples,
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

/**
 * 录制的天天基金样本取自当晚净值公布后：110020 的 NAV / PDATE 已是当天（2026-11-06）的净值，
 * 看不出估值用的基准。盘中时这两项是上一期净值，这里按录制的东方财富净值历史把它还原成盘中的样子
 * （2026-11-05 的单位净值 1.7030），作为一级成功的默认回放。
 */
const INTRADAY_110020 = { PDATE: '2026-11-05', NAV: 1.703, GZTIME: '2026-11-06 10:00' };

/** 在盘中样子的天天基金样本上，改写某只基金的字段。 */
function tiantianWith(code: string, patch: Record<string, unknown>): Replay {
  return tiantianFrom(code, patch, true);
}

function tiantianFrom(code: string, patch: Record<string, unknown>, intraday: boolean): Replay {
  const body = JSON.parse(sample('tiantian/valuation-000001-110020-040046-999999.json')) as {
    data: Record<string, unknown>[];
  };
  body.data = body.data.map((row) => {
    const base = !intraday
      ? row
      : row.FCODE === '110020'
        ? { ...row, ...INTRADAY_110020 }
        : row.FCODE === '000001'
          ? {
              ...row,
              PDATE: '2026-11-05',
              NAV: 1,
              GSZ: 0.9843,
              GSZZL: -1.5738,
              GZTIME: '2026-11-06 10:00',
            }
          : row;
    return row.FCODE === code ? { ...base, ...patch } : base;
  });
  return tiantianSamples(JSON.stringify(body));
}

/**
 * 录制的新浪样本同样取自收盘后（16:02 / 16:03）。默认的 10:00 请求时刻不接受晚于请求的估值，
 * 这里把估值时间还原成盘中的 10:00，其余字段保持原样。
 */
function sinaIntraday(): Replay {
  return sinaSamples(
    sample('sina/fu-000001-110020-040046-999999.txt').replace(/,16:0[23]:00,/g, ',10:00:00,'),
  );
}

/** 两级来源与净值都按样本回放，天天基金与新浪默认都是盘中的样子。 */
function samples(overrides: Parameters<typeof estimateSamples>[0] = {}): Replay {
  return estimateSamples({
    tiantian: tiantianWith('110020', {}),
    sina: sinaIntraday(),
    ...overrides,
  });
}

/** 构造边界数据，不是录制样本；latest 与 history 可以独立改变。 */
function constructedNav(
  points: [string, string][],
  latest: [string, string] = ['2026-11-05', '1.7030'],
): Replay {
  return (url) =>
    JSON.stringify({
      ErrCode: 0,
      Data: {
        LSJZList: (url.searchParams.get('pageSize') === '1' ? [latest] : points).map(
          ([FSRQ, DWJZ]) => ({ FSRQ, DWJZ }),
        ),
      },
    });
}

// 录制样本的估值时间（Asia/Shanghai 2026-11-06）
const TIANTIAN_110020 = {
  changePercent: -1.44,
  value: '1.6785',
  time: '2026-11-06T02:00:00.000Z',
  source: 'tiantian',
  sourceName: '天天基金',
  fallback: false,
  referenceOnly: true,
};
const TIANTIAN_000001 = {
  changePercent: -1.5738,
  value: '0.9843',
  time: '2026-11-06T02:00:00.000Z',
  source: 'tiantian',
  sourceName: '天天基金',
  fallback: false,
  referenceOnly: true,
};
const SINA_000001 = { ...TIANTIAN_000001, source: 'sina', sourceName: '新浪财经', fallback: true };
const SINA_110020 = {
  changePercent: -1.3531,
  value: '1.6800',
  time: '2026-11-06T02:00:00.000Z',
  source: 'sina',
  sourceName: '新浪财经',
  fallback: true,
  referenceOnly: true,
};
/** 未改写时间的新浪录制样本（收盘后 16:03）。 */
const RECORDED_SINA_110020 = { ...SINA_110020, time: '2026-11-06T08:03:00.000Z' };

describe('GET /v1/funds/estimates over in-process HTTP against a real PostgreSQL test database', () => {
  let db: TestSchema;
  let calendar: TradingCalendar;
  let upstream: RecordedUpstream;
  let clock: ReturnType<typeof movableClock>;

  function app(deps: AppDeps = {}) {
    return createApp({
      db: createHealthProbe(db.pool),
      upstream,
      clock,
      tradingCalendar: calendar,
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
    await importHolidays(db.pool, cn2026.year, cn2026.holidays);
    calendar = await loadTradingCalendar(db.pool);
    upstream = new RecordedUpstream(samples());
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
        { code: '000001', status: 'estimated', estimate: TIANTIAN_000001 },
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

  describe('source availability', () => {
    it('restores Sina fallback when the recorded pre-estimate NAV history uniquely dates its base', async () => {
      // Unmodified Sina and Eastmoney recordings; only Tiantian availability is constructed.
      // The Sina rows were recorded at 16:03, so the request is placed after that recording.
      clock.set('2026-11-06T08:30:00.000Z'); // 16:30
      upstream.use(estimateSamples({ tiantian: upstreamDown() }));
      expect((await get(app(), '110020')).items).toEqual([
        { code: '110020', status: 'estimated', estimate: RECORDED_SINA_110020 },
      ]);
    });

    it('uses Tiantian as the primary source when it has an estimate', async () => {
      const body = await get(app(), '110020');
      expect(body.items).toEqual([
        { code: '110020', status: 'estimated', estimate: TIANTIAN_110020 },
      ]);
    });

    it('uses a uniquely verified Sina base when Tiantian has no estimate', async () => {
      upstream.use(samples({ tiantian: tiantianWith('000001', { GSZ: null, GSZZL: null }) }));
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
    ])(
      'falls back to uniquely verified Sina estimates when Tiantian %s',
      async (_name, tiantian) => {
        upstream.use(samples({ tiantian }));
        const body = await get(app(), '110020,000001');
        expect(body.items).toEqual([
          { code: '110020', status: 'estimated', estimate: SINA_110020 },
          { code: '000001', status: 'estimated', estimate: SINA_000001 },
        ]);
      },
    );

    it.each<[string, Record<string, unknown>]>([
      ['a missing change', { GSZZL: undefined }],
      ['a placeholder change', { GSZZL: '--' }],
      ['a zero estimate value', { GSZ: 0 }],
      ['a missing estimate time', { GZTIME: null }],
      ['an estimate from a previous day', { GZTIME: '2026-11-05 15:00' }],
    ])('falls back to uniquely verified Sina when Tiantian has %s', async (_name, patch) => {
      upstream.use(samples({ tiantian: tiantianWith('110020', patch) }));
      const body = await get(app(), '110020');
      expect(body.items).toEqual([{ code: '110020', status: 'estimated', estimate: SINA_110020 }]);
    });

    it('keeps a genuine 0% estimate from Tiantian', async () => {
      upstream.use(samples({ tiantian: tiantianWith('110020', { GSZZL: 0 }) }));
      const body = await get(app(), '110020');
      expect(body.items[0]?.estimate).toMatchObject({ source: 'tiantian', changePercent: 0 });
    });

    it('rejects a future Tiantian estimate at a fixed 10:00 request time', async () => {
      upstream.use(
        samples({
          tiantian: tiantianWith('110020', { GZTIME: '2026-11-06 14:00' }),
          sina: upstreamDown(),
        }),
      );
      const body = await get(app(), '110020');
      expect(body.items).toEqual([{ code: '110020', status: 'unavailable', estimate: null }]);
    });

    it('rejects a future Sina estimate at a fixed 10:00 request time', async () => {
      upstream.use(
        samples({
          tiantian: upstreamDown(),
          sina: () =>
            'var hq_str_fu_000001="华夏成长混合A,14:00:00,0.9843,1.0000,3.5730,0,-1.5738,2026-11-06,0.9805,-1.9459";',
        }),
      );
      const body = await get(app(), '000001');
      expect(body.items).toEqual([{ code: '000001', status: 'unavailable', estimate: null }]);
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
        samples({ tiantian: upstreamDown(), sina: () => 'Kinsoku jikou desu!' }),
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
    it('rejects an undated base when a constructed historical NAV cannot be read', async () => {
      upstream.use(
        samples({
          tiantian: upstreamDown(),
          nav: constructedNav([
            ['2026-11-05', '1.7030'],
            ['2026-11-04', '--'],
          ]),
        }),
      );
      expect((await get(app(), '110020')).items[0]?.status).toBe('unavailable');
    });

    it.each<[string, [string, string][]]>([
      ['no history', []],
      ['only the previous trading day', [['2026-11-05', '1.7030']]],
      ['no previous trading day', [['2026-11-04', '1.6983']]],
      [
        'a missing preceding trading day despite an older point',
        [
          ['2026-11-05', '1.7030'],
          ['2026-11-03', '1.6617'],
        ],
      ],
      [
        'the wrong base NAV',
        [
          ['2026-11-05', '1.7020'],
          ['2026-11-04', '1.6983'],
        ],
      ],
      [
        'a unique match on an older day',
        [
          ['2026-11-05', '1.7020'],
          ['2026-11-04', '1.7030'],
        ],
      ],
      [
        'equal adjacent NAVs',
        [
          ['2026-11-05', '1.7030'],
          ['2026-11-04', '1.7030'],
        ],
      ],
      [
        'an equal NAV on a nonadjacent day',
        [
          ['2026-11-05', '1.7030'],
          ['2026-11-04', '1.6983'],
          ['2026-11-03', '1.7030'],
        ],
      ],
    ])('rejects an undated Sina base with %s in constructed history', async (_name, points) => {
      upstream.use(samples({ tiantian: upstreamDown(), nav: constructedNav(points) }));
      expect((await get(app(), '110020')).items).toEqual([
        { code: '110020', status: 'unavailable', estimate: null },
      ]);
    });

    it('excludes the estimate day from the constructed uniqueness window', async () => {
      upstream.use(
        samples({
          tiantian: upstreamDown(),
          nav: constructedNav(
            [
              ['2026-11-06', '1.7030'],
              ['2026-11-05', '1.7030'],
              ['2026-11-04', '1.6983'],
            ],
            ['2026-11-06', '1.7030'],
          ),
        }),
      );
      expect((await get(app(), '110020')).items[0]?.estimate).toEqual(SINA_110020);
    });

    it('still rejects a unique history match when the latest published NAV disagrees', async () => {
      upstream.use(
        samples({
          tiantian: upstreamDown(),
          nav: constructedNav(
            [
              ['2026-11-05', '1.7030'],
              ['2026-11-04', '1.6983'],
            ],
            ['2026-11-05', '1.7100'],
          ),
        }),
      );
      expect((await get(app(), '110020')).items[0]?.status).toBe('unavailable');
    });

    it('rejects Sina when history fails even though the latest NAV is available', async () => {
      upstream.use(
        samples({
          tiantian: upstreamDown(),
          nav: (url) =>
            url.searchParams.get('pageSize') === '1'
              ? eastmoneySamples(url)
              : new UpstreamError('timeout', 'constructed history failure'),
        }),
      );
      expect((await get(app(), '000001')).items[0]?.status).toBe('unavailable');
    });

    it('requires covered years through the trading day preceding the undated base', async () => {
      clock.set('2026-01-05T08:30:00.000Z'); // 16:30, after the recorded 16:03 Sina row
      upstream.use(
        samples({
          tiantian: upstreamDown(),
          sina: () =>
            sample('sina/fu-000001-110020-040046-999999.txt').replaceAll(
              '2026-11-06',
              '2026-01-05',
            ),
          nav: constructedNav(
            [
              ['2026-01-02', '1.7030'],
              ['2025-12-31', '1.6983'],
            ],
            ['2026-01-02', '1.7030'],
          ),
        }),
      );
      // The base date is covered, but finding its preceding trading day crosses into 2025.
      expect(
        (
          await get(
            app({
              tradingCalendar: new ChineseTradingCalendar(['2026-01-01'], [2026]),
            }),
            '110020',
          )
        ).items[0]?.status,
      ).toBe('unavailable');
      expect(
        (
          await get(
            app({
              tradingCalendar: new ChineseTradingCalendar(['2026-01-01'], [2025, 2026]),
            }),
            '110020',
          )
        ).items[0]?.estimate,
      ).toEqual({ ...RECORDED_SINA_110020, time: '2026-01-05T08:03:00.000Z' });
    });

    it.each<TradingCalendar>([new ChineseTradingCalendar(), { isTradingDay: () => true }])(
      'rejects Sina when estimate day coverage is unknown (%j)',
      async (tradingCalendar) => {
        upstream.use(samples({ tiantian: upstreamDown() }));
        expect((await get(app({ tradingCalendar }), '110020')).items[0]?.status).toBe(
          'unavailable',
        );
      },
    );

    it('rejects an undated base even when adjacent NAVs have the same value, while accepting a dated base', async () => {
      const nav: Replay = () =>
        JSON.stringify({
          ErrCode: 0,
          Data: {
            LSJZList: [
              { FSRQ: '2026-11-05', DWJZ: '1.0000', LJJZ: '1.0000', JZZZL: '0' },
              { FSRQ: '2026-11-04', DWJZ: '1.0000', LJJZ: '1.0000', JZZZL: '0' },
            ],
          },
        });
      upstream.use(samples({ tiantian: upstreamDown(), nav }));
      expect((await get(app(), '000001')).items).toEqual([
        { code: '000001', status: 'unavailable', estimate: null },
      ]);
      upstream.use(samples({ nav }));
      expect((await get(app(), '000001')).items).toEqual([
        { code: '000001', status: 'estimated', estimate: TIANTIAN_000001 },
      ]);
      // Equal unit NAV on the wrong explicitly named day still fails the strict date check.
      upstream.use(samples({ nav, tiantian: tiantianWith('000001', { PDATE: '2026-11-04' }) }));
      expect((await get(app(), '000001')).items[0]?.status).toBe('unavailable');
    });

    it.each([null, '', '--', '未知类型'])(
      'does not infer a calendar from unknown fund type %s',
      async (type) => {
        const replay = samples();
        upstream.use((url) => {
          if (url.hostname === 'fundmobapi.eastmoney.com') {
            const body = JSON.parse(sample('eastmoney/base-000001.json')) as {
              Datas: { FTYPE: string | null };
            };
            body.Datas.FTYPE = type;
            return JSON.stringify(body);
          }
          return replay(url);
        });
        expect((await get(app(), '000001')).items).toEqual([
          { code: '000001', status: 'unavailable', estimate: null },
        ]);
      },
    );

    it('does not infer a QDII calendar even when the published base matches', async () => {
      upstream.use(
        samples({
          tiantian: tiantianWith('040046', {
            GSZ: 7.3714,
            GSZZL: 0.7583,
            GZTIME: '2026-11-06 15:31',
            NAV: 7.3159,
            PDATE: '2026-11-05',
          }),
          sina: () =>
            'var hq_str_fu_040046="华安纳斯达克100,15:31:00,7.3714,7.3159,7.3159,0,0.7583,2026-11-06,7.3159,0";',
        }),
      );
      expect((await get(app(), '040046')).items).toEqual([
        { code: '040046', status: 'unavailable', estimate: null },
      ]);
    });

    it('returns unavailable when fund metadata cannot establish a calendar', async () => {
      const replay = samples();
      upstream.use((url) =>
        url.hostname === 'fundmobapi.eastmoney.com'
          ? new UpstreamError('timeout', 'metadata unavailable')
          : replay(url),
      );
      expect((await get(app(), '000001')).items).toEqual([
        { code: '000001', status: 'unavailable', estimate: null },
      ]);
    });

    it('uses the domestic holiday calendar when checking the previous trading day', async () => {
      clock.set('2026-11-09T02:00:00.000Z');
      upstream.use(
        samples({
          tiantian: tiantianWith('110020', { GZTIME: '2026-11-09 10:00' }),
          nav: () =>
            JSON.stringify({
              Data: {
                LSJZList: [{ FSRQ: '2026-11-05', DWJZ: '1.7030', LJJZ: '1.7030', JZZZL: '0' }],
              },
              ErrCode: 0,
            }),
        }),
      );
      const body = await get(
        app({ tradingCalendar: new ChineseTradingCalendar(['2026-11-06'], [2026]) }),
        '110020',
      );
      expect(body.items[0]?.status).toBe('estimated');
      expect(body.items[0]?.estimate?.time).toBe('2026-11-09T02:00:00.000Z');
    });

    it('rejects a matching but unsettled intermediate trading day base', async () => {
      clock.set('2026-11-09T07:35:00.000Z');
      upstream.use(
        samples({
          tiantian: tiantianWith('110020', { GZTIME: '2026-11-09 15:31' }),
          sina: () =>
            'var hq_str_fu_040046="华安纳斯达克100,15:31:00,7.3714,7.3159,7.3159,0,0.7583,2026-11-09,7.3159,0";',
        }),
      );
      const body = await get(app(), '110020,040046');
      expect(body.items).toEqual([
        { code: '110020', status: 'unavailable', estimate: null },
        { code: '040046', status: 'unavailable', estimate: null },
      ]);
    });

    it('marks a QDII estimate unavailable when its base NAV is older than the latest published NAV', async () => {
      // Recorded 2026-11-06: Tiantian has no estimate for 040046; Sina's line estimates on base
      // 7.8140, which is the 11-04 NAV, while the 11-05 NAV 7.3159 is already published.
      const body = await get(app(), '040046');
      expect(body.items).toEqual([{ code: '040046', status: 'unavailable', estimate: null }]);
    });

    it("adopts a regular fund's dated Tiantian estimate with the previous trading day base", async () => {
      // Dated Tiantian base 1.0000 equals the latest published NAV (2026-11-05).
      const body = await get(app(), '000001');
      expect(body.items).toEqual([
        { code: '000001', status: 'estimated', estimate: TIANTIAN_000001 },
      ]);
    });

    it("checks the base against the previous NAV once the estimate day's NAV is already out", async () => {
      // The latest NAV is already 11-06; the dated Tiantian base still matches 11-05.
      clock.set('2026-11-06T12:30:00.000Z'); // 20:30
      const body = await get(app(), '110020');
      expect(body.items).toEqual([
        { code: '110020', status: 'estimated', estimate: TIANTIAN_110020 },
      ]);
    });

    it('falls back to verified Sina after an incorrect Tiantian base NAV', async () => {
      upstream.use(
        samples({
          tiantian: tiantianWith('110020', { PDATE: '2026-11-05', NAV: 1.6983 }),
        }),
      );
      const body = await get(app(), '110020');
      expect(body.items).toEqual([{ code: '110020', status: 'estimated', estimate: SINA_110020 }]);
    });

    it('falls back to verified Sina after an incorrect Tiantian base date', async () => {
      upstream.use(
        samples({
          tiantian: tiantianWith('110020', { PDATE: '2026-11-04', NAV: 1.703 }),
        }),
      );
      const body = await get(app(), '110020');
      expect(body.items[0]?.estimate).toEqual(SINA_110020);
    });

    it('adopts the Tiantian estimate when its base matches the latest published NAV', async () => {
      upstream.use(
        samples({
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
        samples({
          tiantian: upstreamDown(),
          sina: () =>
            'var hq_str_fu_000001="华夏成长混合A,16:02:00,0.9843,--,3.5730,0,-1.5738,2026-11-06,0.9805,-1.9459";',
        }),
      );
      const body = await get(app(), '000001');
      expect(body.items).toEqual([{ code: '000001', status: 'unavailable', estimate: null }]);
    });

    it('reports unavailable while the NAV upstream is down and nothing is cached, then adopts matching estimates once it recovers', async () => {
      const target = app();
      upstream.use(samples({ nav: upstreamDown() }));
      // No base can be confirmed, so no estimate is adopted — including the stale QDII one.
      const first = await get(target, '040046,000001,110020');
      expect(first.items).toEqual([
        { code: '040046', status: 'unavailable', estimate: null },
        { code: '000001', status: 'unavailable', estimate: null },
        { code: '110020', status: 'unavailable', estimate: null },
      ]);

      upstream.use(samples());
      clock.set('2026-11-06T02:00:30.000Z');
      const second = await get(target, '040046,000001,110020');
      expect(second.items).toEqual([
        { code: '040046', status: 'unavailable', estimate: null },
        { code: '000001', status: 'estimated', estimate: TIANTIAN_000001 },
        { code: '110020', status: 'estimated', estimate: TIANTIAN_110020 },
      ]);
    });

    it('keeps checking against NAVs fetched before the NAV upstream went down', async () => {
      const target = app();
      await get(target, '000001,110020,040046');

      // 30 s later the estimate cache has expired and the NAV upstream is down; the NAVs already
      // fetched are still cached by the NAV module, so the bases can still be confirmed.
      upstream.use(samples({ nav: upstreamDown() }));
      clock.set('2026-11-06T02:00:30.000Z');
      const body = await get(target, '000001,110020,040046');
      expect(body.items).toEqual([
        { code: '000001', status: 'estimated', estimate: TIANTIAN_000001 },
        { code: '110020', status: 'estimated', estimate: TIANTIAN_110020 },
        { code: '040046', status: 'unavailable', estimate: null },
      ]);
    });

    it.each<[string, Record<string, unknown>]>([
      ['a missing NAV', { NAV: null }],
      ['a non-numeric NAV', { NAV: '--' }],
      ['a missing PDATE', { PDATE: null }],
      ['a malformed PDATE', { PDATE: '20261105' }],
      ['an impossible PDATE', { PDATE: '2026-02-30' }],
      ['a PDATE after the estimate date', { PDATE: '2026-11-09' }],
      [
        'a PDATE on the estimate date (NAV already published)',
        { PDATE: '2026-11-06', NAV: 1.6804 },
      ],
    ])(
      'does not adopt or long-cache a Tiantian estimate whose base has %s when Sina is down',
      async (_name, patch) => {
        const target = app();
        clock.set('2026-11-06T08:30:00.000Z'); // 16:30, after the close
        upstream.use(samples({ tiantian: tiantianWith('110020', patch), sina: upstreamDown() }));
        expect((await get(target, '110020')).items).toEqual([
          { code: '110020', status: 'unavailable', estimate: null },
        ]);

        // With Sina gone too, the Tiantian row alone is not adopted…
        upstream.use(samples({ tiantian: tiantianWith('110020', patch), sina: upstreamDown() }));
        const other = app();
        expect((await get(other, '110020')).items[0]?.status).toBe('unavailable');

        // …and that unavailable result is only short-cached, not kept until the next open.
        upstream.use(samples());
        clock.set('2026-11-06T08:30:30.000Z');
        expect((await get(other, '110020')).items[0]?.estimate).toEqual(TIANTIAN_110020);
      },
    );

    it('verifies the recorded Sina base when Tiantian already reports the estimate day NAV', async () => {
      // Raw recordings: Tiantian PDATE is the estimate day; Sina still uniquely matches 11-05.
      // Both were recorded after the close, so the request is placed after the 16:03 Sina row.
      clock.set('2026-11-06T08:30:00.000Z'); // 16:30
      upstream.use(estimateSamples());
      const body = await get(app(), '110020');
      expect(body.items).toEqual([
        { code: '110020', status: 'estimated', estimate: RECORDED_SINA_110020 },
      ]);
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
        app({ tradingCalendar: new ChineseTradingCalendar(['2026-10-01'], [2026]) }),
        '110020',
      );
      expect(body.items).toEqual([{ code: '110020', status: 'holiday', estimate: null }]);
    });

    it('serves estimates during the lunch break', async () => {
      upstream.use(samples({ tiantian: tiantianWith('110020', { GZTIME: '2026-11-06 11:30' }) }));
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
        { code: '000001', status: 'estimated', estimate: TIANTIAN_000001 },
      ]);
    });
  });

  describe('caching', () => {
    it.each(['corrected base', 'new historical ambiguity', 'history failure'])(
      'rechecks cached undated Sina after a NAV publication window changes: %s',
      async (change) => {
        const target = app();
        clock.set('2026-11-06T08:30:00.000Z');
        const points: [string, string][] = [
          ['2026-11-05', '1.7030'],
          ['2026-11-04', '1.6983'],
        ];
        upstream.use(samples({ tiantian: upstreamDown(), nav: constructedNav(points) }));
        expect((await get(target, '110020')).items[0]?.estimate).toEqual(SINA_110020);

        // At 19:00 the shared NAV cache moves to a new publication window while the
        // closing estimate TTL is still valid. The source row itself stays unchanged.
        clock.set('2026-11-06T11:05:00.000Z');
        const changedNav = constructedNav(
          change === 'new historical ambiguity'
            ? [
                ['2026-11-05', '1.7030'],
                ['2026-11-04', '1.7030'],
              ]
            : points,
          ['2026-11-05', change === 'corrected base' ? '1.7100' : '1.7030'],
        );
        upstream.use(
          samples({
            tiantian: upstreamDown(),
            nav: (url) =>
              change === 'history failure' && url.searchParams.get('pageSize') !== '1'
                ? new UpstreamError('timeout', 'constructed history failure')
                : changedNav(url),
          }),
        );
        expect((await get(target, '110020')).items).toEqual([
          { code: '110020', status: 'unavailable', estimate: null },
        ]);
      },
    );

    it('rejects the old base after crossing into the next trading day, then accepts the updated base', async () => {
      const target = app();
      clock.set('2026-11-06T08:30:00.000Z');
      expect((await get(target, '000001')).items[0]?.estimate).toEqual(TIANTIAN_000001);

      clock.set('2026-11-09T07:35:00.000Z');
      let base = '1.0000';
      upstream.use(
        samples({
          tiantian: (url) =>
            tiantianWith('000001', {
              GSZ: 1.02,
              NAV: base,
              PDATE: '2026-11-06',
              GZTIME: '2026-11-09 15:31',
            })(url),
          nav: () => {
            const body = JSON.parse(sample('eastmoney/nav-000001-latest.json')) as {
              Data: { LSJZList: { DWJZ: string; FSRQ: string }[] };
            };
            Object.assign(body.Data.LSJZList[0]!, { DWJZ: '1.0100', FSRQ: '2026-11-06' });
            return JSON.stringify(body);
          },
        }),
      );
      expect((await get(target, '000001')).items).toEqual([
        { code: '000001', status: 'unavailable', estimate: null },
      ]);
      base = '1.0100';
      clock.set('2026-11-09T07:35:30.000Z');
      const body = await get(target, '000001');
      expect(body.items[0]?.status).toBe('estimated');
      expect(body.items[0]?.estimate?.time).toBe('2026-11-09T07:31:00.000Z');
    });

    it('does not serve a cached closing estimate when the current NAV can no longer be verified', async () => {
      const target = app();
      clock.set('2026-11-06T08:30:00.000Z');
      expect((await get(target, '000001')).items[0]?.estimate).toEqual(TIANTIAN_000001);
      upstream.use(upstreamDown());
      clock.set('2026-11-06T11:05:00.000Z');
      expect((await get(target, '000001')).items).toEqual([
        { code: '000001', status: 'unavailable', estimate: null },
      ]);
    });

    it('rechecks the published NAV before serving a cached closing estimate', async () => {
      const target = app();
      clock.set('2026-11-06T08:30:00.000Z');
      expect((await get(target, '000001')).items[0]?.estimate).toEqual(TIANTIAN_000001);

      // At 19:00 the NAV cache changes its publication window. A corrected previous NAV
      // now disagrees with the cached source base, although the closing estimate TTL is valid.
      clock.set('2026-11-06T11:05:00.000Z');
      upstream.use(
        samples({
          nav: () => {
            const body = JSON.parse(sample('eastmoney/nav-000001-latest.json')) as {
              Data: { LSJZList: { DWJZ: string }[] };
            };
            body.Data.LSJZList[0]!.DWJZ = '1.0100';
            return JSON.stringify(body);
          },
        }),
      );
      expect((await get(target, '000001')).items).toEqual([
        { code: '000001', status: 'unavailable', estimate: null },
      ]);
    });

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
      // Tiantian now fails, so a fresh fetch falls back to Sina.
      upstream.use(samples({ tiantian: upstreamDown() }));
      clock.set('2026-11-06T02:00:10.000Z');
      const body = await get(target, '110020,000001');
      expect(body.items).toEqual([
        { code: '110020', status: 'estimated', estimate: TIANTIAN_110020 },
        { code: '000001', status: 'estimated', estimate: SINA_000001 },
      ]);
    });

    it('keeps the closing estimate after the close, across midnight, until the next open', async () => {
      const target = app();
      upstream.use(samples({ tiantian: tiantianWith('110020', { GZTIME: '2026-11-06 15:00' }) }));
      const closingEstimate = { ...TIANTIAN_110020, time: '2026-11-06T07:00:00.000Z' };
      clock.set('2026-11-06T08:30:00.000Z'); // Friday 16:30
      expect((await get(target, '110020')).items[0]?.estimate).toEqual(closingEstimate);

      upstream.use(samples({ tiantian: upstreamDown(), sina: upstreamDown() }));
      clock.set('2026-11-06T15:59:59.000Z'); // Friday 23:59:59 — hours later, still cached
      expect((await get(target, '110020')).items[0]?.estimate).toEqual(closingEstimate);

      clock.set('2026-11-06T16:00:30.000Z'); // Saturday 00:00:30 — weekend, no estimate
      expect((await get(target, '110020')).items[0]?.status).toBe('holiday');

      clock.set('2026-11-09T01:29:00.000Z'); // Monday 09:29 — before the open
      expect((await get(target, '110020')).items[0]?.status).toBe('pre_market');

      clock.set('2026-11-09T01:30:00.000Z'); // Monday 09:30 — cache expired, upstream asked again
      expect((await get(target, '110020')).items[0]?.status).toBe('unavailable');
    });

    it('keeps the closing estimate until the open after a holiday', async () => {
      // Monday 2026-11-09 is a market holiday; the next open is Tuesday 09:30.
      const target = app({ tradingCalendar: new ChineseTradingCalendar(['2026-11-09'], [2026]) });
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
      upstream.use(samples({ tiantian: tiantianWith('110020', { GZTIME: '2026-11-06 14:58' }) }));
      clock.set('2026-11-06T07:01:00.000Z'); // 15:01
      expect((await get(target, '110020')).items[0]?.estimate?.time).toBe(
        '2026-11-06T06:58:00.000Z',
      );

      upstream.use(samples());
      clock.set('2026-11-06T07:01:30.000Z'); // 30 s later — short cache expired
      expect((await get(target, '110020')).items[0]?.estimate).toEqual(TIANTIAN_110020);
    });

    it('does not keep an unavailable result after the close until the next open', async () => {
      const target = app();
      upstream.use(upstreamDown());
      clock.set('2026-11-06T08:30:00.000Z'); // Friday 16:30
      expect((await get(target, '110020')).items[0]?.status).toBe('unavailable');

      upstream.use(samples());
      clock.set('2026-11-06T08:30:30.000Z');
      expect((await get(target, '110020')).items[0]?.estimate).toEqual(TIANTIAN_110020);
    });
  });
});
