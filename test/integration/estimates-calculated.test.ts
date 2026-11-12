import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setImmediate as immediate } from 'node:timers/promises';
import { createApp } from '../../src/app';
import { createHealthProbe } from '../../src/db';
import { UpstreamError } from '../../src/market/upstream';
import { loadTradingCalendar, type TradingCalendar } from '../../src/trading-calendar';
import { importHolidays } from '../../src/trading-calendar/holidays';
import cn2026 from '../../data/holidays/2026.json';
import { RecordedUpstream, sample, type Replay } from '../support/recorded-upstream';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';
import type { EstimateBatchResponse } from '../../src/routes/estimates';
import type { IntradayEstimate } from '../../src/market/calculated-estimates';

// Real reports/mapping/SSE identity are replayed verbatim by default. Quote mutations,
// compact reports and histories below are synthetic boundary controls, not recorded prices.
const day = '2026-11-06';
function quote(symbol: string, price: string, at: string) {
  const fields = Array.from({ length: 31 }, () => '');
  fields[3] = price;
  fields[4] = '100';
  fields[30] = at;
  return `v_${symbol}="${fields.join('~')}";`;
}
function report(weights = ['20%', '10%'], reportDate = '2026-09-30', codes = ['600519', '300308']) {
  const rows = weights
    .map(
      (weight, index) =>
        `<tr><td>${index + 1}</td><td>${codes[index]}</td><td>股票</td><td>--</td><td>--</td><td>行情</td><td>${weight}</td></tr>`,
    )
    .join('');
  const content = `<h4>截止至<font>${reportDate}</font></h4><table><thead><tr><th>股票代码</th><th>股票名称</th><th>占净值比例</th></tr></thead><tbody>${rows}</tbody></table>`;
  return `var apidata={content:${JSON.stringify(content)},arryear:[2026],curyear:2026};`;
}
class ReplayControls {
  now = `${day}T02:00:00.000Z`;
  fund = 'domestic';
  report = sample('eastmoney/holdings-000001.json');
  mapping = sample('eastmoney/fund-110020.txt');
  identity = sample('sse/fund-510310.txt');
  navDate = '2026-11-05';
  nav = '1.0000';
  prices: Record<string, string> = {};
  times: Record<string, string> = {};
  missing = '';
  tencentMissing = '';
  szseIdentity = sample('szse/fund-159901.json');
  series: Record<string, string> = {};
  seriesDate = '20261106';
  pre = '100';
  snapshotPre = '100';
  fault = '';
  baseInfo: string | null = null;
  snapshotPrice = '101';
  thsFault = false;
  replay: Replay = (url) => {
    if (url.hostname === this.fault) return new UpstreamError('timeout', 'synthetic failure');
    if (['fundcomapi.tiantianfunds.com', 'hq.sinajs.cn'].includes(url.hostname))
      return new UpstreamError('timeout', 'force tertiary fallback');
    if (url.hostname === 'fundmobapi.eastmoney.com') {
      if (this.baseInfo) return this.baseInfo;
      const body = JSON.parse(
        sample(
          `eastmoney/base-${this.fund === 'etf' ? '110020' : this.fund === 'qdii' ? '040046' : '000001'}.json`,
        ),
      );
      body.Datas.FCODE = url.searchParams.get('FCODE');
      if (this.fund === 'unknown') body.Datas.FTYPE = '未知';
      return JSON.stringify(body);
    }
    if (url.hostname === 'fund.eastmoney.com') return this.mapping;
    if (url.hostname === 'query.sse.com.cn') return this.identity;
    if (url.hostname === 'www.szse.cn') return this.szseIdentity;
    if (url.hostname === 'api.fund.eastmoney.com') {
      const body = JSON.parse(sample('eastmoney/nav-000001-latest.json'));
      body.Data.LSJZList[0].FSRQ = this.navDate;
      body.Data.LSJZList[0].DWJZ = this.nav;
      return JSON.stringify(body);
    }
    if (url.hostname === 'fundf10.eastmoney.com' || url.hostname === 'finance.sina.com.cn')
      return this.report;
    if (url.hostname === 'qt.gtimg.cn')
      return (url.pathname.match(/^\/q=(.*)$/)?.[1] ?? '')
        .split(',')
        .map((symbol) =>
          symbol === this.missing || symbol === this.tencentMissing
            ? `v_${symbol}="";`
            : quote(symbol, this.prices[symbol] ?? '101', this.times[symbol] ?? '20261106100000'),
        )
        .join('\n');
    if (url.hostname === 'd.10jqka.com.cn') {
      if (this.thsFault) return new UpstreamError('timeout', 'THS unavailable');
      const [, kind, symbol] = /\/v6\/(realhead|time)\/([^/]+)\//.exec(url.pathname) ?? [];
      if (!symbol || this.missing === symbol.replace('hs_', 'sh').replace('sz_', 'sz'))
        return new UpstreamError('timeout', 'missing stock');
      if (kind === 'realhead')
        return `cb(${JSON.stringify({ items: { '6': this.snapshotPre, '10': this.snapshotPrice } })})`;
      return `cb(${JSON.stringify({ [symbol]: { date: this.seriesDate, pre: this.pre, data: this.series[symbol] ?? '0930,101,0,0,0;1000,101,0,0,0;1001,101,0,0,0' } })})`;
    }
    throw new Error(`unexpected upstream ${url.href}`);
  };
}

