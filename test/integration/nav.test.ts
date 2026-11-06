import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../../src/app';
import { createHealthProbe } from '../../src/db';
import type { ErrorResponse } from '../../src/errors';
import { UpstreamError } from '../../src/market/upstream';
import type { LatestNavResponse, NavHistoryResponse } from '../../src/routes/nav';
import {
  eastmoneySamples,
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

describe('fund NAV over in-process HTTP against a real PostgreSQL test database', () => {
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

  describe('GET /v1/funds/{code}/nav', () => {
    it('returns unit NAV, NAV date and daily change for the latest published NAV', async () => {
      const res = await app().request('/v1/funds/000001/nav');
      expect(res.status).toBe(200);
      expect((await res.json()) as LatestNavResponse).toEqual({
        navDate: '2026-11-05',
        unitNav: '1.0000',
        cumulativeNav: '3.5730',
        dailyChange: 1.83,
      });
    });

    it('returns fund_not_found (404) when the fund has no NAV data', async () => {
      const res = await app().request('/v1/funds/999999/nav');
      expect(res.status).toBe(404);
      expect(((await res.json()) as ErrorResponse).error.code).toBe('fund_not_found');
    });

    it('returns upstream_unavailable (502) when the upstream fails', async () => {
      upstream.use(upstreamDown(new UpstreamError('network', 'recorded reset')));
      const res = await app().request('/v1/funds/000001/nav');
      expect(res.status).toBe(502);
      expect(((await res.json()) as ErrorResponse).error.code).toBe('upstream_unavailable');
    });

    it.each<[string, Replay]>([
      ['non-zero ErrCode', () => withErrCode('eastmoney/nav-000001-latest.json', 1)],
      ['unexpected shape', () => '{"ErrCode":0,"Data":"nope"}'],
      ['non-JSON body', () => '<html>502</html>'],
    ])('returns upstream_unavailable (502) on %s', async (_name, replay) => {
      upstream.use(replay);
      const res = await app().request('/v1/funds/000001/nav');
      expect(res.status).toBe(502);
      expect(((await res.json()) as ErrorResponse).error.code).toBe('upstream_unavailable');
    });

    it('caches the latest NAV within the publication window and re-fetches once it opens', async () => {
      const target = app();
      const first = await target.request('/v1/funds/000001/nav');
      expect(first.status).toBe(200);
      const firstBody = await first.json();

      upstream.use(upstreamDown());
      // 12:00 Asia/Shanghai, still before the 19:00 publication window → cache hit
      clock.set('2026-11-06T04:00:00.000Z');
      const second = await target.request('/v1/funds/000001/nav');
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual(firstBody);

      // 20:00 Asia/Shanghai, a new publication window → upstream is asked again and is down
      clock.set('2026-11-06T12:00:00.000Z');
      const third = await target.request('/v1/funds/000001/nav');
      expect(third.status).toBe(502);
      expect(((await third.json()) as ErrorResponse).error.code).toBe('upstream_unavailable');
    });
  });

  describe('GET /v1/funds/{code}/nav/history', () => {
    async function history(target: ReturnType<typeof app>, code: string, range: string) {
      return target.request(`/v1/funds/${code}/nav/history?range=${range}`);
    }

    it('returns the 1-month series newest-first, within the range', async () => {
      const res = await history(app(), '000001', '1m');
      expect(res.status).toBe(200);
      const body = (await res.json()) as NavHistoryResponse;
      expect(body.points).toHaveLength(21);
      expect(body.points[0]).toEqual({
        date: '2026-11-05',
        unitNav: '1.0000',
        cumulativeNav: '3.5730',
        dailyChange: 1.83,
      });
      expect(body.points.at(-1)?.date).toBe('2026-10-08');
      for (const point of body.points) {
        expect(point.date >= '2026-10-06').toBe(true);
        expect(point.unitNav).toMatch(/^\d+(\.\d{1,4})?$/);
        expect(typeof point.dailyChange).toBe('number');
      }
    });

    it('returns progressively wider series for 1m, 3m and 1y', async () => {
      const target = app();
      const oneMonth = (await (await history(target, '000001', '1m')).json()) as NavHistoryResponse;
      const threeMonths = (await (
        await history(target, '000001', '3m')
      ).json()) as NavHistoryResponse;
      const oneYear = (await (await history(target, '000001', '1y')).json()) as NavHistoryResponse;

      expect(oneMonth.points).toHaveLength(21);
      expect(threeMonths.points).toHaveLength(60);
      expect(oneYear.points).toHaveLength(242);

      expect(threeMonths.points.at(-1)?.date).toBe('2026-08-06');
      expect(oneYear.points.at(-1)?.date).toBe('2025-11-06');
    });

    it('rejects an unknown range with the unified validation error', async () => {
      const res = await history(app(), '000001', '6m');
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorResponse).error.code).toBe('validation_error');
    });

    it('returns fund_not_found (404) when the fund has no NAV data', async () => {
      const res = await history(app(), '999999', '1m');
      expect(res.status).toBe(404);
      expect(((await res.json()) as ErrorResponse).error.code).toBe('fund_not_found');
    });

    it('returns upstream_unavailable (502) when the upstream fails', async () => {
      upstream.use(upstreamDown());
      const res = await history(app(), '000001', '1m');
      expect(res.status).toBe(502);
      expect(((await res.json()) as ErrorResponse).error.code).toBe('upstream_unavailable');
    });
  });

  describe('anonymous access', () => {
    it('serves NAV reads without credentials', async () => {
      const res = await app().request('/v1/funds/000001/nav');
      expect(res.status).toBe(200);
    });
  });
});

function withErrCode(file: string, errCode: number): string {
  const body = JSON.parse(sample(file)) as Record<string, unknown>;
  body.ErrCode = errCode;
  return JSON.stringify(body);
}
