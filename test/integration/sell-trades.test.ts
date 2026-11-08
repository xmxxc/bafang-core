import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../../src/app';
import type { PositionView } from '../../src/positions/service';
import { createDb } from '../../src/db';
import { ChineseTradingCalendar } from '../../src/trading-calendar';
import type { WeChatLoginResponse } from '../../src/routes/auth';
import {
  eastmoneySamples,
  estimateSamples,
  RecordedUpstream,
  type Replay,
} from '../support/recorded-upstream';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';

type Headers = Record<string, string>;

describe('减仓、已实现收益与已清仓', () => {
  let db: TestSchema;
  let now: Date;
  let app: App;
  let headers: Headers;
  let channels: { id: string; name: string }[];
  beforeEach(async () => {
    db = await createTestSchema();
    now = new Date('2026-11-06T06:59:59Z');
    app = makeApp();
    const login = await send('POST', '/v1/auth/wechat/login', { code: randomUUID() });
    expect(login.status).toBe(200);
    headers = { Authorization: `Bearer ${((await login.json()) as WeChatLoginResponse).token}` };
    channels = (await get<{ items: { id: string; name: string }[] }>('/v1/channels')).items;
  });
  afterEach(async () => dropTestSchema(db));

  function makeApp(replay: Replay = eastmoneySamples): App {
    return createApp({
      database: createDb(db.pool),
      upstream: new RecordedUpstream((url) => {
        if (
          ['api.fund.eastmoney.com', 'fundcomapi.tiantianfunds.com', 'hq.sinajs.cn'].includes(
            url.hostname,
          )
        ) {
          return estimateSamples({ nav: replay })(url);
        }
        return replay(url);
      }),
      clock: { now: () => now },
      tradingCalendar: new ChineseTradingCalendar([]),
      wechat: { openid: async (code) => code },
    });
  }
  function send(method: string, path: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function get<T = PositionView>(path: string): Promise<T> {
    const response = await send('GET', path);
    expect(response.status).toBe(200);
    return response.json() as Promise<T>;
  }
  async function position(extra: Record<string, unknown> = {}) {
    const response = await send('POST', '/v1/positions', {
      fundCode: '110020',
      channelId: channels[0]!.id,
      shares: '100',
      totalCost: '150',
      ...extra,
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string };
  }
  async function sell(id: string, shares = '40', extra: Record<string, unknown> = {}) {
    const response = await send('POST', `/v1/positions/${id}/trades`, {
      type: 'sell',
      shares,
      feeRate: '0.005',
      ...extra,
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string };
  }

  async function settle() {
    now = new Date('2026-11-10T13:30:00Z');
    return app.runSettlement();
  }

  it('confirms net proceeds and average cost once, exposing realized and total gains', async () => {
    const { id } = await position();
    const trade = await sell(id);
    expect(await settle()).toMatchObject({ confirmed: 1, pending: 0, failed: 0 });
    expect(await get(`/v1/positions/${id}`)).toMatchObject({
      shares: '60.0000',
      totalCost: '90.00',
      realizedGain: '6.88',
      realizedGainCost: '60.00',
      marketValue: '100.82',
      holdingGain: '10.82',
      totalGain: '17.70',
      pendingShares: '0.0000',
      availableShares: '60.0000',
      isCleared: false,
    });
    expect(await get(`/v1/positions/${id}/trades`)).toMatchObject({
      items: [
        {
          id: trade.id,
          status: 'confirmed',
          shares: '40.0000',
          amount: '66.88',
          confirmedShares: '40.0000',
          confirmedNav: '1.6804',
        },
      ],
    });
    expect(await app.runSettlement()).toMatchObject({ confirmed: 0, pending: 0, failed: 0 });
    expect((await send('DELETE', `/v1/positions/${id}/trades/${trade.id}`)).status).toBe(409);
    expect(await get('/v1/positions/summary')).toMatchObject({
      realizedGain: '6.88',
      totalGain: '17.70',
    });
    expect(await get('/v1/positions/by-fund')).toMatchObject({
      items: [{ realizedGain: '6.88', totalGain: '17.70' }],
    });
  });

  async function buy(id: string, amount = '168.04', extra: Record<string, unknown> = {}) {
    const response = await send('POST', `/v1/positions/${id}/trades`, {
      type: 'buy',
      amount,
      feeRate: '0',
      submittedDate: '2026-11-06',
      beforeCutoff: true,
      ...extra,
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string };
  }

  it('clears only with no pending trades, hides the list entry and retains gains when bought back', async () => {
    const { id } = await position({ shares: '3', totalCost: '1.00' });
    await sell(id, '1', { feeRate: '0' });
    await sell(id, '2', { feeRate: '0' });
    expect(await settle()).toMatchObject({ confirmed: 2, pending: 0, failed: 0 });
    expect(await get(`/v1/positions/${id}`)).toMatchObject({
      shares: '0.0000',
      totalCost: '0.00',
      realizedGain: '4.04',
      realizedGainCost: '1.00',
      isCleared: true,
    });
    expect(await get('/v1/positions')).toMatchObject({ items: [] });
    expect(await get('/v1/positions?includeCleared=false')).toMatchObject({ items: [] });
    expect(await get('/v1/positions?includeCleared=true')).toMatchObject({
      items: [{ id, isCleared: true }],
    });
    expect((await send('GET', '/v1/positions?includeCleared=1')).status).toBe(400);
    expect(await get('/v1/positions/summary')).toMatchObject({
      realizedGain: '4.04',
      totalGain: '4.04',
    });
    expect(await get('/v1/positions/by-fund')).toMatchObject({
      items: [{ realizedGain: '4.04', totalGain: '4.04' }],
    });
    await buy(id);
    expect(await get(`/v1/positions/${id}`)).toMatchObject({ shares: '0.0000', isCleared: false });
    expect(await get('/v1/positions')).toMatchObject({ items: [{ id }] });
    expect(await app.runSettlement()).toMatchObject({ confirmed: 1, pending: 0, failed: 0 });
    expect(await get(`/v1/positions/${id}`)).toMatchObject({
      shares: '100.0000',
      totalCost: '168.04',
      realizedGain: '4.04',
      realizedGainCost: '1.00',
      isCleared: false,
    });
  });

  it('uses the new average cost after a partial sale followed by a buy', async () => {
    const { id } = await position();
    await sell(id);
    await settle();
    await buy(id);
    expect(await app.runSettlement()).toMatchObject({ confirmed: 1, failed: 0 });
    expect(await get(`/v1/positions/${id}`)).toMatchObject({
      shares: '160.0000',
      totalCost: '258.04',
    });
    await sell(id, '80', { submittedDate: '2026-11-06', beforeCutoff: true });
    expect(await app.runSettlement()).toMatchObject({ confirmed: 1, failed: 0 });
    expect(await get(`/v1/positions/${id}`)).toMatchObject({
      shares: '80.0000',
      totalCost: '129.02',
      realizedGain: '11.62',
      realizedGainCost: '189.02',
    });
  });

  it('preserves realized gain, cost basis and pending trades through calibration', async () => {
    const { id } = await position();
    await sell(id);
    await settle();
    const pending = await sell(id, '20', { submittedDate: '2026-11-06', beforeCutoff: true });
    const calibrated = await send('PATCH', `/v1/positions/${id}`, {
      shares: '10',
      totalCost: '20',
    });
    expect(calibrated.status).toBe(200);
    expect(await calibrated.json()).toMatchObject({
      realizedGain: '6.88',
      realizedGainCost: '60.00',
      pendingShares: '20.0000',
      availableShares: '0.0000',
    });
    expect(await get(`/v1/positions/${id}/trades`)).toMatchObject({
      items: [{ status: 'confirmed' }, { id: pending.id, status: 'pending' }],
    });
    now = new Date('2026-11-10T13:30:00Z');
    expect(await app.runSettlement()).toMatchObject({ confirmed: 0, pending: 1, failed: 1 });
    expect(await get(`/v1/positions/${id}`)).toMatchObject({
      shares: '10.0000',
      realizedGain: '6.88',
    });
  });

  it('moves cleared history into 未指定 atomically when deleting a channel', async () => {
    const { id } = await position();
    const second = await position({ fundCode: '040046' });
    await sell(id, '100');
    await sell(second.id, '100', { submittedDate: '2026-11-05', beforeCutoff: true });
    await settle();
    expect((await send('DELETE', `/v1/channels/${channels[0]!.id}`)).status).toBe(204);
    const unspecified = channels.find((channel) => channel.name === '未指定')!;
    expect(await get(`/v1/positions/${id}`)).toMatchObject({
      channelId: unspecified.id,
      realizedGain: '17.20',
    });
    expect(await get(`/v1/positions/${id}/trades`)).toMatchObject({
      items: [{ status: 'confirmed' }],
    });
    expect(
      await get(`/v1/positions?channelId=${unspecified.id}&includeCleared=true`),
    ).toMatchObject({ items: [{ id }, { id: second.id }] });
    const remaining = await get<{ items: { id: string }[] }>('/v1/channels');
    expect(remaining.items.map((channel) => channel.id)).not.toContain(channels[0]!.id);
    expect((await send('GET', `/v1/positions?channelId=${channels[0]!.id}`)).status).toBe(404);
  });

  it('rejects channel deletion on a fund collision and preserves both histories and the channel', async () => {
    const { id } = await position();
    const other = await position({ fundCode: '040046' });
    const target = await position({
      channelId: channels.find((channel) => channel.name === '未指定')!.id,
    });
    await sell(id, '100');
    await sell(other.id, '100', { submittedDate: '2026-11-05', beforeCutoff: true });
    await settle();
    const response = await send('DELETE', `/v1/channels/${channels[0]!.id}`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'channel_position_conflict' } });
    expect(await get(`/v1/positions/${id}`)).toMatchObject({
      channelId: channels[0]!.id,
      realizedGain: '17.20',
    });
    expect(await get(`/v1/positions/${other.id}`)).toMatchObject({ channelId: channels[0]!.id });
    expect(await get(`/v1/positions/${target.id}`)).toMatchObject({
      shares: '100.0000',
      realizedGain: '0.00',
    });
    expect(await get('/v1/channels')).toMatchObject({ items: channels });
  });

  it('blocks deletion with shares or any pending trade, including zero-share pending buys', async () => {
    const { id } = await position();
    expect((await send('DELETE', `/v1/channels/${channels[0]!.id}`)).status).toBe(409);
    await sell(id, '100');
    await settle();
    const pending = await buy(id, '1', { submittedDate: '2026-11-10' });
    const response = await send('DELETE', `/v1/channels/${channels[0]!.id}`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'channel_has_positions' } });
    expect((await send('DELETE', `/v1/positions/${id}/trades/${pending.id}`)).status).toBe(204);
    expect(await get(`/v1/positions/${id}`)).toMatchObject({ isCleared: true });
    expect((await send('DELETE', `/v1/channels/${channels[0]!.id}`)).status).toBe(204);
  });

  function navReplay(price: string, dates = ['2026-11-06', '2026-11-05']): Replay {
    return (url) =>
      url.hostname === 'api.fund.eastmoney.com'
        ? JSON.stringify({
            Data: {
              LSJZList: (url.searchParams.get('pageSize') === '1' ? dates.slice(0, 1) : dates).map(
                (date) => ({ FSRQ: date, DWJZ: price, LJJZ: price, JZZZL: '0' }),
              ),
            },
            ErrCode: 0,
          })
        : eastmoneySamples(url);
  }

  it('aligns the studio reservation example: settled 41454.66 shares no longer reserve the remaining 20727.33', async () => {
    app = makeApp(navReplay('1.0000'));
    const { id } = await position({ shares: '62181.99', totalCost: '62181.99' });
    await sell(id, '41454.66', { feeRate: '0' });
    expect(await get(`/v1/positions/${id}`)).toMatchObject({ availableShares: '20727.3300' });
    await settle();
    expect(await get(`/v1/positions/${id}`)).toMatchObject({
      shares: '20727.3300',
      pendingShares: '0.0000',
      availableShares: '20727.3300',
      realizedGain: '0.00',
    });
    await sell(id, '20727.33', { feeRate: '0', submittedDate: '2026-11-06', beforeCutoff: true });
    expect(await app.runSettlement()).toMatchObject({ confirmed: 1, pending: 0, failed: 0 });
    expect(await get(`/v1/positions/${id}`)).toMatchObject({
      isCleared: true,
      realizedGainCost: '62181.99',
    });
  });

  it.each([
    ['1.2000', '100', '120', '30', '0.005', '35.82', '36.00', '-0.18'],
    ['1.2345', '3', '1', '1.2345', '0.005', '1.52', '0.41', '1.11'],
    ['1.0000', '100', '150', '40', '1', '0.00', '60.00', '-60.00'],
  ])(
    'rounds proceeds and carried cost only at their final cents (NAV %s)',
    async (price, shares, totalCost, sold, feeRate, amount, cost, gain) => {
      app = makeApp(navReplay(price));
      const { id } = await position({ shares, totalCost });
      await sell(id, sold, { feeRate });
      expect(await settle()).toMatchObject({ confirmed: 1, failed: 0 });
      expect(await get(`/v1/positions/${id}`)).toMatchObject({
        realizedGain: gain,
        realizedGainCost: cost,
      });
      expect(await get(`/v1/positions/${id}/trades`)).toMatchObject({ items: [{ amount }] });
    },
  );

  it('serializes concurrent reservations and concurrent confirmation runs', async () => {
    const { id } = await position();
    const responses = await Promise.all(
      [1, 2].map(() =>
        send('POST', `/v1/positions/${id}/trades`, {
          type: 'sell',
          shares: '60',
          feeRate: '0',
        }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    now = new Date('2026-11-10T13:30:00Z');
    const runs = await Promise.all([app.runSettlement(), app.runSettlement()]);
    expect(runs.reduce((sum, run) => sum + run.confirmed, 0)).toBe(1);
    expect(runs.every((run) => run.failed === 0)).toBe(true);
    expect(await get(`/v1/positions/${id}`)).toMatchObject({
      shares: '40.0000',
      realizedGain: '10.82',
      realizedGainCost: '90.00',
    });
  });

  it('confirms mixed buy/sell trades by application date then creation time', async () => {
    app = makeApp(navReplay('1.0000'));
    const { id } = await position({ totalCost: '200' });
    // Created first but applied later: the earlier sell must carry the old average cost.
    await buy(id, '100');
    await sell(id, '50', { feeRate: '0', submittedDate: '2026-11-05', beforeCutoff: true });
    expect(await settle()).toMatchObject({ confirmed: 2, failed: 0 });
    expect(await get(`/v1/positions/${id}`)).toMatchObject({
      shares: '150.0000',
      totalCost: '200.00',
      realizedGain: '-50.00',
      realizedGainCost: '100.00',
    });
    const second = await position({ channelId: channels[1]!.id, totalCost: '200' });
    await buy(second.id, '100');
    await sell(second.id, '50', { feeRate: '0', submittedDate: '2026-11-06', beforeCutoff: true });
    expect(await app.runSettlement()).toMatchObject({ confirmed: 2, failed: 0 });
    expect(await get(`/v1/positions/${second.id}`)).toMatchObject({
      shares: '150.0000',
      totalCost: '225.00',
      realizedGain: '-25.00',
      realizedGainCost: '75.00',
    });
  });

  it('retains an overdue sell without NAV and prevents later same-position trades overtaking it', async () => {
    app = makeApp(navReplay('1.0000', ['2026-11-06']));
    const { id } = await position();
    await sell(id, '50', { feeRate: '0', submittedDate: '2026-11-05', beforeCutoff: true });
    await buy(id, '100');
    expect(await settle()).toMatchObject({ confirmed: 0, pending: 2, failed: 0 });
    expect(await get(`/v1/positions/${id}`)).toMatchObject({
      shares: '100.0000',
      totalCost: '150.00',
      realizedGain: '0.00',
    });
    app = makeApp(navReplay('1.0000'));
    expect(await app.runSettlement()).toMatchObject({ confirmed: 2, pending: 0, failed: 0 });
    expect(await get(`/v1/positions/${id}`)).toMatchObject({
      shares: '150.0000',
      totalCost: '175.00',
      realizedGain: '-25.00',
    });
  });

  it.each([
    { shares: '0' },
    { shares: '-1' },
    { shares: '1.00001' },
    { shares: 1 },
    { shares: '1e2' },
    { shares: '10000000000000000' },
    { feeRate: '-0.1' },
    { feeRate: '1.000001' },
    { feeRate: '0.0000001' },
    { submittedDate: '2026-02-30', beforeCutoff: true },
    { submittedDate: '2026-11-06' },
    { beforeCutoff: 'true' },
    { amount: '1' },
  ])('rejects invalid sell inputs %j without creating history', async (input) => {
    const { id } = await position();
    const response = await send('POST', `/v1/positions/${id}/trades`, {
      type: 'sell',
      shares: '1',
      feeRate: '0',
      ...input,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'validation_error' } });
    expect(await get(`/v1/positions/${id}/trades`)).toMatchObject({ items: [] });
  });

  it('uses the shared cutoff and QDII confirmation rules for sells', async () => {
    app = makeApp(navReplay('1.0000'));
    const { id } = await position({ fundCode: '040046' });
    const response = await send('POST', `/v1/positions/${id}/trades`, {
      type: 'sell',
      shares: '1',
      feeRate: '0',
      submittedDate: '2026-11-06',
      beforeCutoff: false,
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      applicationDate: '2026-11-09',
      settlementDate: '2026-11-11',
    });
    now = new Date('2026-11-11T00:00:00Z');
    expect(await app.runSettlement()).toMatchObject({ confirmed: 0, pending: 1, failed: 0 });
    const trade = (await get<{ items: { id: string }[] }>(`/v1/positions/${id}/trades`)).items[0]!;
    expect((await send('DELETE', `/v1/positions/${id}/trades/${trade.id}`)).status).toBe(409);
  });

  it('sums realized gains across channels and retains known realized gains when NAV becomes unavailable', async () => {
    app = makeApp(navReplay('1.0000'));
    const first = await position();
    const second = await position({ channelId: channels[1]!.id, totalCost: '50' });
    await sell(first.id, '100', { feeRate: '0' });
    await sell(second.id, '50', { feeRate: '0' });
    await settle();
    expect(await get('/v1/positions/summary')).toMatchObject({
      realizedGain: '-25.00',
      holdingGain: '25.00',
      totalGain: '0.00',
    });
    expect(await get('/v1/positions/by-fund')).toMatchObject({
      items: [{ shares: '50.0000', totalCost: '25.00', realizedGain: '-25.00', totalGain: '0.00' }],
    });
    expect(await get(`/v1/positions/summary?channelId=${channels[0]!.id}`)).toMatchObject({
      realizedGain: '-50.00',
      totalGain: '-50.00',
    });
    app = makeApp((url) =>
      url.hostname === 'api.fund.eastmoney.com'
        ? JSON.stringify({ Data: { LSJZList: [] }, ErrCode: 0 })
        : eastmoneySamples(url),
    );
    expect(await get(`/v1/positions/${first.id}`)).toMatchObject({
      realizedGain: '-50.00',
      realizedGainCost: '150.00',
      totalGain: null,
    });
    expect(await get('/v1/positions/summary')).toMatchObject({
      realizedGain: '-25.00',
      totalGain: null,
      valuationComplete: false,
    });
  });

  it('requires authentication and hides another user’s cleared position and sell history', async () => {
    const { id } = await position();
    const trade = await sell(id, '100');
    await settle();
    const own = headers;
    headers = {};
    expect(
      (
        await send('POST', `/v1/positions/${id}/trades`, {
          type: 'sell',
          shares: '1',
          feeRate: '0',
        })
      ).status,
    ).toBe(401);
    const login = await send('POST', '/v1/auth/wechat/login', { code: randomUUID() });
    headers = { Authorization: `Bearer ${((await login.json()) as WeChatLoginResponse).token}` };
    expect(
      (
        await send('POST', `/v1/positions/${id}/trades`, {
          type: 'sell',
          shares: '1',
          feeRate: '0',
        })
      ).status,
    ).toBe(404);
    expect((await send('DELETE', `/v1/positions/${id}/trades/${trade.id}`)).status).toBe(404);
    expect((await send('GET', `/v1/positions/${id}`)).status).toBe(404);
    expect(await get('/v1/positions?includeCleared=true')).toMatchObject({ items: [] });
    headers = own;
    expect(await get(`/v1/positions/${id}`)).toMatchObject({
      isCleared: true,
      realizedGain: '17.20',
    });
  });

  it('counts a cleared position as data when checking login-method conflicts', async () => {
    const code = randomUUID();
    const mini = await send('POST', '/v1/auth/wechat/login', { code });
    headers = { Authorization: `Bearer ${((await mini.json()) as WeChatLoginResponse).token}` };
    channels = (await get<{ items: { id: string; name: string }[] }>('/v1/channels')).items;
    const { id } = await position();
    await sell(id, '100');
    await settle();
    let verification = '';
    app = createApp({
      database: createDb(db.pool),
      clock: { now: () => now },
      wechat: { openid: async (identity) => identity },
      mailer: {
        sendVerificationCode: async (_email, value) => {
          verification = value;
        },
      },
    });
    await send('POST', '/v1/auth/email/request', { email: 'cleared-owner@example.com' });
    const web = await send('POST', '/v1/auth/email/login', {
      email: 'cleared-owner@example.com',
      code: verification,
      device: 'web',
    });
    expect(web.status).toBe(200);
    const cookie = web.headers
      .getSetCookie()
      .find((value) => value.startsWith('bafang_session='))!
      .split(';')[0]!;
    const generated = await app.request('/v1/auth/bind-code', {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(generated.status).toBe(201);
    const bindCode = ((await generated.json()) as { code: string }).code;
    const conflict = await send('POST', '/v1/auth/wechat/bind', { code, bindCode });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: 'login_method_conflict' } });
    expect((await send('GET', '/v1/me')).status).toBe(200);
  });

  it('reserves pending sell shares, rejects excess and releases the reservation on cancellation', async () => {
    const { id } = await position();
    const trade = await sell(id, '60');
    expect(await get(`/v1/positions/${id}`)).toMatchObject({
      shares: '100.0000',
      totalCost: '150.00',
      pendingShares: '60.0000',
      availableShares: '40.0000',
    });
    const excess = await send('POST', `/v1/positions/${id}/trades`, {
      type: 'sell',
      shares: '40.0001',
      feeRate: '0',
    });
    expect(excess.status).toBe(409);
    expect(await excess.json()).toMatchObject({ error: { code: 'insufficient_shares' } });
    expect((await send('DELETE', `/v1/positions/${id}/trades/${trade.id}`)).status).toBe(204);
    await sell(id, '100');
  });
});
