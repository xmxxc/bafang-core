import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App, type AppDeps } from '../../src/app';
import { createDb } from '../../src/db';
import type { PositionView } from '../../src/positions/service';
import type { PositionSummary } from '../../src/positions/summary';
import { UpstreamError } from '../../src/market/upstream';
import { ChineseTradingCalendar } from '../../src/trading-calendar';
import type { EmailLoginResponse } from '../../src/routes/auth';
import {
  eastmoneySamples,
  RecordedUpstream,
  sample,
  tiantianSamples,
  type Replay,
} from '../support/recorded-upstream';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';

describe('今日收益与持仓汇总（HTTP）', () => {
  let db: TestSchema;
  let app: App;
  let now: Date;
  let code: string;
  let published: boolean;

  const replay: Replay = (url) => {
    if (
      url.hostname === 'api.fund.eastmoney.com' &&
      url.searchParams.get('fundCode') === '110020'
    ) {
      const body = JSON.parse(sample('eastmoney/nav-110020-history-2026-10-06-p1.json')) as {
        Data: { LSJZList: { FSRQ: string }[] };
      };
      if (!published) body.Data.LSJZList = body.Data.LSJZList.filter((p) => p.FSRQ < '2026-11-06');
      if (url.searchParams.get('pageSize') === '1')
        body.Data.LSJZList = body.Data.LSJZList.slice(0, 1);
      return JSON.stringify(body);
    }
    if (url.hostname === 'fundcomapi.tiantianfunds.com') {
      const body = JSON.parse(sample('tiantian/valuation-000001-110020-040046-999999.json')) as {
        data: Record<string, unknown>[];
      };
      body.data = body.data.map((row) =>
        row.FCODE === '110020' ? { ...row, PDATE: '2026-11-05', NAV: 1.703 } : row,
      );
      return tiantianSamples(JSON.stringify(body))(url);
    }
    if (url.hostname === 'hq.sinajs.cn') return '';
    return eastmoneySamples(url);
  };

  function makeApp(source: Replay = replay, extra: AppDeps = {}) {
    return createApp({
      database: createDb(db.pool),
      clock: { now: () => now },
      upstream: new RecordedUpstream(source),
      mailer: {
        async sendVerificationCode(_email, value) {
          code = value;
        },
      },
      ...extra,
    });
  }

  beforeEach(async () => {
    db = await createTestSchema();
    now = new Date('2026-11-06T02:00:00Z');
    code = '';
    published = false;
    app = makeApp();
  });
  afterEach(async () => dropTestSchema(db));

  async function login() {
    const email = `gains-${randomUUID()}@example.com`;
    await send({}, 'POST', '/v1/auth/email/request', { email });
    const response = await send({}, 'POST', '/v1/auth/email/login', {
      email,
      code,
      device: 'miniprogram',
    });
    expect(response.status).toBe(200);
    return { Authorization: `Bearer ${((await response.json()) as EmailLoginResponse).token}` };
  }
  function send(headers: Record<string, string>, method: string, path: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function channels(headers: Record<string, string>) {
    return (
      (await (await app.request('/v1/channels', { headers })).json()) as { items: { id: string }[] }
    ).items;
  }
  async function create(
    headers: Record<string, string>,
    channelId: string,
    fundCode = '110020',
    shares = '1000',
    totalCost = '1500',
  ) {
    const response = await send(headers, 'POST', '/v1/positions', {
      channelId,
      fundCode,
      shares,
      totalCost,
    });
    expect(response.status).toBe(201);
    return (await response.json()) as PositionView;
  }

  it('returns estimated gain and rate before today’s NAV is published', async () => {
    const headers = await login();
    const [channel] = await channels(headers);
    const position = await create(headers, channel!.id);
    expect(position).toMatchObject({
      todayGain: '-24.52', // 1000 × 1.7030 × -1.44% = -24.5232
      todayGainRate: '-0.0144',
      todayGainStatus: 'estimated',
      todayGainDate: '2026-11-06',
      previousMarketValue: '1703.00000000',
      realizedGain: '0.00',
      totalGain: '203.00',
    });
  });

  it('switches to confirmed gain after publication on the same injected clock', async () => {
    const headers = await login();
    const [channel] = await channels(headers);
    const position = await create(headers, channel!.id);
    expect(position.todayGainStatus).toBe('estimated');
    now = new Date('2026-11-06T11:05:00Z');
    published = true;
    const detail = await app.request(`/v1/positions/${position.id}`, { headers });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      todayGain: '-22.60',
      todayGainRate: '-0.0133',
      todayGainStatus: 'confirmed',
      marketValue: '1680.40',
      holdingGain: '180.40',
      totalGain: '180.40',
    });
    const list = await app.request('/v1/positions', { headers });
    expect(await list.json()).toMatchObject({
      items: [{ todayGain: '-22.60', todayGainStatus: 'confirmed' }],
    });
  });

  it('summarizes assets and gains and merges the same fund across channels', async () => {
    const headers = await login();
    const [first, second] = await channels(headers);
    await create(headers, first!.id);
    await create(headers, second!.id, '110020', '500', '1000');
    const response = await app.request('/v1/positions/summary', { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      totalAssets: '2554.50',
      totalCost: '2500.00',
      todayGain: '-36.78',
      todayGainRate: '-0.0144',
      todayGainStatus: 'estimated',
      holdingGain: '54.50',
      realizedGain: '0.00',
      totalGain: '54.50',
      valuationComplete: true,
      todayGainComplete: true,
      isComplete: true,
    });
    const funds = await app.request('/v1/positions/by-fund', { headers });
    expect(funds.status).toBe(200);
    expect(await funds.json()).toMatchObject({
      items: [
        {
          fundCode: '110020',
          shares: '1500.0000',
          totalCost: '2500.00',
          unitPrice: '1.6667',
          totalAssets: '2554.50',
          holdingGain: '54.50',
          holdingGainRate: '0.0218',
          todayGain: '-36.78',
          todayGainRate: '-0.0144',
          isComplete: true,
        },
      ],
    });
  });

  async function summary(headers: Record<string, string>, suffix = '') {
    const response = await app.request(`/v1/positions/summary${suffix}`, { headers });
    expect(response.status).toBe(200);
    return (await response.json()) as PositionSummary;
  }

  it('excludes unavailable estimates and their denominators from a partial total', async () => {
    const headers = await login();
    const [channel] = await channels(headers);
    await create(headers, channel!.id);
    const missing = await create(headers, channel!.id, '000001', '2000', '1900');
    expect(missing).toMatchObject({
      todayGain: null,
      todayGainRate: null,
      todayGainStatus: 'unavailable',
    });
    expect(await summary(headers)).toMatchObject({
      totalAssets: '3703.00',
      holdingGain: '303.00',
      totalGain: '303.00',
      todayGain: '-24.52',
      todayGainRate: '-0.0144',
      previousMarketValue: '1703.00000000',
      todayGainStatus: 'estimated',
      valuationComplete: true,
      todayGainComplete: false,
      isComplete: false,
    });
  });

  it('marks valuation totals incomplete without treating missing NAV as zero', async () => {
    const headers = await login();
    const [channel] = await channels(headers);
    await create(headers, channel!.id);
    await create(headers, channel!.id, '000001', '2000', '1900');
    const noNav: Replay = (url) =>
      url.hostname === 'api.fund.eastmoney.com' && url.searchParams.get('fundCode') === '000001'
        ? sample('eastmoney/nav-999999-latest.json')
        : replay(url);
    app = makeApp(noNav);
    expect(await summary(headers)).toMatchObject({
      totalAssets: '1703.00',
      totalCost: '3400.00',
      holdingGain: '203.00',
      holdingGainRate: '0.1353',
      totalGain: '203.00',
      valuationComplete: false,
      isComplete: false,
    });
    app = makeApp((url) =>
      url.hostname === 'api.fund.eastmoney.com'
        ? new UpstreamError('timeout', 'NAV unavailable')
        : replay(url),
    );
    expect(await summary(headers)).toMatchObject({
      totalAssets: null,
      holdingGain: null,
      totalGain: null,
      todayGain: null,
      todayGainRate: null,
      todayGainStatus: 'unavailable',
      realizedGain: '0.00',
      valuationComplete: false,
      todayGainComplete: false,
      isComplete: false,
    });
  });

  it('requires login and scopes both aggregates to the user and optional channel', async () => {
    for (const path of ['/v1/positions/summary', '/v1/positions/by-fund']) {
      expect((await app.request(path)).status).toBe(401);
      expect((await createApp().request(path)).status).toBe(503);
    }
    const headers = await login();
    const [first, second] = await channels(headers);
    await create(headers, first!.id);
    await create(headers, second!.id, '110020', '500', '1000');
    const other = await login();
    const [otherChannel] = await channels(other);
    await create(other, otherChannel!.id, '110020', '9000', '1');
    expect(await summary(headers, `?channelId=${first!.id}`)).toMatchObject({
      totalAssets: '1703.00',
      todayGain: '-24.52',
    });
    expect(await summary(headers, `?channelId=${otherChannel!.id}`)).toMatchObject({
      totalAssets: '0.00',
      todayGain: '0.00',
      todayGainRate: null,
      isComplete: true,
    });
    expect(
      await (await app.request(`/v1/positions/by-fund?channelId=${first!.id}`, { headers })).json(),
    ).toMatchObject({ items: [{ shares: '1000.0000', totalCost: '1500.00' }] });
    expect(
      await (
        await app.request(`/v1/positions/by-fund?channelId=${otherChannel!.id}`, { headers })
      ).json(),
    ).toEqual({ items: [] });
    for (const path of ['/v1/positions/summary', '/v1/positions/by-fund']) {
      const response = await app.request(`${path}?channelId=invalid`, { headers });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'validation_error' } });
    }
    const empty = await login();
    expect(await summary(empty)).toMatchObject({
      totalAssets: '0.00',
      totalCost: '0.00',
      todayGain: '0.00',
      todayGainRate: null,
      holdingGain: '0.00',
      realizedGain: '0.00',
      totalGain: '0.00',
      todayGainStatus: 'unavailable',
      isComplete: true,
    });
  });

  it.each([
    ['weekend', '2026-11-07T02:00:00Z', []],
    ['holiday', '2026-11-06T02:00:00Z', ['2026-11-06']],
    ['pre-market', '2026-11-06T00:59:00Z', []],
    ['Shanghai midnight', '2026-11-06T16:01:00Z', []],
  ])('does not reuse a previous trading day’s gain during %s', async (_label, time, holidays) => {
    const headers = await login();
    const [channel] = await channels(headers);
    const position = await create(headers, channel!.id);
    now = new Date(time as string);
    app = makeApp(replay, { tradingCalendar: new ChineseTradingCalendar(holidays as string[]) });
    const detail = await app.request(`/v1/positions/${position.id}`, { headers });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      todayGain: null,
      todayGainRate: null,
      todayGainStatus: 'unavailable',
      todayGainDate:
        time === '2026-11-06T16:01:00Z' || time === '2026-11-07T02:00:00Z'
          ? '2026-11-07'
          : '2026-11-06',
    });
    expect(await summary(headers)).toMatchObject({
      todayGain: null,
      todayGainStatus: 'unavailable',
      todayGainComplete: false,
    });
  });

  it('keeps a real zero estimate and returns a null rate for zero shares', async () => {
    const headers = await login();
    const [channel] = await channels(headers);
    const zeroEstimate: Replay = (url) => {
      const result = replay(url);
      if (url.hostname !== 'fundcomapi.tiantianfunds.com' || typeof result !== 'string')
        return result;
      const body = JSON.parse(result) as { data: Record<string, unknown>[] };
      body.data = body.data.map((row) => ({ ...row, GSZZL: 0 }));
      return JSON.stringify(body);
    };
    app = makeApp(zeroEstimate);
    const position = await create(headers, channel!.id, '110020', '1', '0');
    expect(position).toMatchObject({
      todayGain: '0.00',
      todayGainRate: '0.0000',
      todayGainStatus: 'estimated',
    });
    const cleared = await send(headers, 'PATCH', `/v1/positions/${position.id}`, {
      shares: '0',
      totalCost: '0',
    });
    expect(await cleared.json()).toMatchObject({
      todayGain: '0.00',
      todayGainRate: null,
      todayGainStatus: 'estimated',
      previousMarketValue: '0.00000000',
    });
    expect(await summary(headers)).toMatchObject({
      todayGain: '0.00',
      todayGainRate: null,
      totalAssets: '0.00',
      isComplete: true,
    });
  });

  it('rounds percent precision with fixed decimals before rounding the final amount', async () => {
    const headers = await login();
    const [channel] = await channels(headers);
    const precision: Replay = (url) => {
      const result = replay(url);
      if (url.hostname !== 'fundcomapi.tiantianfunds.com' || typeof result !== 'string')
        return result;
      const body = JSON.parse(result) as { data: Record<string, unknown>[] };
      body.data = body.data.map((row) => ({ ...row, GSZZL: '-0.0000015' }));
      return JSON.stringify(body);
    };
    app = makeApp(precision);
    const position = await create(headers, channel!.id, '110020', '100000000', '1');
    // -0.0000015% → -0.000002%；170300000 × -0.00000002 = -3.406 → -3.41。
    expect(position).toMatchObject({ todayGain: '-3.41', todayGainStatus: 'estimated' });
  });

  it('preserves a nonzero tiny denominator instead of rounding it to zero', async () => {
    published = true;
    const headers = await login();
    const [channel] = await channels(headers);
    const position = await create(headers, channel!.id, '110020', '0.0001', '0');
    expect(position).toMatchObject({
      todayGain: '0.00',
      previousMarketValue: '0.00017030',
      todayGainRate: '0.0000',
      todayGainStatus: 'confirmed',
    });
  });

  it('reports mixed estimates and confirmations while recomputing the combined rate', async () => {
    const headers = await login();
    const [channel] = await channels(headers);
    app = makeApp((url) =>
      url.hostname === 'api.fund.eastmoney.com' &&
      url.searchParams.get('fundCode') === '000001' &&
      url.searchParams.get('pageSize') === '1'
        ? sample('eastmoney/nav-000001-latest-2026-11-06.json')
        : replay(url),
    );
    await create(headers, channel!.id);
    const confirmed = await create(headers, channel!.id, '000001', '2000', '1900');
    expect(confirmed).toMatchObject({ todayGain: '20.00', todayGainStatus: 'confirmed' });
    expect(await summary(headers)).toMatchObject({
      totalAssets: '3723.00',
      holdingGain: '323.00',
      todayGain: '-4.52',
      todayGainRate: '-0.0012',
      previousMarketValue: '3703.00000000',
      todayGainStatus: 'mixed',
      isComplete: true,
    });
    const funds = await app.request('/v1/positions/by-fund', { headers });
    expect(await funds.json()).toMatchObject({
      items: [
        { fundCode: '110020', todayGainStatus: 'estimated' },
        { fundCode: '000001', todayGainStatus: 'confirmed' },
      ],
    });
  });

  it('can confirm a zero previous NAV with a null gain rate', async () => {
    published = true;
    const headers = await login();
    const [channel] = await channels(headers);
    const zeroBase: Replay = (url) => {
      const result = replay(url);
      if (url.hostname !== 'api.fund.eastmoney.com' || typeof result !== 'string') return result;
      const body = JSON.parse(result) as { Data: { LSJZList: { FSRQ: string; DWJZ: string }[] } };
      body.Data.LSJZList = body.Data.LSJZList.map((row) =>
        row.FSRQ < '2026-11-06' ? { ...row, DWJZ: '0.0000' } : row,
      );
      return JSON.stringify(body);
    };
    app = makeApp(zeroBase);
    const position = await create(headers, channel!.id, '110020', '1', '1');
    expect(position).toMatchObject({
      todayGain: '1.68',
      todayGainRate: null,
      previousMarketValue: '0.00000000',
      todayGainStatus: 'confirmed',
    });
    expect(await summary(headers)).toMatchObject({
      todayGain: '1.68',
      todayGainRate: null,
      isComplete: true,
    });
  });

  it('returns unavailable when the previous NAV is missing even if today is published', async () => {
    published = true;
    const headers = await login();
    const [channel] = await channels(headers);
    app = makeApp((url) =>
      url.hostname === 'api.fund.eastmoney.com' && url.searchParams.get('pageSize') === '20'
        ? sample('eastmoney/nav-999999-latest.json')
        : replay(url),
    );
    const position = await create(headers, channel!.id);
    expect(position).toMatchObject({
      marketValue: '1680.40',
      todayGain: null,
      todayGainRate: null,
      previousMarketValue: null,
      todayGainStatus: 'unavailable',
    });
    expect(await summary(headers)).toMatchObject({
      totalAssets: '1680.40',
      todayGain: null,
      todayGainRate: null,
      valuationComplete: true,
      todayGainComplete: false,
    });
  });

  it('rounds a tiny percent written in exponent notation to a real zero estimate', async () => {
    const headers = await login();
    const [channel] = await channels(headers);
    app = makeApp((url) => {
      const result = replay(url);
      if (url.hostname !== 'fundcomapi.tiantianfunds.com' || typeof result !== 'string')
        return result;
      const body = JSON.parse(result) as { data: Record<string, unknown>[] };
      body.data = body.data.map((row) => ({ ...row, GSZZL: 1e-7 }));
      return JSON.stringify(body);
    });
    const position = await create(headers, channel!.id);
    expect(position).toMatchObject({
      todayGain: '0.00',
      todayGainRate: '0.0000',
      todayGainStatus: 'estimated',
    });
  });
});
