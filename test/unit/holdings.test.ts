import { describe, expect, it } from 'vitest';
import { createHoldingsService, parse } from '../../src/market/holdings';
import { UpstreamError, type UpstreamFetcher } from '../../src/market/upstream';

const now = new Date('2026-11-09T06:00:00Z');
const em = `var apidata={ content:"<h4>截止至：<font>2026-09-30</font></h4><table><tr><td>1</td><td>600519</td><td>贵州茅台</td><td>0.00%</td></tr><tr><td>2</td><td>300308</td><td>中际旭创</td><td>5.26%</td></tr></table>"}`;
const sina = JSON.stringify({ result: { status: { code: 0 }, data: [] } });
const quote = (symbol: string) =>
  `v_${symbol}="x~x~x~100.00~99.00~x~x~x~x~x~x~x~x~x~x~x~x~x~x~x~x~x~x~x~x~x~20261109100000~x";`;

class Fake implements UpstreamFetcher {
  constructor(
    private emBody = em,
    private failEm = false,
  ) {}
  calls = 0;
  async fetchText({ url }: { url: string }): Promise<string> {
    this.calls++;
    if (url.includes('FundArchivesDatas')) {
      if (this.failEm) throw new UpstreamError('timeout', 'down');
      return this.emBody;
    }
    if (url.includes('FdFundService')) return sina;
    if (url.includes('qt.gtimg.cn'))
      return quote('sh600519') + quote('sz300308') + quote('sz000001');
    if (url.includes('d.10jqka.com.cn')) throw new UpstreamError('timeout', 'down');
    throw new Error(`unexpected ${url}`);
  }
}

describe('fund holdings parsing and fallback', () => {
  it('parses EastMoney HTML with report date and zero weight', () => {
    const result = parse(em);
    expect(result?.reportDate).toBe('2026-09-30');
    expect(result?.items).toEqual(
      expect.arrayContaining([
        { name: '贵州茅台', code: '600519', weight: 0, reportDate: '2026-09-30' },
      ]),
    );
  });
  it('does not invent holdings when Sina returns no proven stock rows', async () => {
    const upstream = new Fake('', true);
    const service = createHoldingsService({ upstream, clock: { now: () => now } });
    await expect(service.get('000001')).rejects.toMatchObject({ kind: 'bad_response' });
    expect(upstream.calls).toBe(2);
  });
});
