import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { createHealthProbe } from '../../src/db';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';
import {
  HttpUpstreamFetcher,
  UpstreamError,
  type UpstreamFetcher,
  type UpstreamRequest,
} from '../../src/market/upstream';

// Synthetic protocol-shaped report and quote; the subject is the deadline, not parsing.
const report = `var apidata={ content:${JSON.stringify(
  '<h4>截止至：<font>2026-09-30</font></h4><table><thead><tr><th>股票代码</th><th>股票名称</th><th>占净值比例</th></tr></thead><tbody><tr><td>1</td><td>600519</td><td>贵州茅台</td><td>--</td><td>--</td><td>行情</td><td>5.26%</td></tr></tbody></table>',
)},arryear:[2026],curyear:2026};`;
function quote() {
  const fields = Array<string>(31).fill('');
  fields[3] = '101.00';
  fields[4] = '100.00';
  fields[30] = '20261109140000';
  return `v_sh600519="${fields.join('~')}";`;
}
const DEADLINE_MS = 300;
// Generous margin for a loaded CI machine; an unbounded request never settles at all.
const BOUND_MS = DEADLINE_MS + 2000;
const never = new Promise<string>(() => {});

/** Upstream double whose selected hosts never settle and ignore any abort. */
class Hanging implements UpstreamFetcher {
  hang: (url: string) => boolean = () => true;
  async fetchText({ url }: UpstreamRequest): Promise<string> {
    if (this.hang(url)) return never;
    if (url.includes('FundArchivesDatas')) return report;
    if (url.includes('qt.gtimg.cn')) return quote();
    throw new Error(`unexpected ${url}`);
  }
}

describe('fund holdings request deadline over HTTP with an isolated PostgreSQL schema', () => {
  let db: TestSchema;
  let upstream: Hanging;
  let now: Date;
  beforeEach(async () => {
    db = await createTestSchema();
    upstream = new Hanging();
    now = new Date('2026-11-09T06:00:00Z');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await dropTestSchema(db);
  });
  const app = (fetcher: UpstreamFetcher = upstream) =>
    createApp({
      db: createHealthProbe(db.pool),
      upstream: fetcher,
      clock: { now: () => now },
      holdingsDeadlineMs: DEADLINE_MS,
    });
  async function bounded(target: ReturnType<typeof app>) {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        target.request('/v1/funds/000001/holdings'),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('HTTP request still pending')), BOUND_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  it.each(['before headers', 'reading body'])(
    'retries a stalled HTTP attempt (%s) even if the transport ignores abort',
    async (stage) => {
      const stalled = new Response();
      vi.spyOn(stalled, 'arrayBuffer').mockImplementation(() => new Promise(() => {}));
      const transport = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('unexpected upstream call'))
        .mockImplementationOnce(() =>
          stage === 'before headers' ? new Promise(() => {}) : Promise.resolve(stalled),
        )
        .mockResolvedValueOnce(new Response(report))
        .mockResolvedValueOnce(new Response(quote()));
      const adapter = new HttpUpstreamFetcher({ timeoutMs: 30, retries: 1, retryDelayMs: 0 });
      const response = await bounded(app(adapter));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        items: [{ code: '600519', quote: { price: '101.00' } }],
      });
      expect(transport.mock.calls[0]![1]?.signal?.aborted).toBe(true);
      expect(transport.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual([
        'fundf10.eastmoney.com',
        'fundf10.eastmoney.com',
        'qt.gtimg.cn',
      ]);
    },
  );

  it('returns 502 within the deadline when the report upstreams never settle, then recovers', async () => {
    const target = app();
    const started = performance.now();
    const response = await bounded(target);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { code: 'upstream_unavailable', message: '行情上游暂不可用' },
    });
    expect(performance.now() - started).toBeGreaterThanOrEqual(DEADLINE_MS - 50);

    upstream.hang = () => false;
    const recovered = await bounded(target);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      items: [{ code: '600519', quoteSource: 'tencent', quote: { price: '101.00' } }],
    });
  });

  it('gives the fallback only the remaining portion of the request deadline', async () => {
    const target = app();
    const fetch = vi.spyOn(upstream, 'fetchText').mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      throw new UpstreamError('network', 'primary unavailable');
    });
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
    try {
      const completed = vi.fn();
      const request = bounded(target).then(completed);
      await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
      expect(fetch.mock.calls.map(([{ url }]) => new URL(url).hostname)).toEqual([
        'fundf10.eastmoney.com',
        'finance.sina.com.cn',
      ]);
      expect(completed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(completed).toHaveBeenCalledWith(expect.objectContaining({ status: 502 }));
      await request;
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns unavailable quotes within the deadline when every quote upstream never settles, then recovers', async () => {
    upstream.hang = (url) => !url.includes('FundArchivesDatas');
    const target = app();
    const result = await bounded(target);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      holdingsSource: 'eastmoney',
      items: [{ code: '600519', quote: null, quoteSource: null, quoteFallback: true }],
    });

    // The unavailable result keeps its ten-second cache; the next sample recovers.
    upstream.hang = () => false;
    now = new Date('2026-11-09T06:00:10Z');
    const recovered = await bounded(target);
    expect(await recovered.json()).toMatchObject({
      items: [{ code: '600519', quoteSource: 'tencent', quote: { price: '101.00' } }],
    });
  });

  it('shares one pending report, bounds both callers and fetches again after timeout', async () => {
    const fetch = vi.spyOn(upstream, 'fetchText');
    const target = app();
    const responses = await Promise.all([bounded(target), bounded(target)]);
    for (const response of responses) {
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ error: { code: 'upstream_unavailable' } });
    }
    const reports = () =>
      fetch.mock.calls.filter(([request]) => request.url.includes('FundArchivesDatas'));
    expect(reports()).toHaveLength(1);
    upstream.hang = () => false;
    const recovered = await bounded(target);
    expect(recovered.status).toBe(200);
    expect(reports()).toHaveLength(2);
  });
});
