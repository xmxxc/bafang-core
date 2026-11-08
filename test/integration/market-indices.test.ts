import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../../src/app';
import { createHealthProbe } from '../../src/db';
import { UpstreamError } from '../../src/market/upstream';
import type { MarketIndexResponse, MarketIndicesResponse } from '../../src/routes/market-indices';
import { ChineseTradingCalendar, HongKongTradingCalendar } from '../../src/trading-calendar';
import {
  hostDown,
  quoteSamples,
  RecordedUpstream,
  sample,
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

const TENCENT = 'qt.gtimg.cn';

/** 录制样本（2026-11-06 收盘后）里的四个指数，按腾讯来源。 */
const TENCENT_CLOSE = {
  '000001.SH': {
    point: '3649.18',
    prevClose: '3689.91',
    change: '-40.73',
    changePercent: -1.1,
    quoteTime: '2026-11-06T08:14:01.000Z',
  },
  '399001.SZ': {
    point: '11175.78',
    prevClose: '11471.09',
    change: '-295.31',
    changePercent: -2.57,
    quoteTime: '2026-11-06T08:14:42.000Z',
  },
  '399006.SZ': {
    point: '2465.23',
    prevClose: '2566.80',
    change: '-101.57',
    changePercent: -3.96,
    quoteTime: '2026-11-06T08:14:57.000Z',
  },
  'HSI.HK': {
    point: '24481.86',
    prevClose: '24796.98',
    change: '-315.12',
    changePercent: -1.27,
    quoteTime: '2026-11-06T10:30:50.000Z',
  },
} as const;

/** 同花顺分时的最后一个点：A 股 15:00，港股 16:10。 */
const THS_QUOTE_TIME = {
  '000001.SH': '2026-11-06T07:00:00.000Z',
  '399001.SZ': '2026-11-06T07:00:00.000Z',
  '399006.SZ': '2026-11-06T07:00:00.000Z',
  'HSI.HK': '2026-11-06T08:10:00.000Z',
} as const;

const CODES = ['000001.SH', '399001.SZ', '399006.SZ', 'HSI.HK'] as const;

/** 构造一行上证指数的腾讯报价：最新价在第 3 个字段、昨收第 4 个、行情时间第 30 个。 */
function tencentLine(price: string, prevClose: string, time: string): string {
  const fields = Array.from({ length: 33 }, () => '');
  fields[0] = '1';
  fields[1] = '上证指数';
  fields[2] = '000001';
  fields[3] = price;
  fields[4] = prevClose;
  fields[30] = time;
  return `v_sh000001="${fields.join('~')}";`;
}

/** 改写腾讯样本：去掉或替换某只证券的那一行。 */
function tencentWith(symbol: string, line: string | null): Replay {
  return (url) => {
    if (url.hostname !== TENCENT) return quoteSamples(url);
    const kept = sample('tencent/indices.txt')
      .split('\n')
      .map((row) => (row.startsWith(`v_${symbol}=`) ? line : row))
      .filter((row): row is string => row !== null);
    return kept.join('\n');
  };
}

interface Dates {
  /** A 股报价的交易日（YYYYMMDD）。 */
  cn?: string;
  /** 港股报价的交易日（YYYYMMDD）。 */
  hk?: string;
}

/**
 * 把录制样本（交易日 2026-11-06）改写成其他交易日，按来源、按市场分别指定；省略的保持原样。
 * `hkTime` 改写腾讯港股行情的时刻（HH:MM:SS），例如半日市的 12:10:00。
 */
function redated({
  tencent = {},
  ths = {},
  hkTime,
}: {
  tencent?: Dates;
  ths?: Dates;
  hkTime?: string;
}): Replay {
  return (url) => {
    if (url.hostname === TENCENT) {
      return sample('tencent/indices.txt')
        .split('\n')
        .map((row) => {
          if (row.startsWith('v_hkHSI=')) {
            const day = tencent.hk ?? '20261106';
            const formatted = `${day.slice(0, 4)}/${day.slice(4, 6)}/${day.slice(6, 8)}`;
            return row.replace('2026/11/06 18:30:50', `${formatted} ${hkTime ?? '18:30:50'}`);
          }
          return tencent.cn ? row.replace('~20261106', `~${tencent.cn}`) : row;
        })
        .join('\n');
    }
    const body = quoteSamples(url);
    if (typeof body === 'string' && url.pathname.startsWith('/v6/time/')) {
      const day = url.pathname.includes('/hk_') ? ths.hk : ths.cn;
      return day ? body.replace('"date":"20261106"', `"date":"${day}"`) : body;
    }
    return body;
  };
}

/** 仓库附带的 2026 年交易日历（A 股与港股），与生产启动时导入的数据相同。 */
function shippedCalendars(): Pick<AppDeps, 'tradingCalendar' | 'hkTradingCalendar'> {
  const read = (name: string) =>
    JSON.parse(
      readFileSync(fileURLToPath(new URL(`../../data/holidays/${name}`, import.meta.url)), 'utf8'),
    ) as {
      holidays: { date: string; earlyClose?: string }[];
    };
  const cn = read('2026.json').holidays.map((entry) => entry.date);
  const hk = read('hk-2026.json').holidays;
  return {
    tradingCalendar: new ChineseTradingCalendar(cn),
    hkTradingCalendar: new HongKongTradingCalendar(
      hk.filter((entry) => !entry.earlyClose).map((entry) => entry.date),
      hk.flatMap((entry) =>
        entry.earlyClose ? [[entry.date, entry.earlyClose] as [string, string]] : [],
      ),
    ),
  };
}

describe('GET /v1/market/indices over in-process HTTP against a real PostgreSQL test database', () => {
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

  async function indices(target = app()): Promise<MarketIndicesResponse> {
    const res = await target.request('/v1/market/indices');
    expect(res.status).toBe(200);
    return (await res.json()) as MarketIndicesResponse;
  }

  function byCode(body: MarketIndicesResponse, code: string): MarketIndexResponse {
    const item = body.items.find((entry) => entry.code === code);
    if (!item) throw new Error(`index ${code} missing`);
    return item;
  }

  beforeEach(async () => {
    db = await createTestSchema();
    upstream = new RecordedUpstream(quoteSamples);
    // Friday 2026-11-06 21:00 Asia/Shanghai — both markets have closed for the day.
    clock = movableClock('2026-11-06T13:00:00.000Z');
  });

  afterEach(async () => {
    await dropTestSchema(db);
  });

  describe('primary source', () => {
    it('returns point, change and change percent for the four indices from Tencent', async () => {
      const body = await indices();
      expect(body.time).toBe('2026-11-06T13:00:00.000Z');
      expect(body.items.map((item) => [item.code, item.name, item.market])).toEqual([
        ['000001.SH', '上证指数', 'cn'],
        ['399001.SZ', '深证成指', 'cn'],
        ['399006.SZ', '创业板指', 'cn'],
        ['HSI.HK', '恒生指数', 'hk'],
      ]);
      for (const code of CODES) {
        expect(byCode(body, code)).toEqual({
          code,
          name: expect.any(String),
          market: code === 'HSI.HK' ? 'hk' : 'cn',
          marketStatus: 'closed',
          available: true,
          ...TENCENT_CLOSE[code],
          tradeDate: '2026-11-06',
          source: 'tencent',
          fallback: false,
        });
      }
    });

    it('reports trading for both markets during the morning session', async () => {
      clock.set('2026-11-06T02:00:00.000Z'); // Friday 10:00
      const body = await indices();
      for (const code of CODES) {
        expect(byCode(body, code)).toMatchObject({
          marketStatus: 'trading',
          available: true,
          source: 'tencent',
        });
      }
    });

    it('keeps Hong Kong trading after the A-share close, until 16:10', async () => {
      clock.set('2026-11-06T07:30:00.000Z'); // Friday 15:30
      const afternoon = await indices();
      expect(byCode(afternoon, '000001.SH').marketStatus).toBe('closed');
      expect(byCode(afternoon, 'HSI.HK').marketStatus).toBe('trading');

      clock.set('2026-11-06T08:15:00.000Z'); // Friday 16:15
      expect(byCode(await indices(app()), 'HSI.HK').marketStatus).toBe('closed');
    });
  });

  describe('fallback to the backup source', () => {
    it.each<[string, Replay]>([
      ['times out', hostDown(TENCENT, quoteSamples)],
      [
        'responds 502',
        hostDown(TENCENT, quoteSamples, new UpstreamError('http_status', 'recorded 502', 502)),
      ],
      [
        'returns an unrecognizable body',
        (url) => (url.hostname === TENCENT ? '<html>busy</html>' : quoteSamples(url)),
      ],
    ])('falls back to 同花顺 for every index when Tencent %s', async (_name, replay) => {
      upstream.use(replay);
      const body = await indices();
      for (const code of CODES) {
        const values = { ...TENCENT_CLOSE[code], quoteTime: THS_QUOTE_TIME[code] };
        expect(byCode(body, code)).toMatchObject({
          ...values,
          tradeDate: '2026-11-06',
          available: true,
          marketStatus: 'closed',
          source: 'ths',
          fallback: true,
        });
      }
    });

    it('falls back only for the index Tencent did not return', async () => {
      upstream.use(tencentWith('hkHSI', 'v_pv_none_match="1";'));
      const body = await indices();
      expect(byCode(body, 'HSI.HK')).toMatchObject({
        point: '24481.86',
        change: '-315.12',
        source: 'ths',
        fallback: true,
      });
      for (const code of ['000001.SH', '399001.SZ', '399006.SZ']) {
        expect(byCode(body, code)).toMatchObject({ source: 'tencent', fallback: false });
      }
    });

    it.each([
      ['a placeholder price', tencentLine('--', '3689.91', '20261106161401')],
      ['a zero price', tencentLine('0.00', '3689.91', '20261106161401')],
      ['a missing quote time', 'v_sh000001="1~上证指数~000001~3649.18~3689.91";'],
    ])('falls back when Tencent gives %s instead of a usable quote', async (_name, line) => {
      upstream.use(tencentWith('sh000001', line));
      const body = await indices();
      expect(byCode(body, '000001.SH')).toMatchObject({
        point: '3649.18',
        change: '-40.73',
        changePercent: -1.1,
        source: 'ths',
        fallback: true,
      });
      expect(byCode(body, '399001.SZ').source).toBe('tencent');
    });

    it('rejects a 同花顺 quote whose previous close disagrees with its snapshot (stale CDN node)', async () => {
      // Recorded anomaly: the intraday response carried a months-old previous close (26361.07)
      // with today's prices, which would otherwise show a fake −7% day.
      upstream.use((url) => {
        if (url.hostname === TENCENT) return new UpstreamError('timeout', 'recorded timeout');
        if (url.pathname === '/v6/time/hk_HSI/last.js') {
          return sample('ths/time-hk_HSI-stale-pre.jsonp');
        }
        return quoteSamples(url);
      });
      const body = await indices();
      expect(byCode(body, 'HSI.HK')).toMatchObject({
        available: false,
        point: null,
        change: null,
        changePercent: null,
        source: null,
      });
      expect(byCode(body, '000001.SH')).toMatchObject({ available: true, source: 'ths' });
    });

    it('rejects a 同花顺 quote whose snapshot price is far from its intraday price', async () => {
      // Both responses stale in the recorded way: the snapshot is a months-old pair (26519.50 over
      // 26361.07) and the intraday previous close matches it, but the intraday prices are today's.
      upstream.use((url) => {
        if (url.hostname === TENCENT) return new UpstreamError('timeout', 'recorded timeout');
        if (url.pathname === '/v6/time/hk_HSI/last.js') {
          return sample('ths/time-hk_HSI-stale-pre.jsonp');
        }
        if (url.pathname === '/v6/realhead/hk_HSI/last.js') {
          return sample('ths/realhead-hk_HSI.jsonp')
            .replace('"10":"24481.86"', '"10":"26519.50"')
            .replace('"6":"24796.98"', '"6":"26361.07"');
        }
        return quoteSamples(url);
      });
      expect(byCode(await indices(), 'HSI.HK')).toMatchObject({ available: false, point: null });
    });

    it('marks an index unavailable when 同花顺 has no intraday points either', async () => {
      upstream.use((url) => {
        if (url.hostname === TENCENT) return new UpstreamError('timeout', 'recorded timeout');
        if (url.pathname === '/v6/time/zs_399006/last.js') {
          return 'quotebridge_v6_time_zs_399006_last({"zs_399006":{"pre":"2566.80","date":"20261106","data":""}})';
        }
        return quoteSamples(url);
      });
      const body = await indices();
      expect(byCode(body, '399006.SZ')).toMatchObject({ available: false, point: null });
      expect(byCode(body, '399001.SZ')).toMatchObject({ available: true, source: 'ths' });
    });

    it('marks every index unavailable with null values when both sources fail', async () => {
      upstream.use(upstreamDown());
      const body = await indices();
      for (const code of CODES) {
        expect(byCode(body, code)).toEqual({
          code,
          name: expect.any(String),
          market: code === 'HSI.HK' ? 'hk' : 'cn',
          marketStatus: 'closed',
          available: false,
          point: null,
          prevClose: null,
          change: null,
          changePercent: null,
          tradeDate: null,
          quoteTime: null,
          source: null,
          fallback: true,
        });
      }
    });
  });

  describe('outside trading hours', () => {
    it("returns Friday's close and holiday for both markets on Saturday", async () => {
      clock.set('2026-11-07T02:00:00.000Z'); // Saturday 10:00
      const body = await indices();
      for (const code of CODES) {
        expect(byCode(body, code)).toMatchObject({
          marketStatus: 'holiday',
          available: true,
          tradeDate: '2026-11-06',
          point: TENCENT_CLOSE[code].point,
          change: TENCENT_CLOSE[code].change,
        });
      }
    });

    it("returns the previous close and pre_market before Monday's open", async () => {
      clock.set('2026-11-09T00:00:00.000Z'); // Monday 08:00
      const body = await indices();
      for (const code of CODES) {
        expect(byCode(body, code)).toMatchObject({
          marketStatus: 'pre_market',
          available: true,
          tradeDate: '2026-11-06',
          point: TENCENT_CLOSE[code].point,
        });
      }
    });

    it('treats an A-share weekday holiday from the trading calendar as holiday with the last close', async () => {
      clock.set('2026-11-09T02:00:00.000Z'); // Monday 10:00, closed for A-shares in this calendar
      const body = await indices(
        app({ tradingCalendar: new ChineseTradingCalendar(['2026-11-09']) }),
      );
      for (const code of ['000001.SH', '399001.SZ', '399006.SZ']) {
        expect(byCode(body, code)).toMatchObject({
          marketStatus: 'holiday',
          available: true,
          tradeDate: '2026-11-06',
          point: TENCENT_CLOSE[code as keyof typeof TENCENT_CLOSE].point,
        });
      }
    });

    it('marks A-share indices unavailable rather than showing a stale close during trading hours', async () => {
      clock.set('2026-11-09T02:00:00.000Z'); // Monday 10:00, a trading day; both sources dated Friday
      const body = await indices();
      for (const code of ['000001.SH', '399001.SZ', '399006.SZ']) {
        expect(byCode(body, code)).toMatchObject({
          marketStatus: 'trading',
          available: false,
          point: null,
          source: null,
          fallback: true,
        });
      }
    });
  });

  describe('Hong Kong trading calendar', () => {
    it('falls back to 同花顺 when Tencent still serves the previous session on a Hong Kong trading day', async () => {
      clock.set('2026-11-09T02:00:00.000Z'); // Monday 10:00, a trading day in both markets
      upstream.use(redated({ ths: { cn: '20261109', hk: '20261109' } }));
      const body = await indices();
      for (const code of CODES) {
        expect(byCode(body, code)).toMatchObject({
          marketStatus: 'trading',
          available: true,
          tradeDate: '2026-11-09',
          source: 'ths',
          fallback: true,
        });
      }
      expect(byCode(body, 'HSI.HK').point).toBe('24481.86');
    });

    it('marks the Hang Seng index unavailable, not holiday, when both sources are stale on a trading day', async () => {
      clock.set('2026-11-09T02:00:00.000Z'); // Monday 10:00; both sources still dated Friday
      const body = await indices();
      expect(byCode(body, 'HSI.HK')).toEqual({
        code: 'HSI.HK',
        name: '恒生指数',
        market: 'hk',
        marketStatus: 'trading',
        available: false,
        point: null,
        prevClose: null,
        change: null,
        changePercent: null,
        tradeDate: null,
        quoteTime: null,
        source: null,
        fallback: true,
      });
    });

    it('shows the last close and holiday on a Hong Kong-only holiday while A-shares trade', async () => {
      // 2026-10-19 (Mon) is 重阳节翌日 in the shipped Hong Kong calendar; A-shares trade that day.
      clock.set('2026-10-19T02:00:00.000Z');
      upstream.use(redated({ tencent: { cn: '20261019', hk: '20261016' } }));
      const body = await indices(app(shippedCalendars()));
      expect(byCode(body, 'HSI.HK')).toMatchObject({
        marketStatus: 'holiday',
        available: true,
        tradeDate: '2026-10-16',
        point: '24481.86',
        source: 'tencent',
        fallback: false,
      });
      for (const code of ['000001.SH', '399001.SZ', '399006.SZ']) {
        expect(byCode(body, code)).toMatchObject({
          marketStatus: 'trading',
          available: true,
          tradeDate: '2026-10-19',
          source: 'tencent',
        });
      }
    });

    it('shows Hong Kong trading while A-shares are closed for an A-share-only holiday', async () => {
      // 2026-10-05 (Mon) is 国庆节 for A-shares (last session 09-30) but a Hong Kong trading day.
      clock.set('2026-10-05T02:00:00.000Z');
      upstream.use(redated({ tencent: { cn: '20260930', hk: '20261005' } }));
      const body = await indices(app(shippedCalendars()));
      expect(byCode(body, 'HSI.HK')).toMatchObject({
        marketStatus: 'trading',
        available: true,
        tradeDate: '2026-10-05',
        source: 'tencent',
      });
      for (const code of ['000001.SH', '399001.SZ', '399006.SZ']) {
        expect(byCode(body, code)).toMatchObject({
          marketStatus: 'holiday',
          available: true,
          tradeDate: '2026-09-30',
          source: 'tencent',
        });
      }
    });

    it('closes at the half-day close and returns the closing point in the afternoon', async () => {
      // 2026-12-24 (Thu) is a half-day (圣诞节前夕) in the shipped Hong Kong calendar.
      upstream.use(redated({ tencent: { cn: '20261224', hk: '20261224' }, hkTime: '12:10:00' }));
      const calendars = shippedCalendars();

      clock.set('2026-12-24T03:00:00.000Z'); // 11:00 — morning session
      expect(byCode(await indices(app(calendars)), 'HSI.HK').marketStatus).toBe('trading');

      clock.set('2026-12-24T06:00:00.000Z'); // 14:00 — the half-day has closed
      const body = await indices(app(calendars));
      expect(byCode(body, 'HSI.HK')).toMatchObject({
        marketStatus: 'closed',
        available: true,
        point: '24481.86',
        change: '-315.12',
        tradeDate: '2026-12-24',
        quoteTime: '2026-12-24T04:10:00.000Z',
      });
      expect(byCode(body, '000001.SH').marketStatus).toBe('trading');
    });
  });

  describe('caching', () => {
    it('serves cached quotes for a few minutes after the close, then refetches', async () => {
      const target = app();
      const first = await indices(target);
      upstream.use(upstreamDown());

      clock.set('2026-11-06T13:04:00.000Z');
      expect((await indices(target)).items).toEqual(first.items);

      clock.set('2026-11-06T13:05:01.000Z');
      const expired = await indices(target);
      for (const item of expired.items) expect(item.available).toBe(false);
    });

    it('caches quotes for only seconds during trading hours', async () => {
      clock.set('2026-11-06T02:00:00.000Z');
      const target = app();
      const first = await indices(target);
      upstream.use(upstreamDown());

      clock.set('2026-11-06T02:00:09.000Z');
      expect((await indices(target)).items).toEqual(first.items);

      clock.set('2026-11-06T02:00:10.000Z');
      for (const item of (await indices(target)).items) expect(item.available).toBe(false);
    });

    it('retries soon after both sources fail instead of caching unavailable for long', async () => {
      const target = app();
      upstream.use(upstreamDown());
      expect(byCode(await indices(target), '000001.SH').available).toBe(false);

      upstream.use(quoteSamples);
      clock.set('2026-11-06T13:00:11.000Z');
      expect(byCode(await indices(target), '000001.SH')).toMatchObject({
        available: true,
        source: 'tencent',
      });
    });

    it('caches the backup result with the same lifetime as the primary', async () => {
      const target = app();
      upstream.use(hostDown(TENCENT, quoteSamples));
      expect(byCode(await indices(target), 'HSI.HK').source).toBe('ths');

      upstream.use(quoteSamples);
      clock.set('2026-11-06T13:04:00.000Z');
      expect(byCode(await indices(target), 'HSI.HK').source).toBe('ths');
      clock.set('2026-11-06T13:05:01.000Z');
      expect(byCode(await indices(target), 'HSI.HK').source).toBe('tencent');
    });
  });

  describe('caching across session boundaries (same app instance)', () => {
    it('re-evaluates status and refetches quotes when the market opens', async () => {
      const target = app();
      clock.set('2026-11-09T01:29:50.000Z'); // Monday 09:29:50 — pre-market, Friday's close
      const before = await indices(target);
      for (const code of CODES) {
        expect(byCode(before, code)).toMatchObject({
          marketStatus: 'pre_market',
          tradeDate: '2026-11-06',
        });
      }

      upstream.use(redated({ tencent: { cn: '20261109', hk: '20261109' } }));
      clock.set('2026-11-09T01:30:05.000Z'); // 09:30:05 — within the pre-market TTL, but past the open
      const after = await indices(target);
      for (const code of CODES) {
        expect(byCode(after, code)).toMatchObject({
          marketStatus: 'trading',
          available: true,
          tradeDate: '2026-11-09',
          source: 'tencent',
        });
      }
    });

    it('re-evaluates status and refetches quotes at the A-share close, keeping the Hong Kong cache', async () => {
      const target = app();
      clock.set('2026-11-06T06:59:55.000Z'); // Friday 14:59:55
      const before = await indices(target);
      expect(byCode(before, '000001.SH').marketStatus).toBe('trading');

      upstream.use(tencentWith('sh000001', tencentLine('3650.00', '3689.91', '20261106150002')));
      clock.set('2026-11-06T07:00:02.000Z'); // 15:00:02 — within the 10 s TTL, but past the close
      const after = await indices(target);
      expect(byCode(after, '000001.SH')).toMatchObject({
        marketStatus: 'closed',
        point: '3650.00',
        change: '-39.91',
      });
      expect(byCode(after, 'HSI.HK')).toEqual(byCode(before, 'HSI.HK'));
    });

    it('re-evaluates status and refetches quotes when the trading day rolls over at midnight', async () => {
      const target = app();
      clock.set('2026-11-06T15:58:00.000Z'); // Friday 23:58 — closed
      expect(byCode(await indices(target), '000001.SH').marketStatus).toBe('closed');

      upstream.use(upstreamDown());
      clock.set('2026-11-06T16:01:00.000Z'); // Saturday 00:01 — within the 5 min TTL, but a new day
      const body = await indices(target);
      for (const code of CODES) {
        expect(byCode(body, code)).toMatchObject({ marketStatus: 'holiday', available: false });
      }
    });

    it('re-evaluates the Hong Kong status at its 16:10 close', async () => {
      const target = app();
      clock.set('2026-11-06T08:05:00.000Z'); // Friday 16:05 — Hong Kong closing auction
      expect(byCode(await indices(target), 'HSI.HK').marketStatus).toBe('trading');
      upstream.use(upstreamDown());
      clock.set('2026-11-06T08:10:01.000Z'); // 16:10:01
      expect(byCode(await indices(target), 'HSI.HK').marketStatus).toBe('closed');
    });
  });

  it('documents the route and its schemas in the OpenAPI document', async () => {
    const res = await app().request('/v1/openapi');
    const doc = (await res.json()) as {
      paths: Record<string, { get?: { responses: Record<string, unknown> } }>;
      components: { schemas: Record<string, unknown> };
    };
    const responses = doc.paths['/v1/market/indices']?.get?.responses;
    for (const status of ['200', '429', '500']) expect(responses?.[status]).toBeDefined();
    expect(doc.components.schemas.MarketIndex).toBeDefined();
    expect(doc.components.schemas.MarketIndices).toBeDefined();
  });
});
