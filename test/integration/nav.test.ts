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

    it("re-fetches within the publish window until today's NAV is published, then caches it", async () => {
      const target = app();
      // 19:01 Asia/Shanghai — the publish window has just opened but the upstream still serves
      // yesterday's NAV, so the stale value must not be cached for the whole window.
      clock.set('2026-11-06T11:01:00.000Z');
      const first = await target.request('/v1/funds/000001/nav');
      expect(first.status).toBe(200);
      expect(((await first.json()) as LatestNavResponse).navDate).toBe('2026-11-05');

      // Still inside the short poll interval → cached stale value, upstream not asked again.
      upstream.use(upstreamDown());
      clock.set('2026-11-06T11:03:00.000Z');
      const second = await target.request('/v1/funds/000001/nav');
      expect(second.status).toBe(200);
      expect(((await second.json()) as LatestNavResponse).navDate).toBe('2026-11-05');

      // Past the poll interval, the upstream has now published today's NAV.
      upstream.use(() => sample('eastmoney/nav-000001-latest-2026-11-06.json'));
      clock.set('2026-11-06T12:00:00.000Z');
      const third = await target.request('/v1/funds/000001/nav');
      expect(third.status).toBe(200);
      expect(((await third.json()) as LatestNavResponse).navDate).toBe('2026-11-06');

      // Today's NAV is now stable for the rest of the window.
      upstream.use(upstreamDown());
      const fourth = await target.request('/v1/funds/000001/nav');
      expect(fourth.status).toBe(200);
      expect(((await fourth.json()) as LatestNavResponse).navDate).toBe('2026-11-06');
    });

    it("keeps the previous day's cached NAV across the midnight hour", async () => {
      const target = app();
      // 2026-11-05 20:00 Asia/Shanghai — within the window, today's (11-05) NAV is cached.
      clock.set('2026-11-05T12:00:00.000Z');
      const first = await target.request('/v1/funds/000001/nav');
      expect(first.status).toBe(200);
      const firstBody = await first.json();

      upstream.use(upstreamDown());
      // 2026-11-06 00:30 Asia/Shanghai — the hour after midnight must still hit the previous
      // publish day's cache (before the fix 00:30 was misread as 24:30 and rolled the key forward).
      clock.set('2026-11-05T16:30:00.000Z');
      const second = await target.request('/v1/funds/000001/nav');
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual(firstBody);
    });

    it.each<[string, string | undefined]>([
      ['missing', undefined],
      ['a placeholder', '--'],
      ['an empty string', ''],
      ['non-numeric text', 'not-a-number'],
    ])('returns a null dailyChange when the upstream change is %s', async (_name, value) => {
      upstream.use(() => latestNavWithChange('eastmoney/nav-000001-latest.json', value));
      const res = await app().request('/v1/funds/000001/nav');
      expect(res.status).toBe(200);
      expect(((await res.json()) as LatestNavResponse).dailyChange).toBeNull();
    });

    it('still returns a real zero dailyChange when the upstream reports 0', async () => {
      upstream.use(() => latestNavWithChange('eastmoney/nav-000001-latest.json', '0.00'));
      const res = await app().request('/v1/funds/000001/nav');
      expect(res.status).toBe(200);
      expect(((await res.json()) as LatestNavResponse).dailyChange).toBe(0);
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

/** 修改最新净值样本里的当日涨跌幅字段：删除它，或替换为给定值。 */
function latestNavWithChange(file: string, value: string | undefined): string {
  const body = JSON.parse(sample(file)) as {
    Data: { LSJZList: Record<string, unknown>[] };
  };
  const item = body.Data.LSJZList[0]!;
  if (value === undefined) delete item.JZZZL;
  else item.JZZZL = value;
  return JSON.stringify(body);
}
