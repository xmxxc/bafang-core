import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../../src/app';
import { createHealthProbe } from '../../src/db';
import type { ErrorResponse } from '../../src/errors';
import { UpstreamError } from '../../src/market/upstream';
import type { FundDetailResponse, FundSearchResponse } from '../../src/routes/funds';
import {
  eastmoneySamples,
  RecordedUpstream,
  sample,
  upstreamDown,
  type Replay,
} from '../support/recorded-upstream';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';

/** 可推进的时钟替身。 */
function movableClock(iso: string) {
  let now = new Date(iso);
  return {
    now: () => now,
    set: (next: string) => {
      now = new Date(next);
    },
  };
}

/** 去掉基础信息样本里的 T+N 字段，模拟上游字段缺失。 */
function withoutConfirmDays(file: string): string {
  const body = JSON.parse(sample(file)) as { Datas: Record<string, unknown> };
  delete body.Datas.SSBCFMDATA;
  return JSON.stringify(body);
}

/** 上游业务错误：把录制样本的 ErrCode 改成非零；可同时清空 Datas。 */
function withErrCode(file: string, errCode: number, datas?: null): string {
  const body = JSON.parse(sample(file)) as Record<string, unknown>;
  body.ErrCode = errCode;
  body.ErrMsg = 'recorded upstream error';
  if (datas === null) body.Datas = null;
  return JSON.stringify(body);
}

