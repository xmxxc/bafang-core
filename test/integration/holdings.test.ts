import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createApp, type AppDeps } from '../../src/app';
import { createHealthProbe } from '../../src/db';
import { ChineseTradingCalendar } from '../../src/trading-calendar';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';
import { UpstreamError, type UpstreamFetcher } from '../../src/market/upstream';

const fixture = (name: string) =>
  readFileSync(path.resolve('test/fixtures/upstream', name), 'utf8');
const em = fixture('eastmoney/holdings-000001.json');
const sina = fixture('sina/holdings-000001-page.txt');
const tencent = fixture('tencent/holdings-000001.txt');
// Synthetic protocol-faithful reports and quote mutations exercise failure/time boundaries.
const row = (code = '600519', name = '贵州茅台', weight = '5.26%') =>
  `<tr><td>1</td><td>${code}</td><td>${name}</td><td>--</td><td>--</td><td>行情</td><td>${weight}</td></tr>`;
const block = (date = '2026-09-30', rows = row()) =>
  `<h4>截止至：<font>${date}</font></h4><table><thead><tr><th>股票代码</th><th>股票名称</th><th>占净值比例</th></tr></thead><tbody>${rows}</tbody></table>`;
const script = (html = block()) =>
  `var apidata={ content:${JSON.stringify(html)},arryear:[2026],curyear:2026};`;
