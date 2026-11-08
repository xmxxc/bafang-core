import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App, type AppDeps } from '../../src/app';
import { createDb } from '../../src/db';
import { trades } from '../../src/db/schema';
import { ChineseTradingCalendar } from '../../src/trading-calendar';
import type { WeChatLoginResponse } from '../../src/routes/auth';
import { eastmoneySamples, RecordedUpstream, type Replay } from '../support/recorded-upstream';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';

interface TradeBody {
  id: string;
  positionId: string;
  type: string;
  status: string;
  submittedDate: string;
  beforeCutoff: boolean;
  applicationDate: string;
  settlementDate: string;
  amount: string | null;
  shares: string | null;
  feeRate: string;
  confirmedNav: string | null;
  confirmedShares: string | null;
  switchId: string | null;
  source: string;
}
type Headers = Record<string, string>;

describe('加仓交易：在途、确认日与撤销', () => {
  let db: TestSchema;
  let now: Date;
  beforeEach(async () => {
    db = await createTestSchema();
    now = new Date('2026-11-06T06:59:59Z');
  });
  afterEach(async () => dropTestSchema(db));

  function makeApp(extra: AppDeps = {}, replay: Replay = eastmoneySamples): App {
    return createApp({
      database: createDb(db.pool),
      upstream: new RecordedUpstream(replay),
      clock: { now: () => now },
      tradingCalendar: new ChineseTradingCalendar([
        '2026-10-01',
        '2026-10-02',
        '2026-10-05',
        '2026-10-06',
        '2026-10-07',
      ]),
      wechat: { openid: async (code) => code },
      ...extra,
    });
  }
  function send(app: App, headers: Headers, method: string, path: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function login(app: App): Promise<Headers> {
    const response = await send(app, {}, 'POST', '/v1/auth/wechat/login', { code: randomUUID() });
    expect(response.status).toBe(200);
    return { Authorization: `Bearer ${((await response.json()) as WeChatLoginResponse).token}` };
  }
  async function position(app: App, headers: Headers, fundCode = '110020'): Promise<string> {
    const channels = (await (await app.request('/v1/channels', { headers })).json()) as {
      items: { id: string }[];
    };
    const response = await send(app, headers, 'POST', '/v1/positions', {
      fundCode,
      channelId: channels.items[0]!.id,
      shares: '100',
      totalCost: '150',
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { id: string }).id;
  }
  async function buy(
    app: App,
    headers: Headers,
    id: string,
    extra: Record<string, unknown> = {},
  ): Promise<TradeBody> {
    const response = await send(app, headers, 'POST', `/v1/positions/${id}/trades`, {
      type: 'buy',
      amount: '100.01',
      feeRate: '0.0015',
      ...extra,
    });
    expect(response.status).toBe(201);
    return (await response.json()) as TradeBody;
  }
  async function history(app: App, headers: Headers, id: string): Promise<TradeBody[]> {
    const response = await app.request(`/v1/positions/${id}/trades`, { headers });
    expect(response.status).toBe(200);
    return ((await response.json()) as { items: TradeBody[] }).items;
  }

  it.each([
    ['2026-11-06', true, '2026-11-06', '2026-11-09'],
    ['2026-11-06', false, '2026-11-09', '2026-11-10'],
    ['2026-11-07', true, '2026-11-09', '2026-11-10'],
    ['2026-11-08', false, '2026-11-09', '2026-11-10'],
    ['2026-09-30', true, '2026-09-30', '2026-10-08'],
    ['2026-09-30', false, '2026-10-08', '2026-10-09'],
    ['2026-10-01', true, '2026-10-08', '2026-10-09'],
  ])(
    'computes T+1 for submission %s beforeCutoff=%s',
    async (submittedDate, beforeCutoff, applicationDate, settlementDate) => {
      const app = makeApp();
      const headers = await login(app);
      const id = await position(app, headers);
      expect(await buy(app, headers, id, { submittedDate, beforeCutoff })).toMatchObject({
        submittedDate,
        beforeCutoff,
        applicationDate,
        settlementDate,
      });
    },
  );

  it.each([
    ['2026-11-06T06:59:59Z', true, '2026-11-06', '2026-11-09'],
    ['2026-11-06T07:00:00Z', false, '2026-11-09', '2026-11-10'],
    ['2026-11-06T07:00:01Z', false, '2026-11-09', '2026-11-10'],
    ['2026-11-06T16:00:00Z', true, '2026-11-09', '2026-11-10'],
  ])(
    'uses the Shanghai clock at %s when timing is omitted',
    async (instant, beforeCutoff, applicationDate, settlementDate) => {
      now = new Date(instant);
      const app = makeApp();
      const headers = await login(app);
      const id = await position(app, headers);
      expect(await buy(app, headers, id)).toMatchObject({
        submittedDate: instant.includes('16:00') ? '2026-11-07' : '2026-11-06',
        beforeCutoff,
        applicationDate,
        settlementDate,
      });
    },
  );

  it('uses fund-specific T+N from fund details, including QDII category defaults', async () => {
    const replay: Replay = (url) => {
      if (url.hostname === 'fundmobapi.eastmoney.com')
        return JSON.stringify({
          ErrCode: 0,
          Datas: { FCODE: '110020', SHORTNAME: '测试 QDII', FTYPE: 'QDII', SSBCFMDATA: null },
        });
      return eastmoneySamples(url);
    };
    const app = makeApp({}, replay);
    const headers = await login(app);
    const id = await position(app, headers);
    expect(await buy(app, headers, id)).toMatchObject({
      applicationDate: '2026-11-06',
      settlementDate: '2026-11-10',
    });
    const upstream = makeApp({}, (url) =>
      url.hostname === 'fundmobapi.eastmoney.com'
        ? JSON.stringify({
            ErrCode: 0,
            Datas: { FCODE: '110020', SHORTNAME: '测试基金', SSBCFMDATA: '3' },
          })
        : eastmoneySamples(url),
    );
    expect(await buy(upstream, headers, id)).toMatchObject({ settlementDate: '2026-11-11' });
  });

  it('keeps shares and cost unchanged, sums pending amounts in detail/list, and preserves trades across calibration', async () => {
    const app = makeApp();
    const headers = await login(app);
    const id = await position(app, headers);
    expect(await (await app.request(`/v1/positions/${id}`, { headers })).json()).toMatchObject({
      pendingAmount: '0.00',
    });
    const first = await buy(app, headers, id);
    const second = await buy(app, headers, id, { amount: '0.02' });
    const expected = { id, shares: '100.0000', totalCost: '150.00', pendingAmount: '100.03' };
    expect(await (await app.request(`/v1/positions/${id}`, { headers })).json()).toMatchObject(
      expected,
    );
    expect(await (await app.request('/v1/positions', { headers })).json()).toMatchObject({
      items: [expected],
    });
    const calibrated = await send(app, headers, 'PATCH', `/v1/positions/${id}`, {
      shares: '0',
      totalCost: '0',
    });
    expect(calibrated.status).toBe(200);
    expect(await calibrated.json()).toMatchObject({
      shares: '0.0000',
      totalCost: '0.00',
      pendingAmount: '100.03',
    });
    expect(await history(app, headers, id)).toEqual([first, second]);
  });

  it('lists complete trade records, cancels by deletion, and updates pending amount', async () => {
    const app = makeApp();
    const headers = await login(app);
    const id = await position(app, headers);
    const trade = await buy(app, headers, id);
    expect(trade).toMatchObject({
      positionId: id,
      type: 'buy',
      status: 'pending',
      submittedDate: '2026-11-06',
      settlementDate: '2026-11-09',
      amount: '100.01',
      shares: null,
      feeRate: '0.001500',
      confirmedNav: null,
      confirmedShares: null,
      switchId: null,
      source: 'web',
    });
    expect(await history(app, headers, id)).toEqual([trade]);
    const path = `/v1/positions/${id}/trades/${trade.id}`;
    expect((await send(app, headers, 'DELETE', path)).status).toBe(204);
    expect(await history(app, headers, id)).toEqual([]);
    expect(await (await app.request(`/v1/positions/${id}`, { headers })).json()).toMatchObject({
      shares: '100.0000',
      totalCost: '150.00',
      pendingAmount: '0.00',
    });
    expect((await send(app, headers, 'DELETE', path)).status).toBe(404);
  });

  it.each(['2026-11-09T00:00:00+08:00', '2026-11-10T10:00:00+08:00'])(
    'refuses cancellation on or after settlement date at %s even while pending',
    async (instant) => {
      const app = makeApp();
      const headers = await login(app);
      const id = await position(app, headers);
      const trade = await buy(app, headers, id);
      now = new Date(instant);
      const response = await send(app, headers, 'DELETE', `/v1/positions/${id}/trades/${trade.id}`);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'trade_not_cancellable' } });
      expect(await history(app, headers, id)).toEqual([trade]);
    },
  );

  it('refuses confirmed trades before their settlement date and excludes them from pending totals', async () => {
    const app = makeApp();
    const headers = await login(app);
    const id = await position(app, headers);
    // #19 才提供确认业务；此处只用数据库准备已确认历史，断言仍全部经过 HTTP。
    await createDb(db.pool).insert(trades).values({
      positionId: id,
      type: 'buy',
      status: 'confirmed',
      submittedDate: '2026-11-06',
      beforeCutoff: true,
      applicationDate: '2026-11-06',
      settlementDate: '2026-11-09',
      amount: '100.01',
      feeRate: '0.0015',
      confirmedNav: '1.6804',
      confirmedShares: '59.4269',
      source: '访问令牌名称可完整保留',
    });
    const [trade] = await history(app, headers, id);
    expect(trade).toMatchObject({
      status: 'confirmed',
      confirmedNav: '1.6804',
      confirmedShares: '59.4269',
      source: '访问令牌名称可完整保留',
    });
    const response = await send(app, headers, 'DELETE', `/v1/positions/${id}/trades/${trade!.id}`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'trade_not_cancellable' } });
    expect(await (await app.request(`/v1/positions/${id}`, { headers })).json()).toMatchObject({
      pendingAmount: '0.00',
    });
  });

  it('requires login, hides other users’ positions/trades, and verifies both path ids', async () => {
    const app = makeApp();
    const headers = await login(app);
    const id = await position(app, headers);
    const trade = await buy(app, headers, id);
    const other = await login(app);
    const otherId = await position(app, other);
    const paths: [string, string, unknown?][] = [
      ['GET', `/v1/positions/${id}/trades`],
      ['POST', `/v1/positions/${id}/trades`, { type: 'buy', amount: '1', feeRate: '0' }],
      ['DELETE', `/v1/positions/${id}/trades/${trade.id}`],
    ];
    for (const [method, path, body] of paths) {
      expect((await send(app, {}, method, path, body)).status).toBe(401);
      const response = await send(app, other, method, path, body);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
    }
    expect(
      (await send(app, other, 'DELETE', `/v1/positions/${otherId}/trades/${trade.id}`)).status,
    ).toBe(404);
    expect(await history(app, headers, id)).toEqual([trade]);
  });

  it('deletes a position and its trades together over HTTP', async () => {
    const app = makeApp();
    const headers = await login(app);
    const id = await position(app, headers);
    const trade = await buy(app, headers, id);
    expect((await send(app, headers, 'DELETE', `/v1/positions/${id}`)).status).toBe(204);
    expect((await app.request(`/v1/positions/${id}/trades`, { headers })).status).toBe(404);
    const replacement = await position(app, headers);
    expect(await history(app, headers, replacement)).toEqual([]);
    expect(
      (await send(app, headers, 'DELETE', `/v1/positions/${replacement}/trades/${trade.id}`))
        .status,
    ).toBe(404);
  });

  it('rejects invalid amounts, fee rates, types and dates without creating trades', async () => {
    const app = makeApp();
    const headers = await login(app);
    const id = await position(app, headers);
    for (const input of [
      { amount: '0' },
      { amount: '-1' },
      { amount: '1.001' },
      { amount: 1 },
      { amount: '1e2' },
      { amount: '99999999999999999999999' },
      { feeRate: '-0.1' },
      { feeRate: '1.000001' },
      { feeRate: '0.1234567' },
      { feeRate: 0 },
      { type: 'sell' },
      { submittedDate: '2026-02-30', beforeCutoff: true },
      { submittedDate: '2026-11-06' },
      { beforeCutoff: 'true' },
    ]) {
      const response = await send(app, headers, 'POST', `/v1/positions/${id}/trades`, {
        type: 'buy',
        amount: '1',
        feeRate: '0',
        ...input,
      });
      expect(response.status, JSON.stringify(input)).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'validation_error' } });
    }
    expect(await history(app, headers, id)).toEqual([]);
  });
});