describe('calculated estimates and intraday over HTTP with real isolated PostgreSQL schemas', () => {
  let db: TestSchema, calendar: TradingCalendar, control: ReplayControls;
  beforeEach(async () => {
    db = await createTestSchema();
    await importHolidays(db.pool, cn2026.year, cn2026.holidays);
    calendar = await loadTradingCalendar(db.pool);
    control = new ReplayControls();
  });
  afterEach(async () => dropTestSchema(db));
  function app() {
    return createApp({
      db: createHealthProbe(db.pool),
      upstream: new RecordedUpstream(control.replay),
      clock: { now: () => new Date(control.now) },
      tradingCalendar: calendar,
    });
  }
  async function current(target = app(), code = '000001') {
    const response = await target.request(`/v1/funds/estimates?codes=${code}`);
    expect(response.status).toBe(200);
    return ((await response.json()) as EstimateBatchResponse).items[0]!;
  }
  async function history(target = app(), code = '000001') {
    const response = await target.request(`/v1/funds/${code}/estimates/intraday`);
    expect(response.status).toBe(200);
    return (await response.json()) as IntradayEstimate;
  }
  it('uses all ten real disclosed weights without normalisation and fixed point NAV rounding', async () => {
    const item = await current();
    expect(item).toMatchObject({
      status: 'estimated',
      estimate: {
        source: 'calculated',
        sourceName: '自算',
        fallback: true,
        referenceOnly: true,
        changePercent: 0.3993,
        value: '1.0040',
        time: '2026-11-06T02:00:00.000Z',
        calculation: {
          method: 'top_holdings',
          reportDate: '2026-09-30',
          disclosedWeightPercent: 39.93,
        },
      },
    });
  });
  it('keeps zero rates and zero weights distinct from missing quotes', async () => {
    control.report = report(['0%', '10%']);
    control.prices = { sh600519: '100', sz300308: '100' };
    expect(await current()).toMatchObject({
      status: 'estimated',
      estimate: { changePercent: 0, value: '1.0000' },
    });
    control.missing = 'sh600519';
    expect(await current()).toMatchObject({ status: 'unavailable', estimate: null });
  });
  it('preserves negative weighted rates and rounding away from zero', async () => {
    control.report = report(['50%', '0%']);
    control.prices = { sh600519: '99.99' };
    expect(await current()).toMatchObject({ estimate: { changePercent: -0.005, value: '1.0000' } });
  });
  it('uses the earliest component time and exposes the latest time', async () => {
    control.report = report();
    control.times = { sh600519: '20261106095600' };
    expect(await current()).toMatchObject({
      estimate: {
        time: '2026-11-06T01:56:00.000Z',
        calculation: { quoteTimeEnd: '2026-11-06T02:00:00.000Z' },
      },
    });
  });
  it.each([
    'missing',
    'old',
    'future',
    'yesterday',
    'report-old',
    'report-future',
    'weights',
    'negative',
    'foreign',
    'nav',
    'qdii',
    'unknown',
    'coverage',
  ])('rejects %s input instead of inventing zero', async (kind) => {
    control.report = report();
    if (kind === 'missing') control.missing = 'sh600519';
    if (kind === 'old') {
      control.times = { sh600519: '20261106095459' };
      control.thsFault = true;
    }
    if (kind === 'future') {
      control.times = { sh600519: '20261106100100' };
      control.thsFault = true;
    }
    if (kind === 'yesterday') {
      control.times = { sh600519: '20261105150000' };
      control.thsFault = true;
    }
    if (kind === 'report-old') control.report = report(['20%', '10%'], '2025-12-31');
    if (kind === 'report-future') control.report = report(['20%', '10%'], '2026-12-31');
    if (kind === 'weights') control.report = report(['60%', '60%']);
    if (kind === 'negative') control.report = report(['-1%', '10%']);
    if (kind === 'foreign')
      control.report = report(['20%', '10%'], '2026-09-30', ['00700', '300308']);
    if (kind === 'nav') control.navDate = '2026-11-04';
    if (kind === 'qdii') control.fund = 'qdii';
    if (kind === 'unknown') control.fund = 'unknown';
    if (kind === 'coverage') control.now = '2027-11-08T02:00:00Z';
    expect(await current()).toMatchObject({ status: 'unavailable', estimate: null });
  });
  it('revalidates the cached NAV and quotes across the publication window', async () => {
    control.report = report();
    control.now = '2026-11-06T10:59:59Z';
    control.times = { sh600519: '20261106150000', sz300308: '20261106150000' };
    const target = app();
    expect((await current(target)).status).toBe('estimated');
    control.now = '2026-11-06T11:05:01Z';
    control.navDate = '2026-11-04';
    expect((await current(target)).status).toBe('unavailable');
  });
  it('verifies the real 110020→510310 relation with the exchange ETF type and quote', async () => {
    control.fund = 'etf';
    expect(await current(app(), '110020')).toMatchObject({
      estimate: {
        source: 'calculated',
        sourceName: '自算',
        changePercent: 1,
        value: '1.0100',
        calculation: { method: 'parent_etf', parentEtfCode: '510310' },
      },
    });
  });
  it.each([
    ['001051', '510050', 'sse'],
    ['110021', '510130', 'sse'],
    ['110019', '159901', 'szse'],
  ])('accepts the official domestic ETF mapping %s→%s', async (fundCode, parent, market) => {
    control.fund = 'etf';
    control.mapping = sample(`eastmoney/fund-${fundCode}.txt`);
    control.identity = market === 'sse' ? sample(`sse/fund-${parent}.json`) : '';
    const target = app();
    const item = await current(target, fundCode);
    expect(item).toMatchObject({
      status: 'estimated',
      estimate: { source: 'calculated', calculation: { parentEtfCode: parent } },
    });
    expect((await history(target, fundCode)).points).toHaveLength(2);
  });
  it('falls back from a failed mother-ETF Tencent quote to a validated THS pair', async () => {
    control.fund = 'etf';
    control.fault = 'qt.gtimg.cn';
    control.series.hs_510310 = '0930,101,0,0,0;1000,101,0,0,0';
    expect(await current(app(), '110020')).toMatchObject({
      status: 'estimated',
      estimate: { source: 'calculated', calculation: { quoteSource: 'ths' } },
    });
    control.thsFault = true;
    expect(await current(app(), '110020')).toMatchObject({ status: 'unavailable', estimate: null });
  });
  it.each(['normal', 'missing', 'old', 'future', 'yesterday', 'transport'])(
    'mother ETF Tencent %s uses the appropriate trusted source',
    async (kind) => {
      control.fund = 'etf';
      control.series.hs_510310 = '0930,101,0,0,0;1000,101,0,0,0';
      if (kind === 'missing') control.tencentMissing = 'sh510310';
      if (kind === 'old') control.times.sh510310 = '20261106095459';
      if (kind === 'future') control.times.sh510310 = '20261106100100';
      if (kind === 'yesterday') control.times.sh510310 = '20261105150000';
      if (kind === 'transport') control.fault = 'qt.gtimg.cn';
      expect(await current(app(), '110020')).toMatchObject({
        status: 'estimated',
        estimate: {
          time: '2026-11-06T02:00:00.000Z',
          fallback: true,
          referenceOnly: true,
          calculation: { quoteSource: kind === 'normal' ? 'tencent' : 'ths' },
        },
      });
    },
  );
  it('rejects a missing Tencent quote and an inconsistent THS pair', async () => {
    control.fund = 'etf';
    control.tencentMissing = 'sh510310';
    control.snapshotPre = '99';
    expect(await current(app(), '110020')).toMatchObject({ status: 'unavailable', estimate: null });
  });
  it('rejects a SZSE non-ETF identity without using its valid price', async () => {
    control.fund = 'etf';
    control.mapping = sample('eastmoney/fund-110019.txt');
    control.szseIdentity = control.szseIdentity.replace('"jjlb":"ETF"', '"jjlb":"LOF"');
    expect(await current(app(), '110019')).toMatchObject({ status: 'unavailable', estimate: null });
  });
  it.each([
    'wrong-page',
    'no-link',
    'duplicate',
    'external',
    'self',
    'non-etf',
    'identity-fault',
    'quote-missing',
  ])('rejects ETF %s and recovers', async (kind) => {
    control.fund = 'etf';
    const original = control.mapping;
    const identity = control.identity;
    if (kind === 'wrong-page') control.mapping = control.mapping.replaceAll('110020', '110021');
    if (kind === 'no-link') control.mapping = control.mapping.replaceAll('查看相关ETF', '普通链接');
    if (kind === 'duplicate')
      control.mapping = control.mapping.replace(
        '查看相关ETF></a>',
        '查看相关ETF></a><a href="https://fund.eastmoney.com/510300.html">查看相关ETF</a>',
      );
    if (kind === 'external')
      control.mapping = control.mapping.replace(
        'http://fund.eastmoney.com/510310.html',
        'https://evil.example/510310.html',
      );
    if (kind === 'self')
      control.mapping = control.mapping.replaceAll('/510310.html', '/110020.html');
    if (kind === 'non-etf')
      control.identity = control.identity.replaceAll('"fundType":"00"', '"fundType":"10"');
    if (kind === 'identity-fault') control.fault = 'query.sse.com.cn';
    if (kind === 'quote-missing') control.missing = 'sh510310';
    const target = app();
    expect((await current(target, '110020')).status).toBe('unavailable');
    control.mapping = original;
    control.identity = identity;
    control.fault = '';
    control.missing = '';
    control.now = '2026-11-06T02:00:31Z';
    expect((await current(target, '110020')).status).toBe('estimated');
  });
  it('weights only shared intraday labels, skips missing points and filters future points', async () => {
    control.report = report();
    control.series.sz_300308 = '0930,101,0,0,0;1001,101,0,0,0';
    const body = await history();
    expect(body.points).toEqual([
      { time: '2026-11-06T01:30:00.000Z', changePercent: 0.3, value: '1.0030' },
    ]);
    expect(body.coverage).toEqual({ returnedPoints: 1, omittedPoints: 1 });
  });
  it('calculates ETF historical points using the real mapping', async () => {
    control.fund = 'etf';
    const body = await history(app(), '110020');
    expect(body.points).toHaveLength(2);
    expect(body.points[0]).toMatchObject({ changePercent: 1, value: '1.0100' });
  });
  it.each([
    ['2026-11-10T07:31:00.000Z', 242],
    ['2026-11-10T02:00:00.000Z', 31],
    ['2026-11-10T01:29:00.000Z', 0],
  ])('filters the real ETF pair at asOf %s', async (asOf, expectedCount) => {
    control.fund = 'etf';
    control.now = String(asOf);
    control.navDate = '2026-11-09';
    const original = control.replay;
    control.replay = (url) => {
      if (url.hostname === 'd.10jqka.com.cn') {
        const [, kind, symbol] = /\/v6\/(realhead|time)\/([^/]+)\//.exec(url.pathname) ?? [];
        return sample(`ths/${kind}-${symbol}.jsonp`);
      }
      return original(url);
    };
    const body = await history(app(), '110020');
    expect(body.points).toHaveLength(Number(expectedCount));
    expect(body.points.every((point) => Date.parse(point.time) <= Date.parse(control.now))).toBe(
      true,
    );
    if (expectedCount === 242) expect(body.points.at(-1)?.time).toBe('2026-11-10T07:00:00.000Z');
  });
  it.each([
    'cross-day',
    'garbage',
    'invalid-day',
    'negative-price',
    'bad-pre',
    'non-session',
    'duplicate-conflict',
  ])('rejects intraday %s', async (kind) => {
    control.report = report();
    if (kind === 'cross-day') control.seriesDate = '20261105';
    if (kind === 'garbage') control.series.hs_600519 = 'garbage';
    if (kind === 'invalid-day') control.seriesDate = '20260230';
    if (kind === 'negative-price') control.series.hs_600519 = '0930,-101,0,0,0';
    if (kind === 'bad-pre') control.snapshotPre = '99';
    if (kind === 'non-session') control.series.hs_600519 = '1200,101,0,0,0';
    if (kind === 'duplicate-conflict') control.series.hs_600519 = '0930,101,0,0,0;0930,100,0,0,0';
    const response = await app().request('/v1/funds/000001/estimates/intraday');
    if (kind === 'cross-day' || kind === 'non-session') {
      expect(response.status).toBe(200);
      expect(((await response.json()) as IntradayEstimate).points).toEqual([]);
    } else {
      expect(response.status).toBe(502);
    }
  });
  it('sorts and deduplicates identical historical labels', async () => {
    control.report = report();
    control.series.hs_600519 = '1000,101,0,0,0;0930,101,0,0,0;0930,101,0,0,0';
    control.series.sz_300308 = control.series.hs_600519;
    expect((await history()).points.map((p) => p.time)).toEqual([
      '2026-11-06T01:30:00.000Z',
      '2026-11-06T02:00:00.000Z',
    ]);
  });
  it('returns a legitimate empty THS data payload as HTTP 200', async () => {
    control.series.hs_600519 = '';
    control.series.sz_300308 = '';
    const response = await app().request('/v1/funds/000001/estimates/intraday');
    expect(response.status).toBe(200);
    expect(((await response.json()) as IntradayEstimate).points).toEqual([]);
  });
  it.each(['2026-11-06T00:00:00Z', '2026-11-07T02:00:00Z'])(
    'returns empty history outside sessions %s',
    async (now) => {
      control.now = now;
      expect((await history()).points).toEqual([]);
    },
  );
  it('distinguishes upstream protocol failure from legitimate empty history', async () => {
    control.report = report();
    control.fault = 'd.10jqka.com.cn';
    const response = await app().request('/v1/funds/000001/estimates/intraday');
    expect(response.status).toBe(502);
  });
  it('does not expose internal mapping on the fund detail contract', async () => {
    control.fund = 'etf';
    const response = await app().request('/v1/funds/110020');
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty('parentEtfCode');
  });
  it('uses the real non-QDII gold feeder mapping and exchange identity for current and history', async () => {
    control.baseInfo = sample('eastmoney/base-000216.json');
    control.mapping = sample('eastmoney/fund-000216.txt');
    control.identity = sample('sse/fund-518880.json');
    const target = app();
    expect(await current(target, '000216')).toMatchObject({
      status: 'estimated',
      estimate: { source: 'calculated', calculation: { parentEtfCode: '518880' } },
    });
    expect((await history(target, '000216')).status).toBe('estimated');
  });
  // Protocol-shaped class controls: the class meanings come from the preserved official script.
  it.each(['01', '02', '03', '06', '08', '09', '31', '32', '36', '37', '38'])(
    'accepts documented mainland SSE ETF class %s',
    async (subClass) => {
      control.fund = 'etf';
      const identity = JSON.parse(control.identity);
      identity.result[0].subClass = subClass;
      control.identity = JSON.stringify(identity);
      expect((await current(app(), '110020')).status).toBe('estimated');
    },
  );
  it.each(['04', '05', '07', '11', '33', '34', '35', '99'])(
    'rejects non-ETF or unproven overseas SSE class %s',
    async (subClass) => {
      control.fund = 'etf';
      const identity = JSON.parse(control.identity);
      identity.result[0].subClass = subClass;
      control.identity = JSON.stringify(identity);
      expect((await current(app(), '110020')).status).toBe('unavailable');
    },
  );
  it.each(['股票基金', '混合基金', '债券基金', '货币市场基金'])(
    'accepts SZSE ETF identity independently of investment class %s',
    async (tzlb) => {
      control.fund = 'etf';
      control.mapping = sample('eastmoney/fund-110019.txt');
      const identity = JSON.parse(control.szseIdentity);
      identity[0].data[0].tzlb = tzlb;
      control.szseIdentity = JSON.stringify(identity);
      expect((await current(app(), '110019')).status).toBe('estimated');
    },
  );
  it.each([
    ['1010.0', 200],
    ['1010.00', 200],
    ['1010.01', 502],
    ['1010.001', 502],
    ['1010.0001', 502],
    ['1020.00', 502],
  ])('compares duplicate raw price %s before rounding (%s)', async (second, expected) => {
    control.report = report();
    control.pre = '1000';
    control.snapshotPre = '1000';
    control.snapshotPrice = '1010.00';
    control.series.hs_600519 = `0930,1010.00,0,0,0;0930,${second},0,0,0;1000,1010.00,0,0,0`;
    control.series.sz_300308 = '0930,1010.00,0,0,0;1000,1010.00,0,0,0';
    const response = await app().request('/v1/funds/000001/estimates/intraday');
    expect(response.status).toBe(Number(expected));
    if (expected === 200)
      expect(((await response.json()) as IntradayEstimate).points).toHaveLength(2);
  });
  it.each(['159972', '159934'])('uses real SZSE non-equity ETF identity %s', async (parent) => {
    // Synthetic feeder relation to isolate the real exchange identity, not a claimed official mapping.
    control.fund = 'etf';
    control.mapping = sample('eastmoney/fund-110019.txt').replaceAll('159901', parent);
    control.szseIdentity = sample(`szse/fund-${parent}.json`);
    const target = app();
    expect((await current(target, '110019')).status).toBe('estimated');
    expect((await history(target, '110019')).status).toBe('estimated');
  });
  it.each(['wrong-code', 'non-etf', 'future-listing', 'unknown-class'])(
    'rejects SSE %s identity despite valid quotes',
    async (kind) => {
      control.fund = 'etf';
      const identity = JSON.parse(control.identity);
      if (kind === 'wrong-code') identity.result[0].fundCode = '510999';
      if (kind === 'non-etf') identity.result[0].fundType = '10';
      if (kind === 'future-listing') identity.result[0].listingDate = '20271110';
      if (kind === 'unknown-class') identity.result[0].subClass = '99';
      control.identity = JSON.stringify(identity);
      expect((await current(app(), '110020')).status).toBe('unavailable');
    },
  );

  describe('quotes are judged when they are observed, not at the request start', () => {
    // Holding and parent ETF quotes follow the holdings rule: a quote may not be later than
    // the moment it was returned, and session/freshness rules apply at that moment.
    function slowTencent(observedAt: string, quoteTime?: string) {
      const replay = control.replay;
      control.replay = (url) => {
        const result = replay(url);
        if (url.hostname !== 'qt.gtimg.cn' || typeof result !== 'string') return result;
        control.now = observedAt;
        return quoteTime ? result.replaceAll('20261106100000', quoteTime) : result;
      };
    }
    /** Shanghai wall clock as Tencent's YYYYMMDDhhmmss quote time. */
    function tencentTime(iso: string) {
      return new Date(new Date(iso).getTime() + 8 * 3600_000)
        .toISOString()
        .slice(0, 19)
        .replace(/\D/g, '');
    }

    it('keeps a snapshot newer than the request start when the quote fetch returns late', async () => {
      slowTencent(`${day}T02:00:40.000Z`, '20261106100030');
      const response = await app().request('/v1/funds/estimates?codes=000001');
      const body = (await response.json()) as EstimateBatchResponse;
      expect(body.time).toBe('2026-11-06T02:00:00.000Z');
      expect(body.items[0]).toMatchObject({
        status: 'estimated',
        estimate: {
          source: 'calculated',
          time: '2026-11-06T02:00:30.000Z',
          calculation: { quoteTimeEnd: '2026-11-06T02:00:30.000Z' },
        },
      });
    });

    it('keeps a late parent ETF snapshot for an ETF feeder', async () => {
      control.fund = 'etf';
      slowTencent(`${day}T02:00:40.000Z`, '20261106100030');
      expect(await current(app(), '110020')).toMatchObject({
        status: 'estimated',
        estimate: { source: 'calculated', time: '2026-11-06T02:00:30.000Z' },
      });
    });

    it('rejects quotes stamped after the moment they were returned', async () => {
      slowTencent(`${day}T02:00:40.000Z`, '20261106100100');
      expect(await current()).toEqual({ code: '000001', status: 'unavailable', estimate: null });

      control.fund = 'etf';
      expect(await current(app(), '110020')).toEqual({
        code: '110020',
        status: 'unavailable',
        estimate: null,
      });
    });

    it('rejects a slow fetch whose quotes are stale by the time they return', async () => {
      // 10:04:30 quotes are fresh at a 10:09:00 request, but the fetch returns at 10:09:40,
      // more than five minutes after the quotes: holdings drop them, so no estimate is formed.
      control.now = `${day}T02:09:00.000Z`;
      const replay = control.replay;
      control.replay = (url) => {
        const result = replay(url);
        return url.hostname === 'qt.gtimg.cn' && typeof result === 'string'
          ? result.replaceAll('20261106100000', '20261106100430')
          : result;
      };
      expect((await current()).status).toBe('estimated');

      control.replay = replay;
      slowTencent(`${day}T02:09:40.000Z`, '20261106100430');
      expect((await current()).status).toBe('unavailable');
    });

    it('is available during trading when both sources fail and quotes carry their fetch time', async () => {
      // Every upstream call takes 1.5 s, and Tencent stamps each snapshot with the time it
      // answers, as it does during continuous trading; the request starts at 10:15:00.
      control.now = `${day}T02:15:00.000Z`;
      const replay = control.replay;
      control.replay = (url) => {
        control.now = new Date(new Date(control.now).getTime() + 1500).toISOString();
        const result = replay(url);
        return url.hostname === 'qt.gtimg.cn' && typeof result === 'string'
          ? result.replaceAll('20261106100000', tencentTime(control.now))
          : result;
      };
      const item = await current();
      expect(item).toMatchObject({ status: 'estimated', estimate: { source: 'calculated' } });
      expect(Date.parse(item.estimate!.time)).toBeGreaterThan(Date.parse(`${day}T02:15:00.000Z`));

      control.fund = 'etf';
      expect(await current(app(), '110020')).toMatchObject({
        status: 'estimated',
        estimate: { source: 'calculated' },
      });
    });

    it('includes intraday labels up to the moment the series were returned', async () => {
      control.report = report();
      const replay = control.replay;
      control.replay = (url) => {
        if (url.hostname === 'd.10jqka.com.cn') control.now = `${day}T02:01:10.000Z`;
        return replay(url);
      };
      const body = await history();
      expect(body.points.map((point) => point.time)).toEqual([
        '2026-11-06T01:30:00.000Z',
        '2026-11-06T02:00:00.000Z',
        '2026-11-06T02:01:00.000Z',
      ]);
    });
  });
  describe('upstream last success times in /v1/health', () => {
    type Upstreams = Record<string, { lastSuccessAt: string | null }>;
    async function upstreams(target: ReturnType<typeof app>) {
      const response = await target.request('/v1/health');
      expect(response.status).toBe(200);
      const body = (await response.json()) as { upstreams: Upstreams };
      return Object.fromEntries(
        Object.entries(body.upstreams).map(([name, v]) => [name, v.lastSuccessAt]),
      );
    }
    const T = `${day}T02:00:00.000Z`;

    it.each([
      ['tencent', 'normal', { tencent: T, ths: null }],
      ['THS when Tencent fails', 'transport', { tencent: null, ths: T }],
      ['THS but not a stale Tencent quote', 'old', { tencent: null, ths: T }],
      ['neither when THS is also inconsistent', 'both-bad', { tencent: null, ths: null }],
    ])('records %s for parent ETF quotes', async (_name, kind, expected) => {
      control.fund = 'etf';
      control.series.hs_510310 = '0930,101,0,0,0;1000,101,0,0,0';
      if (kind === 'transport') control.fault = 'qt.gtimg.cn';
      if (kind === 'old') control.times.sh510310 = '20261106095459';
      if (kind === 'both-bad') {
        control.tencentMissing = 'sh510310';
        control.snapshotPre = '99';
      }
      const target = app();
      expect((await current(target, '110020')).status).toBe(
        kind === 'both-bad' ? 'unavailable' : 'estimated',
      );
      expect(await upstreams(target)).toMatchObject({ tiantian: null, sina: null, ...expected });
    });

    it.each([
      ['an adopted relation', 'valid', '2026-11-06T03:00:01.000Z'],
      ['a page without the relation link', 'no-link', '2026-11-06T03:00:00.000Z'],
      ['a relation the exchange does not confirm', 'non-etf', '2026-11-06T03:00:00.000Z'],
    ])('refreshes EastMoney for the ETF relation only for %s', async (_name, kind, expected) => {
      control.fund = 'etf';
      const replay = control.replay;
      let relationFetchedAt = '';
      control.replay = (url) => {
        if (url.hostname === 'fund.eastmoney.com' && relationFetchedAt)
          control.now = relationFetchedAt;
        return replay(url);
      };
      const target = app();
      // Warm up: caches the NAV for the day and the relation for an hour.
      expect((await current(target, '110020')).status).toBe('estimated');
      // One hour later the relation is fetched again. Fund info (also EastMoney, uncached) is
      // fetched first at 03:00; the relation page moves the clock one second on, and the NAV
      // is a cache hit, so only a recorded relation can produce the later time.
      control.now = `${day}T03:00:00.000Z`;
      relationFetchedAt = `${day}T03:00:01.000Z`;
      control.times.sh510310 = '20261106110000';
      if (kind === 'no-link') control.mapping = control.mapping.replace(/查看\s*相关ETF/g, '');
      if (kind === 'non-etf')
        control.identity = control.identity.replace(/"subClass":"\d+"/g, '"subClass":"05"');
      expect((await current(target, '110020')).status).toBe(
        kind === 'valid' ? 'estimated' : 'unavailable',
      );
      expect((await upstreams(target)).eastmoney).toBe(expected);
    });

    it('records THS for an intraday series with points, not for an empty or failed one', async () => {
      control.report = report();
      const target = app();
      expect((await history(target)).points).toHaveLength(2);
      expect((await upstreams(target)).ths).toBe(T);

      control.series.hs_600519 = '';
      control.series.sz_300308 = '';
      const empty = app();
      expect((await history(empty)).points).toEqual([]);
      expect((await upstreams(empty)).ths).toBeNull();

      control.series = {};
      control.snapshotPrice = '200';
      const invalid = app();
      expect((await invalid.request('/v1/funds/000001/estimates/intraday')).status).toBe(502);
      expect((await upstreams(invalid)).ths).toBeNull();
    });
  });
});

