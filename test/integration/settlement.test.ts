import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../../src/app';
import { createDb } from '../../src/db';
import { ChineseTradingCalendar } from '../../src/trading-calendar';
import { startSettlementScheduler } from '../../src/positions/settlement';
import type { WeChatLoginResponse } from '../../src/routes/auth';
import {
  eastmoneySamples,
  estimateSamples,
  RecordedUpstream,
  type Replay,
} from '../support/recorded-upstream';
import { UpstreamError } from '../../src/market/upstream';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';

type Headers = Record<string, string>;

describe('交易确认任务', () => {
  let db: TestSchema;
  let now = new Date('2026-11-06T06:59:59Z');

  beforeEach(async () => {
    db = await createTestSchema();
    now = new Date('2026-11-06T06:59:59Z');
  });
  afterEach(async () => dropTestSchema(db));

  function allSamples(navReplay: Replay = eastmoneySamples): Replay {
    const estimates = estimateSamples({ nav: navReplay });
    return (url) => {
      if (
        url.hostname === 'api.fund.eastmoney.com' ||
        url.hostname === 'fundcomapi.tiantianfunds.com' ||
        url.hostname === 'hq.sinajs.cn'
      ) {
        return estimates(url);
      }
      return eastmoneySamples(url);
    };
  }

  function makeApp(replay: Replay = allSamples()): App {
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
    });
  }

  async function send(app: App, headers: Headers, method: string, path: string, body?: unknown) {
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

  async function createBuy(
    app: App,
    headers: Headers,
    extra: Record<string, unknown> = {},
    fundCode = '110020',
  ) {
    const channels = (await (await app.request('/v1/channels', { headers })).json()) as {
      items: { id: string }[];
    };
    const positionResponse = await send(app, headers, 'POST', '/v1/positions', {
      fundCode,
      channelId: channels.items[0]!.id,
      shares: '100',
      totalCost: '150',
    });
    expect(positionResponse.status).toBe(201);
    const position = (await positionResponse.json()) as { id: string };
    const tradeResponse = await send(app, headers, 'POST', `/v1/positions/${position.id}/trades`, {
      type: 'buy',
      amount: '100.01',
      feeRate: '0.0015',
      submittedDate: '2026-11-06',
      beforeCutoff: true,
      ...extra,
    });
    expect(tradeResponse.status).toBe(201);
    return { positionId: position.id, trade: (await tradeResponse.json()) as { id: string } };
  }

  it('confirms through the in-process job, updates HTTP-visible position state, and is idempotent', async () => {
    const app = makeApp();
    const headers = await login(app);
    const { positionId, trade } = await createBuy(app, headers);
    now = new Date('2026-11-10T13:30:00Z');

    expect(await app.runSettlement()).toMatchObject({ confirmed: 1, pending: 0, failed: 0 });
    expect(
      await (await app.request(`/v1/positions/${positionId}`, { headers })).json(),
    ).toMatchObject({
      shares: '159.4265',
      totalCost: '250.01',
      pendingAmount: '0.00',
      marketValue: '267.90',
      holdingGain: '17.89',
    });
    const first = await (
      await app.request(`/v1/positions/${positionId}/trades`, { headers })
    ).json();
    expect(first).toMatchObject({
      items: [
        { id: trade.id, status: 'confirmed', confirmedNav: '1.6804', confirmedShares: '59.4265' },
      ],
    });
    expect(await app.runSettlement()).toMatchObject({ confirmed: 0, pending: 0, failed: 0 });
    expect(
      await send(app, headers, 'DELETE', `/v1/positions/${positionId}/trades/${trade.id}`),
    ).toHaveProperty('status', 409);
  });

  it('keeps an expired trade in transit when the application-date NAV is not published', async () => {
    const unpublished: Replay = (url) => {
      if (url.hostname === 'api.fund.eastmoney.com' && url.searchParams.get('pageSize') === '1') {
        return JSON.stringify({
          Data: {
            LSJZList: [{ FSRQ: '2026-11-05', DWJZ: '1.7030', LJJZ: '1.7030', JZZZL: '0.28' }],
          },
          ErrCode: 0,
        });
      }
      if (url.hostname === 'api.fund.eastmoney.com' && url.searchParams.get('pageSize') === '20') {
        return JSON.stringify({ Data: { LSJZList: [] }, ErrCode: 0 });
      }
      return eastmoneySamples(url);
    };
    const app = makeApp(allSamples(unpublished));
    const headers = await login(app);
    const { positionId } = await createBuy(app, headers);
    now = new Date('2026-11-10T13:30:00Z');
    expect(await app.runSettlement()).toMatchObject({ confirmed: 0, pending: 1, failed: 0 });
    expect(
      await (await app.request(`/v1/positions/${positionId}`, { headers })).json(),
    ).toMatchObject({
      shares: '100.0000',
      totalCost: '150.00',
      pendingAmount: '100.01',
    });
  });

  it('supports a zero fee rate', async () => {
    const app = makeApp();
    const headers = await login(app);
    const { positionId } = await createBuy(app, headers, { feeRate: '0' });
    now = new Date('2026-11-10T13:30:00Z');
    expect(await app.runSettlement()).toMatchObject({ confirmed: 1, pending: 0, failed: 0 });
    expect(
      await (await app.request(`/v1/positions/${positionId}`, { headers })).json(),
    ).toMatchObject({
      shares: '159.5156',
      totalCost: '250.01',
    });
  });

  it('runs each configured evening round once and retries after NAV publication', async () => {
    let published = false;
    const stagedNav: Replay = (url) => {
      if (url.hostname === 'api.fund.eastmoney.com' && !published) {
        if (url.searchParams.get('pageSize') === '1') {
          return JSON.stringify({
            Data: {
              LSJZList: [{ FSRQ: '2026-11-05', DWJZ: '1.7030', LJJZ: '1.7030', JZZZL: '0.28' }],
            },
            ErrCode: 0,
          });
        }
        if (url.searchParams.get('pageSize') === '20') {
          return JSON.stringify({ Data: { LSJZList: [] }, ErrCode: 0 });
        }
      }
      return eastmoneySamples(url);
    };
    const app = makeApp(allSamples(stagedNav));
    const headers = await login(app);
    const { positionId } = await createBuy(app, headers);
    const calendar = new ChineseTradingCalendar([
      '2026-10-01',
      '2026-10-02',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
    ]);
    let runs = 0;
    const scheduler = startSettlementScheduler(
      {
        run: async () => {
          runs++;
          return app.runSettlement();
        },
      },
      { clock: { now: () => now }, calendar },
      { autoStart: false, intervalMs: 1_000_000 },
    );
    now = new Date('2026-11-09T13:30:00Z'); // 21:30 Shanghai
    await scheduler.tick();
    expect(runs).toBe(1);
    expect(
      await (await app.request(`/v1/positions/${positionId}`, { headers })).json(),
    ).toMatchObject({
      shares: '100.0000',
      pendingAmount: '100.01',
    });
    await scheduler.tick();
    expect(runs).toBe(1);

    published = true;
    now = new Date('2026-11-09T14:30:00Z'); // 22:30 Shanghai
    await scheduler.tick();
    expect(runs).toBe(2);
    expect(
      await (await app.request(`/v1/positions/${positionId}`, { headers })).json(),
    ).toMatchObject({
      shares: '159.4265',
      pendingAmount: '0.00',
    });
    await scheduler.tick();
    expect(runs).toBe(2);

    scheduler.stop();
    now = new Date('2026-11-09T15:30:00Z'); // 23:30 Shanghai
    await scheduler.tick();
    expect(runs).toBe(2);

    const nonTrading = startSettlementScheduler(
      {
        run: async () => {
          runs++;
          return app.runSettlement();
        },
      },
      { clock: { now: () => now }, calendar },
      { autoStart: false, intervalMs: 1_000_000 },
    );
    now = new Date('2026-11-08T13:30:00Z'); // Sunday 21:30 Shanghai
    await nonTrading.tick();
    expect(runs).toBe(2);
    nonTrading.stop();
  });

  it('keeps a QDII T+2 trade pending on T+1 and confirms it on T+2', async () => {
    const base = allSamples();
    const qdiiReplay: Replay = (url) => {
      if (url.hostname === 'fundmobapi.eastmoney.com') {
        return JSON.stringify({
          ErrCode: 0,
          Datas: { FCODE: '110020', SHORTNAME: '测试 QDII', FTYPE: 'QDII', SSBCFMDATA: null },
        });
      }
      return base(url);
    };
    const app = makeApp(qdiiReplay);
    const headers = await login(app);
    const { positionId } = await createBuy(app, headers);
    now = new Date('2026-11-09T13:30:00Z');
    expect(await app.runSettlement()).toMatchObject({ confirmed: 0, pending: 1, failed: 0 });
    expect(
      await (await app.request(`/v1/positions/${positionId}`, { headers })).json(),
    ).toMatchObject({
      shares: '100.0000',
      pendingAmount: '100.01',
    });
    now = new Date('2026-11-10T13:30:00Z');
    expect(await app.runSettlement()).toMatchObject({ confirmed: 1, pending: 0, failed: 0 });
    expect(
      await (await app.request(`/v1/positions/${positionId}`, { headers })).json(),
    ).toMatchObject({
      shares: '159.4265',
      totalCost: '250.01',
    });
  });

  it('re-buys into a zero-share position with the correct shares and cost', async () => {
    const app = makeApp();
    const headers = await login(app);
    const { positionId } = await createBuy(app, headers);
    const calibrated = await send(app, headers, 'PATCH', `/v1/positions/${positionId}`, {
      shares: '0',
      totalCost: '0',
    });
    expect(calibrated.status).toBe(200);
    now = new Date('2026-11-10T13:30:00Z');
    expect(await app.runSettlement()).toMatchObject({ confirmed: 1, pending: 0, failed: 0 });
    expect(
      await (await app.request(`/v1/positions/${positionId}`, { headers })).json(),
    ).toMatchObject({
      shares: '59.4265',
      totalCost: '100.01',
    });
  });

  it('counts one NAV failure without preventing another trade from confirming', async () => {
    const failingNav: Replay = (url) => {
      if (
        url.hostname === 'api.fund.eastmoney.com' &&
        url.searchParams.get('fundCode') === '110020'
      ) {
        throw new UpstreamError('timeout', 'recorded timeout');
      }
      return eastmoneySamples(url);
    };
    const app = makeApp(allSamples(failingNav));
    const headers = await login(app);
    const first = await createBuy(app, headers);
    const second = await createBuy(app, headers, { submittedDate: '2026-11-05' }, '040046');
    now = new Date('2026-11-10T13:30:00Z');
    expect(await app.runSettlement()).toMatchObject({ confirmed: 1, pending: 1, failed: 1 });
    expect(
      await (await app.request(`/v1/positions/${second.positionId}`, { headers })).json(),
    ).toMatchObject({
      shares: '113.6498',
      totalCost: '250.01',
    });
    expect(
      await (await app.request(`/v1/positions/${first.positionId}/trades`, { headers })).json(),
    ).toMatchObject({
      items: [{ status: 'pending' }],
    });
  });
});