function qt(symbol: string, price: string, stamp: string, previous = '100.00') {
  const fields = Array<string>(31).fill('');
  fields[3] = price;
  fields[4] = previous;
  fields[30] = stamp;
  return `v_${symbol}="${fields.join('~')}";`;
}
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
class Replay implements UpstreamFetcher {
  em = script();
  sina = sina;
  now = new Date('2026-11-09T06:00:00Z');
  stamp = '20261109140000';
  price = '100.00';
  previous = '100.00';
  emDown = false;
  sinaDown = true;
  tencentDown = false;
  missingQuote = false;
  realTencent = false;
  ths = false;
  async fetchText({ url }: { url: string }): Promise<string> {
    if (url.includes('FundArchivesDatas')) {
      if (this.emDown) throw new UpstreamError('timeout', 'EM diagnostic proof');
      return this.em;
    }
    if (url.includes('/bc.shtml')) {
      if (this.sinaDown) throw new UpstreamError('timeout', 'Sina diagnostic proof');
      return this.sina;
    }
    if (url.includes('qt.gtimg.cn')) {
      if (this.tencentDown) throw new UpstreamError('timeout', 'Tencent diagnostic proof');
      if (this.realTencent) return tencent;
      return url
        .split('q=')[1]!
        .split(',')
        .map((symbol) =>
          this.missingQuote ? `v_${symbol}="";` : qt(symbol, this.price, this.stamp, this.previous),
        )
        .join('\n');
    }
    const pair = /\/(realhead|time)\/(hs_600519|sz_300308)\//.exec(url);
    if (this.ths && pair) return fixture(`ths/${pair[1]}-${pair[2]}-holdings.jsonp`);
    throw new UpstreamError('timeout', 'THS diagnostic proof');
  }
}
const endpoint = '/v1/funds/000001/holdings';
interface Body {
  reportDate: string;
  holdingsSource: 'eastmoney' | 'sina';
  holdingsFallback: boolean;
  items: Array<{
    code: string;
    name: string;
    weight: number;
    reportDate: string;
    quote: {
      price: string;
      prevClose: string;
      change: string;
      changePercent: number;
      tradeDate: string;
      quoteTime: string;
    } | null;
    quoteSource: string | null;
    quoteFallback: boolean;
  }>;
}
describe('fund top holdings over HTTP with an isolated PostgreSQL schema per case', () => {
  let db: TestSchema;
  let replay: Replay;
  beforeEach(async () => {
    db = await createTestSchema();
    replay = new Replay();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await dropTestSchema(db);
  });
  function app(deps: AppDeps = {}) {
    return createApp({
      db: createHealthProbe(db.pool),
      upstream: replay,
      clock: { now: () => replay.now },
      ...deps,
    });
  }
  async function get(target = app(), url = endpoint) {
    const response = await target.request(url);
    expect(response.status).toBe(200);
    return (await response.json()) as Body;
  }
  it('returns the complete real Sina latest-quarter table when EastMoney fails', async () => {
    replay.emDown = true;
    replay.sinaDown = false;
    const body = await get();
    expect(body.reportDate).toBe('2026-09-30');
    expect(body).toMatchObject({ holdingsSource: 'sina', holdingsFallback: true });
    expect(body.items.map(({ code }) => code)).toEqual([
      '300308',
      '688361',
      '688347',
      '688012',
      '002371',
      '688037',
      '300502',
      '688072',
      '688120',
      '688256',
    ]);
    expect(body.items[0]).toMatchObject({
      name: '中际旭创',
      weight: 5.26,
      reportDate: '2026-09-30',
    });
    expect(body.items[9]).toMatchObject({ name: '寒武纪', weight: 3.41, reportDate: '2026-09-30' });
  });
  it.each([
    [
      '005827',
      [
        '600519',
        '00883',
        '00700',
        '09987',
        '000568',
        '09988',
        '600809',
        '000858',
        '600674',
        '300502',
      ],
    ],
    [
      '110011',
      [
        '00883',
        '01179',
        '00700',
        '09988',
        '600519',
        '600809',
        '000858',
        '000568',
        '09987',
        '002027',
      ],
    ],
  ])(
    'retains all ten real latest %s holdings including Hong Kong equities',
    async (code, codes) => {
      replay.em = fixture(`eastmoney/holdings-${code}.txt`);
      const body = await get(app(), `/v1/funds/${code}/holdings`);
      expect(body.reportDate).toBe('2026-09-30');
      expect(body).toMatchObject({ holdingsSource: 'eastmoney', holdingsFallback: false });
      expect(body.items.map((item) => item.code)).toEqual(codes);
      expect(body.items.every((item) => item.reportDate === '2026-09-30')).toBe(true);
      expect(
        body.items
          .filter((item) => item.code.length === 5)
          .every((item) => item.quote === null && item.quoteSource === null),
      ).toBe(true);
      expect(body.items.find((item) => item.code === '00883')).toMatchObject({
        name: '中国海洋石油',
        weight: code === '005827' ? 6.22 : 9.55,
      });
    },
  );
  it('labels the real 005827 Sina fallback that lists only its A-share holdings', async () => {
    replay.emDown = true;
    replay.sinaDown = false;
    replay.sina = fixture('sina/holdings-005827-page.txt');
    const body = await get(app(), '/v1/funds/005827/holdings');
    expect(body).toMatchObject({
      reportDate: '2026-09-30',
      holdingsSource: 'sina',
      holdingsFallback: true,
    });
    expect(body.items.map((item) => [item.code, item.weight])).toEqual([
      ['600519', 6.37],
      ['000568', 4.58],
      ['600809', 2.89],
      ['000858', 2.79],
      ['600674', 2.55],
      ['300502', 2.33],
    ]);
  });
  it('returns 502 when the real 110011 Sina page has no holdings section', async () => {
    replay.emDown = true;
    replay.sinaDown = false;
    replay.sina = fixture('sina/holdings-110011-page.txt');
    const response = await app().request('/v1/funds/110011/holdings');
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { code: 'upstream_unavailable', message: '行情上游暂不可用' },
    });
  });
  it('keeps the Sina label on the cached daily list until the next Shanghai day', async () => {
    replay.emDown = true;
    replay.sinaDown = false;
    const target = app();
    expect(await get(target)).toMatchObject({ holdingsSource: 'sina', holdingsFallback: true });
    replay.emDown = false;
    replay.now = new Date('2026-11-09T06:00:10Z');
    const cached = await get(target);
    expect(cached).toMatchObject({ holdingsSource: 'sina', holdingsFallback: true });
    expect(cached.items).toHaveLength(10);
    replay.now = new Date('2026-11-10T06:00:00Z');
    replay.stamp = '20261110140000';
    const next = await get(target);
    expect(next).toMatchObject({ holdingsSource: 'eastmoney', holdingsFallback: false });
    expect(next.items.map((item) => item.code)).toEqual(['600519']);
  });
  it('ignores future EM quarters and selects the latest report no later than asOf', async () => {
    replay.em = script(
      block('2026-09-30', row('600519', '旧季股票')) +
        block('2027-03-31', row('300308', '未来股票')),
    );
    const body = await get();
    expect(body.reportDate).toBe('2026-09-30');
    expect(body.items[0]).toMatchObject({ code: '600519', name: '旧季股票' });
  });
  it('falls back when EM contains only a future report and does not cache it', async () => {
    replay.em = script(block('2027-03-31', row('300308', '未来股票')));
    replay.sinaDown = true;
    const failed = await app().request(endpoint);
    expect(failed.status).toBe(502);
    replay.em = script(block('2026-09-30', row('600519', '恢复股票')));
    expect((await get()).items[0]).toMatchObject({ code: '600519', name: '恢复股票' });
  });
  it('rejects a future Sina page and accepts the restored same-day report', async () => {
    replay.emDown = true;
    replay.sinaDown = false;
    replay.sina = sina.replaceAll('2026-09-30', '2027-03-31');
    const failed = await app().request(endpoint);
    expect(failed.status).toBe(502);
    replay.sina = sina;
    expect((await get()).items[0]).toMatchObject({ code: '300308', reportDate: '2026-09-30' });
  });
  it('does not retain a future report in the same-day report cache after recovery', async () => {
    replay.em = script(block('2027-03-31', row('300308', '未来股票')));
    replay.sinaDown = true;
    const target = app();
    expect((await target.request(endpoint)).status).toBe(502);
    replay.em = script(block('2026-09-30', row('600519', '恢复股票')));
    expect((await get(target)).items[0]).toMatchObject({
      code: '600519',
      reportDate: '2026-09-30',
    });
  });
  it.each(['PEP', 'PEPX'])(
    'retains %s in the real 040046 report with unavailable quotes',
    async (code) => {
      // PEP is verbatim source; PEPX is only a synthetic identifier-length control.
      replay.em = fixture('eastmoney/holdings-040046.txt');
      if (code === 'PEPX') replay.em = replay.em.replaceAll('PEP', 'PEPX');
      const body = await get(app(), '/v1/funds/040046/holdings');
      expect(body.reportDate).toBe('2022-12-08');
      expect(body.items.map((item) => item.code)).toEqual([
        'AAPL',
        'MSFT',
        'AMZN',
        'NVDA',
        'GOOG',
        'GOOGL',
        'TSLA',
        code,
        'META',
        'AVGO',
      ]);
      expect(body.items[7]).toMatchObject({
        code,
        name: '百事',
        weight: 1.61,
        reportDate: '2022-12-08',
        quote: null,
        quoteSource: null,
        quoteFallback: false,
      });
      expect(
        body.items.every((item) => item.reportDate === '2022-12-08' && item.quote === null),
      ).toBe(true);
    },
  );
  it('does not fill a shorter latest report with an older quarter', async () => {
    replay.em = script(block('2026-06-30', row('300308', '旧季独有股票')) + block());
    expect((await get()).items.map((item) => item.code)).toEqual(['600519']);
  });
  it('decodes valid escaped script strings without executing JavaScript', async () => {
    replay.em = script().replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
    expect((await get()).items[0]).toMatchObject({ code: '600519', weight: 5.26 });
  });
  it('refreshes prices while caching only the daily report and replaces the report after Shanghai midnight', async () => {
    const target = app();
    expect((await get(target)).items[0]!.quote).toMatchObject({
      price: '100.00',
      changePercent: 0,
    });
    replay.em = 'maintenance';
    replay.price = '101.00';
    expect((await get(target)).items[0]!.quote).toMatchObject({ price: '100.00' });
    replay.now = new Date('2026-11-09T06:00:10Z');
    replay.stamp = '20261109140010';
    expect((await get(target)).items[0]!.quote).toMatchObject({
      price: '101.00',
      change: '1.00',
      changePercent: 1,
    });
    replay.now = new Date('2026-11-10T06:00:00Z');
    replay.stamp = '20261110140000';
    replay.em = script(block('2026-09-30', row('300308', '中际旭创', '0.00%')));
    expect((await get(target)).items).toEqual([
      expect.objectContaining({
        code: '300308',
        weight: 0,
        quote: expect.objectContaining({ price: '101.00', tradeDate: '2026-11-10' }),
      }),
    ]);
  });
  it('returns the real recorded EastMoney list and Tencent prices at their capture time', async () => {
    replay.em = em;
    replay.realTencent = true;
    replay.now = new Date('2026-11-10T04:06:00Z');
    const target = app();
    const body = await get(target);
    expect(body.items).toHaveLength(10);
    expect(body.items[0]).toMatchObject({
      code: '300308',
      name: '中际旭创',
      weight: 5.26,
      quoteSource: 'tencent',
      quote: { price: '474.36', prevClose: '452.03', tradeDate: '2026-11-10' },
    });
    replay.now = new Date('2026-11-10T06:00:00Z');
    expect((await get(target)).items[0]).toMatchObject({ quote: null, quoteSource: null });
  });
  it.each(['hs_600519', 'sz_300308'])(
    'falls back to the real THS %s pair at capture time, and rejects the same stale pair later',
    async (symbol) => {
      replay.em = script(block('2026-09-30', row(symbol.slice(3))));
      replay.tencentDown = true;
      replay.ths = true;
      replay.now = new Date('2026-11-10T05:12:00Z');
      const target = app();
      const item = (await get(target)).items[0]!;
      expect(item).toMatchObject({
        quoteSource: 'ths',
        quoteFallback: true,
        quote: { tradeDate: '2026-11-10', price: symbol.startsWith('sz') ? '472.94' : '1442.90' },
      });
      replay.now = new Date('2026-11-10T06:00:00Z');
      expect((await get(target)).items[0]).toMatchObject({
        quote: null,
        quoteSource: null,
        quoteFallback: true,
      });
    },
  );
  it('preserves zero weight and flat price without conflating missing quotes', async () => {
    replay.em = script(block('2026-09-30', row('600519', '贵州茅台', '0.00%')));
    const target = app();
    expect((await get(target)).items[0]).toMatchObject({ weight: 0, quote: { changePercent: 0 } });
    replay.previous = '';
    replay.now = new Date('2026-11-09T06:00:10Z');
    expect((await get(target)).items[0]).toMatchObject({
      weight: 0,
      quote: null,
      quoteSource: null,
      quoteFallback: true,
    });
  });
  it.each(['00700', '800001', 'AAPL', 'A', 'BRK.B', 'BRK-B'])(
    'retains unsupported-market %s with unavailable quotes',
    async (code) => {
      replay.em = script(block('2026-09-30', row(code, '未知市场', '1.00%')));
      expect((await get()).items[0]).toMatchObject({
        code,
        name: '未知市场',
        weight: 1,
        quote: null,
        quoteSource: null,
        quoteFallback: false,
      });
    },
  );
  it.each([
    ['old intraday', '2026-11-09T06:00:00Z', '20261109093000', false],
    ['future intraday', '2026-11-09T06:00:00Z', '20261109145900', false],
    ['future seconds', '2026-11-09T06:00:00Z', '20261109140001', false],
    ['fresh intraday', '2026-11-09T06:00:00Z', '20261109135900', true],
    ['five minute boundary', '2026-11-09T06:00:00Z', '20261109135500', true],
    ['expired five minute boundary', '2026-11-09T06:00:00Z', '20261109135459', false],
    ['midday after close', '2026-11-09T08:00:00Z', '20261109110000', false],
    ['actual close', '2026-11-09T08:00:00Z', '20261109150000', true],
    ['premarket last close', '2026-11-10T00:30:00Z', '20261109150000', true],
    ['premarket midday', '2026-11-10T00:30:00Z', '20261109110000', false],
    ['Monday intraday Friday close', '2026-11-09T06:00:00Z', '20261106150000', false],
    ['weekend ancient', '2026-11-08T06:00:00Z', '20200102150000', false],
    ['weekend Friday close', '2026-11-08T06:00:00Z', '20261106150000', true],
    ['lunch morning close', '2026-11-09T04:30:00Z', '20261109113000', true],
    ['lunch stale', '2026-11-09T04:30:00Z', '20261109110000', false],
    ['lunch timestamped snapshot', '2026-11-09T04:30:00Z', '20261109120000', true],
    ['afternoon resumption', '2026-11-09T05:01:00Z', '20261109130000', true],
    ['invalid trade date', '2026-11-09T06:00:00Z', '20260230140000', false],
  ])('%s uses the correct market date and quote time', async (_name, now, stamp, available) => {
    replay.now = new Date(now);
    replay.stamp = stamp;
    const item = (await get()).items[0]!;
    if (available)
      expect(item).toMatchObject({
        quoteSource: 'tencent',
        quote: { price: '100.00', changePercent: 0 },
      });
    else expect(item).toMatchObject({ quote: null, quoteSource: null, quoteFallback: true });
  });
  it('invalidates cached quotes at opening and closing session boundaries', async () => {
    replay.now = new Date('2026-11-09T01:29:59Z');
    replay.stamp = '20261106150000';
    const target = app();
    expect((await get(target)).items[0]!.quote).toMatchObject({ tradeDate: '2026-11-06' });
    replay.now = new Date('2026-11-09T01:30:00Z');
    expect((await get(target)).items[0]!.quote).toBeNull();
    replay.now = new Date('2026-11-09T06:59:59Z');
    replay.stamp = '20261109145959';
    expect((await get(target)).items[0]!.quote).toMatchObject({ tradeDate: '2026-11-09' });
    replay.now = new Date('2026-11-09T07:00:00Z');
    expect((await get(target)).items[0]!.quote).toBeNull();
    replay.now = new Date('2026-11-09T07:00:10Z');
    replay.stamp = '20261109150000';
    expect((await get(target)).items[0]!.quote).toMatchObject({ tradeDate: '2026-11-09' });
  });
  it.each([
    ['premarket', '2026-11-10T00:30:00Z', '20261109150000', 30_000],
    ['closed', '2026-11-09T08:00:00Z', '20261109150000', 300_000],
    ['holiday', '2026-11-08T06:00:00Z', '20261106150000', 300_000],
    ['midnight', '2026-11-09T15:59:59Z', '20261109150000', 1_000],
  ])('expires %s quote caches by their TTL or date boundary', async (_name, now, stamp, ttl) => {
    replay.now = new Date(now);
    replay.stamp = stamp;
    const target = app();
    expect((await get(target)).items[0]!.quote).toMatchObject({ price: '100.00' });
    replay.price = '101.00';
    replay.now = new Date(new Date(now).getTime() + ttl - 1);
    expect((await get(target)).items[0]!.quote).toMatchObject({ price: '100.00' });
    replay.now = new Date(new Date(now).getTime() + ttl);
    expect((await get(target)).items[0]!.quote).toMatchObject({ price: '101.00' });
  });
  it('does not cache a trading quote beyond the freshness budget', async () => {
    replay.stamp = '20261109135500';
    const target = app();
    expect((await get(target)).items[0]!.quote).not.toBeNull();
    replay.now = new Date('2026-11-09T06:00:00.001Z');
    expect((await get(target)).items[0]!.quote).toBeNull();
  });
  it('retries unavailable quote results after ten seconds', async () => {
    replay.missingQuote = true;
    const target = app();
    expect((await get(target)).items[0]!.quote).toBeNull();
    replay.missingQuote = false;
    expect((await get(target)).items[0]!.quote).toBeNull();
    replay.now = new Date('2026-11-09T06:00:10Z');
    replay.stamp = '20261109140010';
    expect((await get(target)).items[0]!.quote).toMatchObject({ price: '100.00' });
  });
  it.each([false, true])(
    'preserves the new-day report after an old request completes late=%s',
    async (delayed) => {
      const started = gate(),
        release = gate();
      replay.now = new Date('2026-11-09T15:59:59Z');
      replay.stamp = '20261109150000';
      let first = true;
      const target = app({
        upstream: {
          async fetchText(request) {
            if (request.url.includes('FundArchivesDatas') && first) {
              first = false;
              const old = replay.em;
              started.open();
              if (delayed) await release.promise;
              return old;
            }
            return replay.fetchText(request);
          },
        },
      });
      const earlier = get(target);
      await started.promise;
      let oldBody: Body;
      if (!delayed) await earlier;
      try {
        replay.now = new Date('2026-11-09T16:00:01Z');
        replay.em = script(block('2026-09-30', row('300308', '次日名单')));
        expect((await get(target)).items[0]).toMatchObject({ code: '300308', name: '次日名单' });
      } finally {
        release.open();
        oldBody = await earlier;
      }
      expect(oldBody.items[0]).toMatchObject({ code: '600519', name: '贵州茅台' });
      replay.emDown = true;
      expect((await get(target)).items[0]).toMatchObject({ code: '300308', name: '次日名单' });
    },
  );
  it.each(
    [
      [
        'equal asOf',
        false,
        '100.00',
        '20261109135900',
        '101.00',
        '20261109140000',
        '2026-11-09T06:00:00.000Z',
      ],
      [
        'different asOf',
        true,
        '100.00',
        '20261109135900',
        '101.00',
        '20261109140001',
        '2026-11-09T06:00:01.000Z',
      ],
      [
        'equal snapshot time',
        false,
        '100.00',
        '20261109140000',
        '101.00',
        '20261109140000',
        '2026-11-09T06:00:00.000Z',
      ],
      [
        'first request newer snapshot',
        false,
        '101.00',
        '20261109140000',
        '100.00',
        '20261109135900',
        '2026-11-09T06:00:00.000Z',
      ],
      [
        'later asOf older snapshot',
        true,
        '101.00',
        '20261109140000',
        '100.00',
        '20261109135900',
        '2026-11-09T06:00:00.000Z',
      ],
    ].flatMap(([label, advance, aPrice, aStamp, bPrice, bStamp, expectedTime]) =>
      [true, false].map((firstFinishesLast) => ({
        label,
        advance,
        aPrice: String(aPrice),
        aStamp: String(aStamp),
        bPrice: String(bPrice),
        bStamp: String(bStamp),
        expectedTime,
        firstFinishesLast,
      })),
    ),
  )(
    'keeps the newest quote for $label, first finishes last=$firstFinishesLast',
    async ({ advance, aPrice, aStamp, bPrice, bStamp, expectedTime, firstFinishesLast }) => {
      const aStarted = gate(),
        bStarted = gate(),
        aRelease = gate(),
        bRelease = gate();
      let first = true;
      const target = app({
        upstream: {
          async fetchText(request) {
            if (request.url.includes('qt.gtimg.cn')) {
              if (first) {
                first = false;
                aStarted.open();
                await aRelease.promise;
                return qt('sh600519', aPrice, aStamp);
              }
              bStarted.open();
              await bRelease.promise;
              return qt('sh600519', bPrice, bStamp);
            }
            return replay.fetchText(request);
          },
        },
      });
      const a = get(target);
      await aStarted.promise;
      if (advance) replay.now = new Date('2026-11-09T06:00:01Z');
      const b = get(target);
      await bStarted.promise;
      try {
        if (firstFinishesLast) {
          bRelease.open();
          await b;
          aRelease.open();
        } else {
          aRelease.open();
          await a;
          bRelease.open();
        }
      } finally {
        aRelease.open();
        bRelease.open();
      }
      const [aBody, bBody] = await Promise.all([a, b]);
      expect(aBody.items[0]!.quote).toMatchObject({ price: aPrice });
      expect(bBody.items[0]!.quote).toMatchObject({ price: bPrice });
      expect((await get(target)).items[0]!.quote).toMatchObject({
        price: '101.00',
        quoteTime: expectedTime,
      });
    },
  );
  it.each([true, false])(
    'keeps newer unavailable snapshots with short TTL, first finishes last=%s',
    async (firstFinishesLast) => {
      const aStarted = gate(),
        bStarted = gate(),
        aRelease = gate(),
        bRelease = gate();
      let first = true,
        recovered = false;
      const target = app({
        upstream: {
          async fetchText(request) {
            if (request.url.includes('qt.gtimg.cn')) {
              if (first) {
                first = false;
                aStarted.open();
                await aRelease.promise;
                return qt('sh600519', '100.00', '20261109135900');
              }
              if (!recovered) {
                bStarted.open();
                await bRelease.promise;
                return 'v_sh600519="";';
              }
            }
            return replay.fetchText(request);
          },
        },
      });
      const a = get(target);
      await aStarted.promise;
      const b = get(target);
      await bStarted.promise;
      try {
        if (firstFinishesLast) {
          bRelease.open();
          await b;
          aRelease.open();
        } else {
          aRelease.open();
          await a;
          bRelease.open();
        }
      } finally {
        aRelease.open();
        bRelease.open();
      }
      const [aBody, bBody] = await Promise.all([a, b]);
      expect(aBody.items[0]!.quote).toMatchObject({ price: '100.00', changePercent: 0 });
      expect(bBody.items[0]!.quote).toBeNull();
      expect((await get(target)).items[0]!.quote).toBeNull();
      recovered = true;
      replay.now = new Date('2026-11-09T06:00:10Z');
      replay.stamp = '20261109140010';
      expect((await get(target)).items[0]!.quote).toMatchObject({
        price: '100.00',
        changePercent: 0,
      });
    },
  );
  it('keeps overlapping requests from reusing a quote from a later asOf', async () => {
    let start!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const target = app({
      upstream: {
        async fetchText(request) {
          if (request.url.includes('qt.gtimg.cn')) {
            if (first) {
              first = false;
              start();
              await delayed;
              return qt('sh600519', '100.00', '20261109140000');
            }
            return qt('sh600519', '101.00', '20261109140001');
          }
          return replay.fetchText(request);
        },
      },
    });
    const earlier = target.request(endpoint);
    await started;
    let earlierResponse: Response;
    try {
      replay.now = new Date('2026-11-09T06:00:01Z');
      expect((await get(target)).items[0]!.quote).toMatchObject({
        price: '101.00',
        quoteTime: '2026-11-09T06:00:01.000Z',
      });
    } finally {
      release();
      earlierResponse = await earlier;
    }
    expect((await get(target)).items[0]!.quote).toMatchObject({
      price: '101.00',
      quoteTime: '2026-11-09T06:00:01.000Z',
    });
    expect(earlierResponse.status).toBe(200);
    expect(((await earlierResponse.json()) as Body).items[0]!.quote).toMatchObject({
      price: '100.00',
      quoteTime: '2026-11-09T06:00:00.000Z',
    });
  });
  it('uses the injected holiday calendar to select the last market close', async () => {
    replay.now = new Date('2026-11-10T06:00:00Z');
    replay.stamp = '20261106150000';
    expect(
      (
        await get(
          app({ tradingCalendar: new ChineseTradingCalendar(['2026-11-09', '2026-11-10']) }),
        )
      ).items[0]!.quote,
    ).toMatchObject({ tradeDate: '2026-11-06' });
  });
  it.each([
    ['a slow report fetch', 'FundArchivesDatas', '20261109140010', true],
    ['a slow quote fetch', 'qt.gtimg.cn', '20261109140012', true],
    [
      'a slow quote fetch with a snapshot after the return time',
      'qt.gtimg.cn',
      '20261109140016',
      false,
    ],
  ])(
    'judges quote freshness at the return time after %s',
    async (_label, slowUrl, stamp, available) => {
      replay.em = script(block('2026-09-30', row() + row('300308', '中际旭创')));
      replay.stamp = stamp;
      const target = app({
        upstream: {
          async fetchText(request) {
            const text = await replay.fetchText(request);
            // The upstream call takes 15 seconds; Tencent snapshots are newer than request start.
            if (request.url.includes(slowUrl)) replay.now = new Date('2026-11-09T06:00:15Z');
            return text;
          },
        },
      });
      const body = await get(target);
      for (const item of body.items) {
        if (available)
          expect(item).toMatchObject({
            quote: { price: '100.00' },
            quoteSource: 'tencent',
            quoteFallback: false,
          });
        else expect(item).toMatchObject({ quote: null, quoteSource: null, quoteFallback: true });
      }
    },
  );
  it('caches a slow quote from its return time rather than the request start', async () => {
    replay.stamp = '20261109140010';
    let slow = true;
    const target = app({
      upstream: {
        async fetchText(request) {
          const text = await replay.fetchText(request);
          if (slow && request.url.includes('qt.gtimg.cn')) {
            slow = false;
            replay.now = new Date('2026-11-09T06:00:15Z');
          }
          return text;
        },
      },
    });
    expect((await get(target)).items[0]!.quote).toMatchObject({
      price: '100.00',
      quoteTime: '2026-11-09T06:00:10.000Z',
    });
    // Upstream moves on, but the quote returned at 06:00:15 keeps a ten-second TTL.
    replay.price = '102.00';
    replay.stamp = '20261109140018';
    replay.now = new Date('2026-11-09T06:00:20Z');
    expect((await get(target)).items[0]).toMatchObject({
      quoteSource: 'tencent',
      quote: { price: '100.00', quoteTime: '2026-11-09T06:00:10.000Z' },
    });
    replay.now = new Date('2026-11-09T06:00:25Z');
    expect((await get(target)).items[0]).toMatchObject({
      quoteSource: 'tencent',
      quote: { price: '102.00', quoteTime: '2026-11-09T06:00:18.000Z' },
    });
  });
  it.each([
    ['a later return', '2026-11-09T06:00:05Z'],
    ['the same return time', '2026-11-09T06:00:01Z'],
  ])(
    'keeps the later-started equal snapshot when the earlier request completes at %s',
    async (_label, lateReturn) => {
      const aStarted = gate(),
        aRelease = gate();
      let first = true;
      const target = app({
        upstream: {
          async fetchText(request) {
            if (request.url.includes('qt.gtimg.cn')) {
              if (first) {
                first = false;
                aStarted.open();
                await aRelease.promise;
                return qt('sh600519', '100.00', '20261109140000');
              }
              return qt('sh600519', '101.00', '20261109140000');
            }
            return replay.fetchText(request);
          },
        },
      });
      const a = get(target);
      await aStarted.promise;
      replay.now = new Date('2026-11-09T06:00:01Z');
      let aBody: Body;
      try {
        expect((await get(target)).items[0]!.quote).toMatchObject({ price: '101.00' });
        replay.now = new Date(lateReturn);
      } finally {
        aRelease.open();
        aBody = await a;
      }
      expect(aBody.items[0]!.quote).toMatchObject({ price: '100.00' });
      // B (started later) is still valid until 06:00:11 and must not be rolled back by A.
      expect((await get(target)).items[0]!.quote).toMatchObject({
        price: '101.00',
        quoteTime: '2026-11-09T06:00:00.000Z',
      });
    },
  );
  it.each([
    ['before', '2026-11-09T15:59:59Z', ['2026-11-09', '2026-11-09']],
    ['after', '2026-11-10T02:00:00Z', [undefined, undefined]],
  ])(
    'judges one Tencent batch at one sample time when it returns %s Shanghai midnight',
    async (_label, returnedAt, tradeDates) => {
      replay.em = script(block('2026-09-30', row() + row('300308', '中际旭创')));
      replay.stamp = '20261109150000';
      replay.now = new Date('2026-11-09T15:59:58Z');
      const body = await get(
        app({
          upstream: {
            async fetchText(request) {
              const text = await replay.fetchText(request);
              if (request.url.includes('qt.gtimg.cn')) replay.now = new Date(returnedAt);
              return text;
            },
          },
        }),
      );
      expect(body.items.map((item) => item.quote?.tradeDate)).toEqual(tradeDates);
    },
  );
  it.each([
    ['maintenance HTML', '<html><h1>maintenance</h1>' + block() + '</html>'],
    ['invalid date', script(block('2026-99-99'))],
    ['invalid leap day', script(block('2026-02-29'))],
    ['missing date', script(block(''))],
    ['negative weight', script(block('2026-09-30', row('600519', '贵州茅台', '-99%')))],
    ['excessive weight', script(block('2026-09-30', row('600519', '贵州茅台', '101%')))],
    ['missing weight', script(block('2026-09-30', row('600519', '贵州茅台', '')))],
    ['missing code', script(block('2026-09-30', row('', '贵州茅台')))],
    ['invalid code punctuation', script(block('2026-09-30', row('PE@P')))],
    ['blank code', script(block('2026-09-30', row(' ')))],
    ['punctuation-only code', script(block('2026-09-30', row('.')))],
    ['fabricated zero code', script(block('2026-09-30', row('000000')))],
    ['invalid columns', script(block().replace('股票代码', '债券代码'))],
  ])('rejects %s without poisoning the report cache', async (_name, invalid) => {
    replay.em = invalid;
    const target = app();
    const failed = await target.request(endpoint);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({
      error: { code: 'upstream_unavailable', message: '行情上游暂不可用' },
    });
    replay.em = script();
    expect((await get(target)).items[0]).toMatchObject({ code: '600519', weight: 5.26 });
  });
  it('uses the Sina backup when the primary report has missing allocation', async () => {
    replay.em = script(block('2026-09-30', row('600519', '贵州茅台', '')));
    replay.sinaDown = false;
    expect((await get()).items).toHaveLength(10);
  });
  it.each([
    [
      'nonzero API status',
      JSON.stringify({
        result: { status: { code: 1 }, data: { heavy_stock: [{ SYMBOL: '600519' }] } },
      }),
    ],
    ['five-row API', fixture('sina/holdings-000001-success.json')],
    ['empty API', fixture('sina/holdings-000001.json')],
    ['unrelated HTML', '<html>' + block() + '</html>'],
    ['incomplete code list', sina.replace('sz300308,sh688361', 'sh688361')],
    ['invalid date', sina.replace('2026-09-30', '2026-99-99')],
    ['missing allocation', sina.replace('<td>5.26%</td>', '<td>--</td>')],
  ])('rejects Sina %s as an unavailable upstream', async (_name, invalid) => {
    replay.emDown = true;
    replay.sinaDown = false;
    replay.sina = invalid;
    const response = await app().request(endpoint);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('diagnostic');
  });
  it('logs both upstream diagnostics while returning a uniform public error', async () => {
    replay.emDown = true;
    const response = await app().request(endpoint);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { code: 'upstream_unavailable', message: '行情上游暂不可用' },
    });
    expect(console.warn).toHaveBeenCalledWith(
      '[bafang-core] eastmoney holdings failed',
      'timeout',
      'EM diagnostic proof',
    );
    expect(console.warn).toHaveBeenCalledWith(
      '[bafang-core] sina holdings failed',
      'timeout',
      'Sina diagnostic proof',
    );
  });
  it('returns 404 for the real successful empty F10 report', async () => {
    replay.em = fixture('eastmoney/holdings-000009-empty.txt');
    const response = await app().request('/v1/funds/000009/holdings');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: 'fund_not_found', message: '没有有效的基金季报' },
    });
  });
  it('documents and returns 400 for illegal fund codes', async () => {
    const target = app();
    const invalid = await target.request('/v1/funds/not-a-code/holdings');
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: 'validation_error' } });
    const doc = (await (await target.request('/v1/openapi')).json()) as {
      paths: Record<string, { get: { responses: Record<string, unknown> } }>;
    };
    expect(Object.keys(doc.paths['/v1/funds/{code}/holdings']!.get.responses)).toEqual(
      expect.arrayContaining(['200', '400', '404', '429', '502']),
    );
  });
  it('allows anonymous reads and limits the 61st request with Retry-After', async () => {
    const target = app();
    for (let i = 0; i < 60; i++) expect((await target.request(endpoint)).status).toBe(200);
    const limited = await target.request(endpoint);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    expect(await limited.json()).toMatchObject({ error: { code: 'rate_limited' } });
  });
});