describe('calculated estimate review r5 boundaries over HTTP', () => {
  let db: TestSchema, calendar: TradingCalendar, control: ReplayControls;
  /** Per THS symbol: the moment its pair returns. Others return at the current clock. */
  let thsReturns: Record<string, string>;
  beforeEach(async () => {
    db = await createTestSchema();
    await importHolidays(db.pool, cn2026.year, cn2026.holidays);
    calendar = await loadTradingCalendar(db.pool);
    control = new ReplayControls();
    thsReturns = {};
  });
  afterEach(async () => dropTestSchema(db));
  function app() {
    return createApp({
      db: createHealthProbe(db.pool),
      upstream: {
        async fetchText(request) {
          const url = new URL(request.url);
          const symbol = /\/v6\/(?:realhead|time)\/([^/]+)\//.exec(url.pathname)?.[1];
          const returnsAt = symbol ? thsReturns[symbol] : undefined;
          if (url.hostname === 'd.10jqka.com.cn' && returnsAt) {
            // Let faster calls resolve and read the clock first, then answer late.
            await immediate();
            control.now = returnsAt;
          }
          const result = control.replay(url);
          if (result instanceof UpstreamError) throw result;
          return result;
        },
      },
      clock: { now: () => new Date(control.now) },
      tradingCalendar: calendar,
    });
  }
  async function intraday(code = '000001') {
    const response = await app().request(`/v1/funds/${code}/estimates/intraday`);
    expect(response.status).toBe(200);
    return (await response.json()) as IntradayEstimate;
  }
  async function current(target = app(), code = '000001') {
    const response = await target.request(`/v1/funds/estimates?codes=${code}`);
    expect(response.status).toBe(200);
    return ((await response.json()) as EstimateBatchResponse).items[0]!;
  }
  const at = (hhmm: string) => `${day}T${hhmm}:00.000Z`;

  describe('SP-R5-1: each intraday series is judged at its own observation', () => {
    beforeEach(() => {
      control.report = report();
      control.series.hs_600519 = '1000,101,0,0,0;1001,101,0,0,0';
      control.series.sz_300308 = '1000,101,0,0,0;1001,101,0,0,0';
    });

    it('returns only 10:00 when both series return at 10:00', async () => {
      const body = await intraday();
      expect(body.points.map((point) => point.time)).toEqual([at('02:00')]);
      expect(body.coverage).toEqual({ returnedPoints: 1, omittedPoints: 0 });
    });

    it('returns 10:00 and 10:01 when both series return at 10:02', async () => {
      thsReturns = { hs_600519: at('02:02'), sz_300308: at('02:02') };
      const body = await intraday();
      expect(body.points.map((point) => point.time)).toEqual([at('02:00'), at('02:01')]);
    });

    it('drops a future label of a fast series even when a slower series returns later', async () => {
      // 600519 returns at 10:00 carrying 10:01; 300308 returns at 10:02 with the same label.
      thsReturns = { sz_300308: at('02:02') };
      const body = await intraday();
      expect(body.points.map((point) => point.time)).toEqual([at('02:00')]);
      expect(body.coverage).toEqual({ returnedPoints: 1, omittedPoints: 1 });
    });

    it('counts a label only the slower series has as omitted', async () => {
      control.series.hs_600519 = '1000,101,0,0,0';
      thsReturns = { sz_300308: at('02:02') };
      const body = await intraday();
      expect(body.points.map((point) => point.time)).toEqual([at('02:00')]);
      expect(body.coverage).toEqual({ returnedPoints: 1, omittedPoints: 1 });
    });

    it.each(['domestic', 'etf'])(
      'returns no previous-day %s series once the Shanghai date changes during the fetch',
      async (fund) => {
        control.fund = fund;
        control.now = '2026-11-06T15:59:59.000Z'; // Friday 23:59:59
        for (const symbol of ['hs_600519', 'sz_300308', 'hs_510310']) {
          control.series[symbol] = '1500,101,0,0,0';
          thsReturns[symbol] = '2026-11-06T16:00:01.000Z'; // Saturday 00:00:01
        }
        const body = await intraday(fund === 'etf' ? '110020' : '000001');
        expect(body).toMatchObject({ tradeDate: day, status: 'unavailable', points: [] });

        // Control: the same series returned before midnight are Friday's closing points.
        control.now = '2026-11-06T15:59:59.000Z';
        thsReturns = {};
        expect((await intraday(fund === 'etf' ? '110020' : '000001')).status).toBe('estimated');
      },
    );

    it.each(['domestic', 'etf'])(
      'rejects a %s current estimate whose quotes return after Shanghai midnight',
      async (fund) => {
        control.fund = fund;
        control.report = report();
        control.now = '2026-11-06T15:59:59.000Z'; // Friday 23:59:59
        const replay = control.replay;
        control.replay = (url) => {
          const result = replay(url);
          if (url.hostname !== 'qt.gtimg.cn' || typeof result !== 'string') return result;
          control.now = '2026-11-06T16:00:01.000Z';
          return result.replaceAll('20261106100000', '20261106150000');
        };
        const code = fund === 'etf' ? '110020' : '000001';
        expect(await current(app(), code)).toEqual({ code, status: 'unavailable', estimate: null });
      },
    );
  });

  describe('SP-R5-2: the Sina A-share subset never backs a calculated model', () => {
    const thursday = '2026-11-12';
    function sinaSubsetDay(emDown: () => boolean, quoteDay: string) {
      const replay = control.replay;
      control.replay = (url) => {
        if (url.hostname === 'fundf10.eastmoney.com')
          return emDown() ? new UpstreamError('timeout', 'synthetic EM outage') : control.report;
        if (url.hostname === 'finance.sina.com.cn') return sample('sina/holdings-005827-page.txt');
        const result = replay(url);
        return url.hostname === 'qt.gtimg.cn' && typeof result === 'string'
          ? result.replaceAll('20261106100000', `${quoteDay.replaceAll('-', '')}100000`)
          : result;
      };
    }

    it('keeps the full Eastmoney list unavailable while it has unquoted HK holdings', async () => {
      control.now = `${thursday}T02:00:00.000Z`;
      control.navDate = '2026-11-11';
      control.seriesDate = '20261112';
      control.report = sample('eastmoney/holdings-005827.txt');
      sinaSubsetDay(() => false, thursday);
      expect((await current(app(), '005827')).status).toBe('unavailable');
      expect((await intraday('005827')).status).toBe('unavailable');
    });

    it('is unavailable from a Sina list, stays so for the cached day, and recovers with Eastmoney the next day', async () => {
      let emDown = true;
      const original = control.replay;
      control.now = `${thursday}T02:00:00.000Z`;
      control.navDate = '2026-11-11';
      control.seriesDate = '20261112';
      control.report = report(); // synthetic complete A-share disclosure for the recovery day
      sinaSubsetDay(() => emDown, thursday);
      const target = app();

      const holdings = await target.request('/v1/funds/005827/holdings');
      expect(await holdings.json()).toMatchObject({
        holdingsSource: 'sina',
        holdingsFallback: true,
      });
      expect(await current(target, '005827')).toEqual({
        code: '005827',
        status: 'unavailable',
        estimate: null,
      });
      const history = await target.request('/v1/funds/005827/estimates/intraday');
      expect(((await history.json()) as IntradayEstimate).status).toBe('unavailable');

      // Eastmoney recovers the same day, but the day's cached list is still the Sina subset.
      emDown = false;
      control.now = `${thursday}T02:01:00.000Z`;
      expect((await current(target, '005827')).status).toBe('unavailable');
      const cached = await target.request('/v1/funds/005827/estimates/intraday');
      expect(((await cached.json()) as IntradayEstimate).status).toBe('unavailable');

      // Next trading day: the list is fetched again from Eastmoney.
      const friday = '2026-11-13';
      control.now = `${friday}T02:00:00.000Z`;
      control.navDate = thursday;
      control.seriesDate = '20261113';
      control.replay = original;
      control.report = report();
      sinaSubsetDay(() => false, friday);
      expect(await current(target, '005827')).toMatchObject({
        status: 'estimated',
        estimate: { source: 'calculated', calculation: { method: 'top_holdings' } },
      });
      const recovered = await target.request('/v1/funds/005827/estimates/intraday');
      expect(((await recovered.json()) as IntradayEstimate).status).toBe('estimated');
    });
  });
});