describe('fund search and basic info over in-process HTTP against a real PostgreSQL test database', () => {
  let db: TestSchema;
  let upstream: RecordedUpstream;
  let clock: ReturnType<typeof movableClock>;

  function app(deps: AppDeps = {}) {
    return createApp({ db: createHealthProbe(db.pool), upstream, clock, ...deps });
  }

  beforeEach(async () => {
    db = await createTestSchema();
    upstream = new RecordedUpstream(eastmoneySamples);
    // 2026-11-06 10:00 Asia/Shanghai
    clock = movableClock('2026-11-06T02:00:00.000Z');
  });

  afterEach(async () => {
    await dropTestSchema(db);
  });

  async function search(target: ReturnType<typeof app>, q: string, ip = '203.0.113.1') {
    return target.request(`/v1/funds/search?q=${encodeURIComponent(q)}`, {
      headers: { 'X-Forwarded-For': ip },
    });
  }

  describe('GET /v1/funds/search', () => {
    it('finds a fund by code and leaves out stocks and indices sharing the code', async () => {
      const res = await search(app(), '000001');
      expect(res.status).toBe(200);
      const body = (await res.json()) as FundSearchResponse;
      expect(body.items).toEqual([
        { code: '000001', name: '华夏成长混合', category: 'domestic', type: '混合型-灵活' },
      ]);
    });

    it('finds funds by name', async () => {
      const res = await search(app(), '华夏成长');
      expect(res.status).toBe(200);
      const body = (await res.json()) as FundSearchResponse;
      expect(body.items.length).toBeGreaterThan(1);
      expect(body.items[0]).toMatchObject({ code: '000001', name: '华夏成长混合' });
      for (const item of body.items) {
        expect(item.code).toMatch(/^\d{6}$/);
        expect(item.name).toContain('华夏成长');
      }
    });

    it('finds funds by pinyin initials, case-insensitively and ignoring surrounding spaces', async () => {
      const res = await search(app(), '  HXCZ ');
      expect(res.status).toBe(200);
      const body = (await res.json()) as FundSearchResponse;
      expect(body.items.map((item) => item.code)).toContain('000001');
    });

    it('returns an empty list when the upstream only matches stocks', async () => {
      const res = await search(app(), 'zzzzqqqxx');
      expect(res.status).toBe(200);
      expect(((await res.json()) as FundSearchResponse).items).toEqual([]);
    });

    it('returns an empty list when the upstream returns no data', async () => {
      const res = await search(app(), '~~');
      expect(res.status).toBe(200);
      expect(((await res.json()) as FundSearchResponse).items).toEqual([]);
    });

    it('rejects a blank keyword with the unified validation error', async () => {
      const res = await search(app(), '   ');
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorResponse).error.code).toBe('validation_error');
    });

    it.each<[string, Replay]>([
      ['timeout', upstreamDown()],
      ['HTTP 503', upstreamDown(new UpstreamError('http_status', 'recorded 503', 503))],
      ['empty body', upstreamDown(new UpstreamError('empty_body', 'recorded empty body'))],
      ['non-JSON body', () => '<html>502 Bad Gateway</html>'],
      ['unexpected shape', () => '{"ErrCode":0,"Datas":{"unexpected":true}}'],
      [
        'non-zero ErrCode without Datas',
        () => withErrCode('eastmoney/search-000001.json', -1, null),
      ],
      ['non-zero ErrCode with Datas', () => withErrCode('eastmoney/search-000001.json', 1)],
    ])('returns upstream_unavailable (502) when the upstream fails: %s', async (_name, replay) => {
      upstream.use(replay);
      const res = await search(app(), '000001');
      expect(res.status).toBe(502);
      const body = (await res.json()) as ErrorResponse;
      expect(body.error.code).toBe('upstream_unavailable');
      expect(body.error.message).not.toContain('recorded');
    });

    it('serves the second search of the same day from cache even when the upstream is down', async () => {
      const target = app();
      const first = await search(target, '000001');
      expect(first.status).toBe(200);
      const firstBody = await first.json();

      upstream.use(upstreamDown());
      clock.set('2026-11-06T15:59:59.000Z'); // 23:59:59 Asia/Shanghai, same day
      const second = await search(target, ' 000001 ');
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual(firstBody);
    });

    it('caches empty results for the day as well', async () => {
      const target = app();
      expect((await search(target, '~~')).status).toBe(200);
      upstream.use(upstreamDown());
      const second = await search(target, '~~');
      expect(second.status).toBe(200);
      expect(((await second.json()) as FundSearchResponse).items).toEqual([]);
    });

    it('expires the cache at midnight Asia/Shanghai, not midnight UTC', async () => {
      const target = app();
      // 2026-11-06 07:30 Asia/Shanghai = 2026-11-05 23:30 UTC
      clock.set('2026-11-05T23:30:00.000Z');
      expect((await search(target, '000001')).status).toBe(200);

      upstream.use(upstreamDown());
      // UTC date rolled over (2026-11-06 00:30 UTC) but it is still 2026-11-06 in Shanghai
      clock.set('2026-11-06T00:30:00.000Z');
      expect((await search(target, '000001')).status).toBe(200);

      // 2026-11-07 00:00 Asia/Shanghai: a new day, the upstream is asked again and is down
      clock.set('2026-11-06T16:00:00.000Z');
      const nextDay = await search(target, '000001');
      expect(nextDay.status).toBe(502);
      expect(((await nextDay.json()) as ErrorResponse).error.code).toBe('upstream_unavailable');
    });

    it('does not cache upstream failures', async () => {
      const target = app();
      upstream.use(upstreamDown());
      expect((await search(target, '000001')).status).toBe(502);
      upstream.use(eastmoneySamples);
      expect((await search(target, '000001')).status).toBe(200);
    });

    it('does not cache an upstream business error that carries Datas, and recovers once the upstream does', async () => {
      const target = app();
      upstream.use(() => withErrCode('eastmoney/search-000001.json', 1));
      expect((await search(target, '000001')).status).toBe(502);

      upstream.use(eastmoneySamples);
      const recovered = await search(target, '000001');
      expect(recovered.status).toBe(200);
      const recoveredBody = await recovered.json();
      expect((recoveredBody as FundSearchResponse).items).toEqual([
        { code: '000001', name: '华夏成长混合', category: 'domestic', type: '混合型-灵活' },
      ]);

      // the recovered result is what got cached
      upstream.use(upstreamDown());
      const cached = await search(target, '000001');
      expect(cached.status).toBe(200);
      expect(await cached.json()).toEqual(recoveredBody);
    });
  });

  describe('GET /v1/funds/{code}', () => {
    async function detail(target: ReturnType<typeof app>, code: string) {
      return target.request(`/v1/funds/${code}`, { headers: { 'X-Forwarded-For': '203.0.113.1' } });
    }

    it('returns a domestic fund with the upstream T+N', async () => {
      const res = await detail(app(), '000001');
      expect(res.status).toBe(200);
      expect((await res.json()) as FundDetailResponse).toEqual({
        code: '000001',
        name: '华夏成长混合',
        category: 'domestic',
        type: '混合型-灵活',
        settlement: { tPlusN: 1, source: 'upstream' },
      });
    });

    it('classifies a QDII ETF feeder as QDII with the upstream T+2', async () => {
      const res = await detail(app(), '040046');
      expect(res.status).toBe(200);
      expect((await res.json()) as FundDetailResponse).toMatchObject({
        code: '040046',
        category: 'qdii',
        settlement: { tPlusN: 2, source: 'upstream' },
      });
    });

    it('classifies a domestic ETF feeder', async () => {
      const res = await detail(app(), '110020');
      expect(res.status).toBe(200);
      expect((await res.json()) as FundDetailResponse).toMatchObject({
        code: '110020',
        name: '易方达沪深300ETF联接A',
        category: 'etf_feeder',
        settlement: { tPlusN: 1, source: 'upstream' },
      });
    });

    it.each([
      ['000001', 'domestic', 1],
      ['110020', 'etf_feeder', 1],
      ['040046', 'qdii', 2],
    ] as const)(
      'falls back to the category default when the upstream T+N is missing: %s → %s T+%i',
      async (code, category, tPlusN) => {
        upstream.use((url) =>
          withoutConfirmDays(`eastmoney/base-${url.searchParams.get('FCODE')}.json`),
        );
        const res = await detail(app(), code);
        expect(res.status).toBe(200);
        expect((await res.json()) as FundDetailResponse).toMatchObject({
          code,
          category,
          settlement: { tPlusN, source: 'category_default' },
        });
      },
    );

    it('returns fund_not_found (404) when the upstream has no such fund', async () => {
      const res = await detail(app(), '999999');
      expect(res.status).toBe(404);
      expect(((await res.json()) as ErrorResponse).error.code).toBe('fund_not_found');
    });

    it('rejects a malformed code with the unified validation error', async () => {
      const res = await detail(app(), '12345x');
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorResponse).error.code).toBe('validation_error');
    });

    it('returns upstream_unavailable (502) when the upstream fails', async () => {
      upstream.use(upstreamDown(new UpstreamError('network', 'recorded connection reset')));
      const res = await detail(app(), '000001');
      expect(res.status).toBe(502);
      expect(((await res.json()) as ErrorResponse).error.code).toBe('upstream_unavailable');
    });

    it.each<[string, string]>([
      ['without Datas', withErrCode('eastmoney/base-000001.json', -1, null)],
      ['with Datas', withErrCode('eastmoney/base-000001.json', 1)],
    ])(
      'returns upstream_unavailable (502), not fund_not_found, on a non-zero upstream ErrCode %s',
      async (_name, body) => {
        upstream.use(() => body);
        const res = await detail(app(), '000001');
        expect(res.status).toBe(502);
        const error = ((await res.json()) as ErrorResponse).error;
        expect(error.code).toBe('upstream_unavailable');
        expect(error.message).not.toContain('recorded');
      },
    );
  });

  describe('anonymous access and rate limiting', () => {
    it('serves market reads without any credentials', async () => {
      const res = await app().request('/v1/funds/000001');
      expect(res.status).toBe(200);
    });

    it('limits each client to 60 market reads per minute and resets in the next window', async () => {
      const target = app();
      for (let i = 0; i < 60; i++) {
        const res = await search(target, '000001', '198.51.100.7');
        expect(res.status).toBe(200);
      }
      const limited = await target.request('/v1/funds/000001', {
        headers: { 'X-Forwarded-For': '198.51.100.7' },
      });
      expect(limited.status).toBe(429);
      expect(((await limited.json()) as ErrorResponse).error.code).toBe('rate_limited');
      expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);

      // another client is unaffected
      expect((await search(target, '000001', '198.51.100.8')).status).toBe(200);

      // a client cannot escape the limit by prepending a forged address
      const forged = await search(target, '000001', '10.0.0.1, 198.51.100.7');
      expect(forged.status).toBe(429);

      clock.set('2026-11-06T02:01:00.000Z');
      expect((await search(target, '000001', '198.51.100.7')).status).toBe(200);
    });

    it('does not rate limit the health check', async () => {
      const target = app();
      for (let i = 0; i < 61; i++) {
        await search(target, '000001', '198.51.100.9');
      }
      const res = await target.request('/v1/health', {
        headers: { 'X-Forwarded-For': '198.51.100.9' },
      });
      expect(res.status).toBe(200);
    });
  });
});
