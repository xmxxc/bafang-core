import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  series: Record<string, string> = {};
  seriesDate = '20261106';
  pre = '100';
  snapshotPre = '100';
  fault = '';
  thsFault = false;
  replay: Replay = (url) => {
    if (url.hostname === this.fault) return new UpstreamError('timeout', 'synthetic failure');
    if (['fundcomapi.tiantianfunds.com', 'hq.sinajs.cn'].includes(url.hostname))
      return new UpstreamError('timeout', 'force tertiary fallback');
    if (url.hostname === 'fundmobapi.eastmoney.com') {
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
          symbol === this.missing
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
        return `cb(${JSON.stringify({ items: { '6': this.snapshotPre, '10': '101' } })})`;
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
      control.missing = 'sh600519';
    }
    if (kind === 'future') {
      control.times = { sh600519: '20261106100100' };
      control.missing = 'sh600519';
    }
    if (kind === 'yesterday') {
      control.times = { sh600519: '20261105150000' };
      control.missing = 'sh600519';
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
    'cross-day',
    'invalid-day',
    'negative-price',
    'bad-pre',
    'non-session',
    'duplicate-conflict',
  ])('rejects intraday %s', async (kind) => {
    control.report = report();
    if (kind === 'cross-day') control.seriesDate = '20261105';
    if (kind === 'invalid-day') control.seriesDate = '20260230';
    if (kind === 'negative-price') control.series.hs_600519 = '0930,-101,0,0,0';
    if (kind === 'bad-pre') control.snapshotPre = '99';
    if (kind === 'non-session') control.series.hs_600519 = '1200,101,0,0,0';
    if (kind === 'duplicate-conflict') control.series.hs_600519 = '0930,101,0,0,0;0930,100,0,0,0';
    expect((await history()).points).toEqual([]);
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
});
