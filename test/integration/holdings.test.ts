import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createApp } from '../../src/app';
import { UpstreamError, type UpstreamFetcher } from '../../src/market/upstream';

const clock = { now: () => new Date('2026-11-10T06:00:00Z') };
const FIXTURES = path.resolve('test/fixtures/upstream');
const eastmoney = readFileSync(path.join(FIXTURES, 'eastmoney/holdings-000001.json'), 'utf8');
const tencent = readFileSync(path.join(FIXTURES, 'tencent/holdings-000001.txt'), 'utf8');
class Replay implements UpstreamFetcher {
  calls = 0;
  constructor(private readonly downEastmoney = false) {}
  async fetchText({ url }: { url: string }): Promise<string> {
    this.calls++;
    if (url.includes('FundArchivesDatas')) {
      if (this.downEastmoney) throw new UpstreamError('timeout', 'recorded');
      return eastmoney;
    }
    if (url.includes('qt.gtimg.cn'))
      return this.calls > 2 ? tencent.replace('1800.00', '1801.00') : tencent;
    if (url.includes('FdFundService'))
      return JSON.stringify({ result: { status: { code: 0 }, data: [] } });
    throw new UpstreamError('timeout', 'recorded');
  }
}

describe('GET /v1/funds/{code}/holdings', () => {
  it('returns report holdings and same-day cached quotes', async () => {
    const upstream = new Replay();
    const app = createApp({ upstream, clock });
    const first = await app.request('/v1/funds/000001/holdings');
    const second = await app.request('/v1/funds/000001/holdings');
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      reportDate: string;
      items: Array<{ code: string; name: string; weight: number; quoteSource: string }>;
    };
    expect(firstBody.reportDate).toBe('2026-09-30');
    expect(
      firstBody.items.some(
        (item: { code: string; name: string; weight: number; quoteSource: string }) =>
          item.code === '300308' &&
          item.name === '中际旭创' &&
          item.weight === 5.26 &&
          item.quoteSource === 'tencent',
      ),
    ).toBe(true);
    const secondBody = (await second.json()) as { items: Array<{ quoteSource: string }> };
    expect(
      secondBody.items.some((item: { quoteSource: string }) => item.quoteSource === 'tencent'),
    ).toBe(true);
    expect(upstream.calls).toBe(35);
  });

  it('returns upstream unavailable when EastMoney fails and Sina has no proven stock rows', async () => {
    const app = createApp({ upstream: new Replay(true), clock });
    const response = await app.request('/v1/funds/000001/holdings');
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'upstream_unavailable' } });
  });
});
