import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../../src/app';
import { createDb } from '../../src/db';
import { ChineseTradingCalendar } from '../../src/trading-calendar';
import type { PositionView } from '../../src/positions/service';
import type { TradeView } from '../../src/positions/trades';
import type { WeChatLoginResponse } from '../../src/routes/auth';
import {
  eastmoneySamples,
  estimateSamples,
  RecordedUpstream,
  sample,
  type Replay,
} from '../support/recorded-upstream';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';

type SwitchView = {
  id: string;
  sourcePositionId: string;
  targetFundCode: string;
  items: TradeView[];
};

describe('同渠道调仓', () => {
  let db: TestSchema;
  let now: Date;
  let app: App;
  let headers: Record<string, string>;
  let channels: { id: string; name: string }[];

  beforeEach(async () => {
    db = await createTestSchema();
    now = new Date('2026-11-06T06:59:59Z');
    app = makeApp();
    const login = await send('POST', '/v1/auth/wechat/login', { code: randomUUID() });
    headers = { Authorization: `Bearer ${((await login.json()) as WeChatLoginResponse).token}` };
    channels = (await get<{ items: { id: string; name: string }[] }>('/v1/channels')).items;
  });
  afterEach(async () => dropTestSchema(db));

  const publishedSamples: Replay = (url) => {
    if (
      url.hostname === 'api.fund.eastmoney.com' &&
      url.searchParams.get('fundCode') === '000001' &&
      url.searchParams.get('pageSize') === '1'
    )
      return sample('eastmoney/nav-000001-latest-2026-11-06.json');
    if (
      url.hostname === 'api.fund.eastmoney.com' &&
      url.searchParams.get('fundCode') === '040046' &&
      url.searchParams.get('pageSize') === '1'
    )
      return sample('eastmoney/nav-040046-latest-2026-11-06.json').replace(
        '2026-11-05',
        '2026-11-06',
      );
    return eastmoneySamples(url);
  };
  function makeApp(replay: Replay = publishedSamples) {
    const estimates = estimateSamples({ nav: replay });
    return createApp({
      database: createDb(db.pool),
      upstream: new RecordedUpstream((url) =>
        ['api.fund.eastmoney.com', 'fundcomapi.tiantianfunds.com', 'hq.sinajs.cn'].includes(
          url.hostname,
        )
          ? estimates(url)
          : replay(url),
      ),
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
  async function get<T>(path: string): Promise<T> {
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
  function submit(id: string, extra: Record<string, unknown> = {}) {
    return send('POST', `/v1/positions/${id}/switches`, {
      targetFundCode: '000001',
      targetChannelId: channels[0]!.id,
      shares: '40',
      outFeeRate: '0.005',
      inFeeRate: '0.0015',
      ...extra,
    });
  }
  async function createSwitch(id: string, extra: Record<string, unknown> = {}) {
    const response = await submit(id, extra);
    expect(response.status).toBe(201);
    return (await response.json()) as SwitchView;
  }

  it('creates linked trades without creating the target position, then confirms net proceeds and incoming shares once', async () => {
    const source = await position();
    const transfer = await createSwitch(source.id);
    expect(transfer).toMatchObject({
      sourcePositionId: source.id,
      targetFundCode: '000001',
      items: [
        {
          type: 'switch_out',
          positionId: source.id,
          switchId: transfer.id,
          shares: '40.0000',
          amount: null,
          applicationDate: '2026-11-06',
          settlementDate: '2026-11-09',
        },
        {
          type: 'switch_in',
          positionId: null,
          switchId: transfer.id,
          amount: null,
          applicationDate: '2026-11-06',
          settlementDate: '2026-11-09',
        },
      ],
    });
    expect((await get<{ items: unknown[] }>('/v1/positions')).items).toHaveLength(1);
    expect(await get(`/v1/positions/${source.id}`)).toMatchObject({
      shares: '100.0000',
      pendingShares: '40.0000',
      availableShares: '60.0000',
    });
    expect(await get(`/v1/switches/${transfer.id}`)).toEqual(transfer);
    now = new Date('2026-11-10T13:30:00Z');
    const result = await app.runSettlement();
    expect(result, JSON.stringify(result)).toMatchObject({ confirmed: 2, pending: 0, failed: 0 });
    const settled = await get<SwitchView>(`/v1/switches/${transfer.id}`);
    expect(settled.items).toMatchObject([
      {
        type: 'switch_out',
        status: 'confirmed',
        amount: '66.88',
        confirmedNav: '1.6804',
        confirmedShares: '40.0000',
      },
      {
        type: 'switch_in',
        status: 'confirmed',
        amount: '66.88',
        confirmedNav: '1.0100',
        confirmedShares: '66.1186',
      },
    ]);
    expect(await get(`/v1/positions/${source.id}`)).toMatchObject({
      shares: '60.0000',
      totalCost: '90.00',
      realizedGain: '6.88',
      realizedGainCost: '60.00',
    });
    expect(await get(`/v1/positions/${settled.items[1]!.positionId}`)).toMatchObject({
      fundCode: '000001',
      channelId: channels[0]!.id,
      shares: '66.1186',
      totalCost: '66.88',
    });
    expect(await app.runSettlement()).toMatchObject({ confirmed: 0, pending: 0, failed: 0 });
    expect(await get(`/v1/positions/${settled.items[1]!.positionId}/trades`)).toMatchObject({
      items: [{ switchId: transfer.id }],
    });
  });
  it.each([
    [{ targetChannelId: 'other' }, 400, 'validation_error'],
    [{ targetFundCode: '110020' }, 400, 'validation_error'],
    [{ shares: '100.0001' }, 409, 'insufficient_shares'],
    [{ shares: '0' }, 400, 'validation_error'],
    [{ shares: '1.00001' }, 400, 'validation_error'],
    [{ outFeeRate: '1.1' }, 400, 'validation_error'],
    [{ inFeeRate: '-0.01' }, 400, 'validation_error'],
    [{ submittedDate: '2026-11-05' }, 400, 'validation_error'],
    [{ targetFundCode: '999999' }, 404, 'fund_not_found'],
  ])('rejects invalid switches atomically (%j)', async (extra, status, code) => {
    const source = await position();
    const response = await submit(source.id, {
      ...extra,
      ...('targetChannelId' in extra && extra.targetChannelId === 'other'
        ? { targetChannelId: channels[1]!.id }
        : {}),
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
    expect(await get(`/v1/positions/${source.id}/trades`)).toEqual({ items: [] });
    expect(await get(`/v1/positions/${source.id}`)).toMatchObject({ availableShares: '100.0000' });
  });

  it.each(['out', 'in', 'uncreated target'])(
    'cancels both pending legs from the %s side and releases reservations',
    async (side) => {
      const source = await position();
      if (side !== 'uncreated target') await position({ fundCode: '000001' });
      const transfer = await createSwitch(source.id);
      const leg = transfer.items[side === 'out' ? 0 : 1]!;
      const path = leg.positionId
        ? `/v1/positions/${leg.positionId}/trades/${leg.id}`
        : `/v1/switches/${transfer.id}/trades/${leg.id}`;
      expect((await send('DELETE', path)).status).toBe(204);
      expect((await send('GET', `/v1/switches/${transfer.id}`)).status).toBe(404);
      expect(await get(`/v1/positions/${source.id}/trades`)).toEqual({ items: [] });
      expect(await get(`/v1/positions/${source.id}`)).toMatchObject({
        availableShares: '100.0000',
      });
      if (leg.positionId && side === 'in')
        expect(await get(`/v1/positions/${leg.positionId}/trades`)).toEqual({ items: [] });
    },
  );

  it('retains proceeds in transit when target NAV is missing, then creates the target on retry', async () => {
    const source = await position();
    const transfer = await createSwitch(source.id, { shares: '100' });
    app = makeApp((url) => {
      if (
        url.hostname === 'api.fund.eastmoney.com' &&
        url.searchParams.get('fundCode') === '000001' &&
        url.searchParams.get('pageSize') === '20'
      )
        return JSON.stringify({ Data: { LSJZList: [] }, ErrCode: 0 });
      return eastmoneySamples(url);
    });
    now = new Date('2026-11-09T13:30:00Z');
    expect(await app.runSettlement()).toMatchObject({
      confirmed: 1,
      pending: 1,
      failed: 0,
      failures: [],
    });
    expect(await get(`/v1/switches/${transfer.id}`)).toMatchObject({
      items: [
        { status: 'confirmed', amount: '167.20' },
        { status: 'pending', amount: '167.20', positionId: null },
      ],
    });
    expect(await get(`/v1/positions/${source.id}`)).toMatchObject({
      shares: '0.0000',
      totalCost: '0.00',
      isCleared: false,
    });
    expect((await get<{ items: unknown[] }>('/v1/positions')).items).toHaveLength(1);
    expect((await send('DELETE', `/v1/channels/${channels[0]!.id}`)).status).toBe(409);
    for (const leg of transfer.items)
      expect((await send('DELETE', `/v1/switches/${transfer.id}/trades/${leg.id}`)).status).toBe(
        409,
      );
    app = makeApp();
    expect(await app.runSettlement()).toMatchObject({ confirmed: 1, pending: 0, failed: 0 });
    expect(await get(`/v1/positions/${source.id}`)).toMatchObject({ isCleared: true });
  });

  it('does not confirm incoming before the outgoing T+N date even with target NAV available', async () => {
    const source = await position({ fundCode: '040046' });
    const transfer = await createSwitch(source.id);
    expect(transfer.items).toMatchObject([
      { settlementDate: '2026-11-10' },
      { settlementDate: '2026-11-09' },
    ]);
    now = new Date('2026-11-09T13:30:00Z');
    expect(await app.runSettlement()).toMatchObject({ confirmed: 0, pending: 2, failed: 0 });
    expect((await get<{ items: unknown[] }>('/v1/positions')).items).toHaveLength(1);
    expect(
      (await send('DELETE', `/v1/positions/${source.id}/trades/${transfer.items[0]!.id}`)).status,
    ).toBe(409);
    now = new Date('2026-11-10T13:30:00Z');
    const result = await app.runSettlement();
    expect(result, JSON.stringify(result)).toMatchObject({ confirmed: 2, pending: 0, failed: 0 });
  });

  it('keeps incoming pending until its own later T+N date and exposes pending amount on an existing target', async () => {
    const source = await position();
    const target = await position({ fundCode: '040046', shares: '10', totalCost: '20' });
    const transfer = await createSwitch(source.id, { targetFundCode: '040046' });
    now = new Date('2026-11-09T13:30:00Z');
    expect(await app.runSettlement()).toMatchObject({
      confirmed: 1,
      pending: 1,
      failed: 0,
      failures: [],
    });
    expect(await get(`/v1/positions/${target.id}`)).toMatchObject({
      shares: '10.0000',
      totalCost: '20.00',
      pendingAmount: '66.88',
    });
    now = new Date('2026-11-10T13:30:00Z');
    expect(await app.runSettlement()).toMatchObject({ confirmed: 1, pending: 0, failed: 0 });
    expect(await get(`/v1/positions/${target.id}`)).toMatchObject({
      totalCost: '86.88',
      pendingAmount: '0.00',
    });
    expect((await get<SwitchView>(`/v1/switches/${transfer.id}`)).items[1]!.positionId).toBe(
      target.id,
    );
  });

  it('leaves both pending after insufficient calibrated shares, then reuses a target created after submission', async () => {
    const source = await position();
    const transfer = await createSwitch(source.id);
    expect(
      (await send('PATCH', `/v1/positions/${source.id}`, { shares: '10', totalCost: '15' })).status,
    ).toBe(200);
    now = new Date('2026-11-10T13:30:00Z');
    expect(await app.runSettlement()).toMatchObject({ confirmed: 0, pending: 2, failed: 1 });
    expect((await get<{ items: unknown[] }>('/v1/positions')).items).toHaveLength(1);
    const target = await position({ fundCode: '000001', shares: '5', totalCost: '5' });
    expect(
      (await send('PATCH', `/v1/positions/${source.id}`, { shares: '100', totalCost: '150' }))
        .status,
    ).toBe(200);
    const result = await app.runSettlement();
    expect(result, JSON.stringify(result)).toMatchObject({ confirmed: 2, pending: 0, failed: 0 });
    expect(await get(`/v1/positions/${target.id}`)).toMatchObject({
      shares: '71.1186',
      totalCost: '71.88',
    });
    expect((await get<SwitchView>(`/v1/switches/${transfer.id}`)).items[1]!.positionId).toBe(
      target.id,
    );
  });

  it('serializes competing sell and switch reservations and concurrent confirmation runs', async () => {
    const source = await position();
    const attempts = await Promise.all([
      submit(source.id, { shares: '70' }),
      send('POST', `/v1/positions/${source.id}/trades`, {
        type: 'sell',
        shares: '70',
        feeRate: '0',
      }),
    ]);
    expect(attempts.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await get(`/v1/positions/${source.id}`)).toMatchObject({
      pendingShares: '70.0000',
      availableShares: '30.0000',
    });
    now = new Date('2026-11-10T13:30:00Z');
    const results = await Promise.all([app.runSettlement(), app.runSettlement()]);
    expect(results.every((result) => result.failed === 0)).toBe(true);
    expect(await get(`/v1/positions/${source.id}`)).toMatchObject({
      shares: '30.0000',
      totalCost: '45.00',
    });
  });

  it('scopes creation, lookup and cancellation to the authenticated user', async () => {
    const source = await position();
    const transfer = await createSwitch(source.id);
    const owner = headers;
    headers = {};
    expect((await send('GET', `/v1/switches/${transfer.id}`)).status).toBe(401);
    const other = await send('POST', '/v1/auth/wechat/login', { code: randomUUID() });
    headers = { Authorization: `Bearer ${((await other.json()) as WeChatLoginResponse).token}` };
    expect((await submit(source.id)).status).toBe(404);
    expect((await send('GET', `/v1/switches/${transfer.id}`)).status).toBe(404);
    expect(
      (await send('DELETE', `/v1/switches/${transfer.id}/trades/${transfer.items[1]!.id}`)).status,
    ).toBe(404);
    const otherChannels = await get<{ items: { id: string }[] }>('/v1/channels');
    headers = owner;
    expect((await submit(source.id, { targetChannelId: otherChannels.items[0]!.id })).status).toBe(
      404,
    );
    expect(
      (await send('DELETE', `/v1/switches/${transfer.id}/trades/${randomUUID()}`)).status,
    ).toBe(404);
    expect((await get<SwitchView>(`/v1/switches/${transfer.id}`)).items).toHaveLength(2);
  });

  it.each(['source', 'target'])(
    'deleting the %s position removes both linked trades',
    async (side) => {
      const source = await position();
      const target = await position({ fundCode: '000001' });
      const transfer = await createSwitch(source.id);
      expect(
        (await send('DELETE', `/v1/positions/${side === 'source' ? source.id : target.id}`)).status,
      ).toBe(204);
      expect((await send('GET', `/v1/switches/${transfer.id}`)).status).toBe(404);
      expect(
        await get(`/v1/positions/${side === 'source' ? target.id : source.id}/trades`),
      ).toEqual({ items: [] });
    },
  );

  it('confirms zero proceeds from a 100% outgoing fee without leaving an unfinishable incoming leg', async () => {
    const source = await position();
    const transfer = await createSwitch(source.id, { outFeeRate: '1' });
    now = new Date('2026-11-10T13:30:00Z');
    const result = await app.runSettlement();
    expect(result, JSON.stringify(result)).toMatchObject({ confirmed: 2, pending: 0, failed: 0 });
    expect((await get<SwitchView>(`/v1/switches/${transfer.id}`)).items).toMatchObject([
      { status: 'confirmed', amount: '0.00' },
      { status: 'confirmed', amount: '0.00', confirmedShares: '0.0000' },
    ]);
  });
  it('keeps both legs and later target trades pending when outgoing NAV has not been published', async () => {
    const source = await position();
    const target = await position({ fundCode: '000001' });
    const transfer = await createSwitch(source.id);
    expect(
      (
        await send('POST', `/v1/positions/${target.id}/trades`, {
          type: 'buy',
          amount: '10',
          feeRate: '0',
        })
      ).status,
    ).toBe(201);
    app = makeApp((url) => {
      if (
        url.hostname === 'api.fund.eastmoney.com' &&
        url.searchParams.get('fundCode') === '110020'
      ) {
        return url.searchParams.get('pageSize') === '1'
          ? sample('eastmoney/nav-110020-latest-2026-11-06.json').replace(
              '2026-11-06',
              '2026-11-05',
            )
          : JSON.stringify({ Data: { LSJZList: [] }, ErrCode: 0 });
      }
      return publishedSamples(url);
    });
    now = new Date('2026-11-10T13:30:00Z');
    expect(await app.runSettlement()).toMatchObject({ confirmed: 0, pending: 3, failed: 0 });
    expect(await get(`/v1/switches/${transfer.id}`)).toMatchObject({
      items: [
        { status: 'pending', amount: null },
        { status: 'pending', amount: null },
      ],
    });
    expect(await get(`/v1/positions/${source.id}`)).toMatchObject({
      shares: '100.0000',
      totalCost: '150.00',
    });
    expect(await get(`/v1/positions/${target.id}`)).toMatchObject({
      shares: '100.0000',
      totalCost: '150.00',
    });
  });

  it('confirms multiple switches to one missing target once across concurrent job runs', async () => {
    const source = await position();
    await Promise.all([createSwitch(source.id), createSwitch(source.id)]);
    now = new Date('2026-11-10T13:30:00Z');
    const summaries = await Promise.all([app.runSettlement(), app.runSettlement()]);
    expect(summaries.reduce((sum, item) => sum + item.confirmed, 0)).toBe(4);
    expect(summaries.every((item) => item.failed === 0)).toBe(true);
    const list = await get<{ items: { fundCode: string; shares: string; totalCost: string }[] }>(
      '/v1/positions',
    );
    expect(list.items).toHaveLength(2);
    expect(list.items.find((item) => item.fundCode === '000001')).toMatchObject({
      shares: '132.2372',
      totalCost: '133.76',
    });
    expect(await get(`/v1/positions/${source.id}`)).toMatchObject({
      shares: '20.0000',
      totalCost: '30.00',
    });
  });

  it('uses remaining confirmed shares after an earlier sell has settled', async () => {
    const source = await position();
    expect(
      (
        await send('POST', `/v1/positions/${source.id}/trades`, {
          type: 'sell',
          shares: '60',
          feeRate: '0',
        })
      ).status,
    ).toBe(201);
    await createSwitch(source.id);
    now = new Date('2026-11-10T13:30:00Z');
    expect(await app.runSettlement()).toMatchObject({ confirmed: 3, pending: 0, failed: 0 });
    expect(await get(`/v1/positions/${source.id}`)).toMatchObject({
      shares: '0.0000',
      totalCost: '0.00',
      realizedGainCost: '150.00',
      isCleared: true,
    });
  });
  it.each([
    ['2026-11-06T06:59:59Z', '2026-11-06T07:00:01Z', true],
    ['2026-11-06T15:59:59Z', '2026-11-06T16:00:01Z', false],
  ])(
    'keeps submission date and cutoff while fund lookups cross a boundary (%s)',
    async (submitted, completed, beforeCutoff) => {
      const source = await position();
      now = new Date(submitted);
      app = makeApp((url) => {
        if (
          url.hostname === 'fundmobapi.eastmoney.com' &&
          url.searchParams.get('FCODE') === '000001'
        ) {
          now = new Date(completed);
        }
        return publishedSamples(url);
      });
      const transfer = await createSwitch(source.id);
      expect(transfer.items).toMatchObject([
        {
          submittedDate: '2026-11-06',
          beforeCutoff,
          applicationDate: beforeCutoff ? '2026-11-06' : '2026-11-09',
          settlementDate: beforeCutoff ? '2026-11-09' : '2026-11-10',
        },
        {
          submittedDate: '2026-11-06',
          beforeCutoff,
          applicationDate: beforeCutoff ? '2026-11-06' : '2026-11-09',
          settlementDate: beforeCutoff ? '2026-11-09' : '2026-11-10',
        },
      ]);
    },
  );
  it.each(['before submission', 'after submission', 'after outgoing confirmation'])(
    'associates an incoming trade with a target created %s throughout its pending lifecycle',
    async (timing) => {
      const source = await position();
      let target =
        timing === 'before submission'
          ? await position({ fundCode: '040046', shares: '10', totalCost: '20' })
          : undefined;
      const transfer = await createSwitch(source.id, { targetFundCode: '040046' });
      if (timing === 'after submission')
        target = await position({ fundCode: '040046', shares: '10', totalCost: '20' });
      now = new Date('2026-11-09T13:30:00Z');
      expect(await app.runSettlement()).toMatchObject({ confirmed: 1, pending: 1, failed: 0 });
      if (!target) target = await position({ fundCode: '040046', shares: '10', totalCost: '20' });
      const incoming = transfer.items[1]!;
      expect(await get(`/v1/positions/${target.id}`)).toMatchObject({
        pendingAmount: '66.88',
        shares: '10.0000',
        totalCost: '20.00',
      });
      expect(await get(`/v1/positions/${target.id}/trades`)).toMatchObject({
        items: [
          {
            id: incoming.id,
            positionId: target.id,
            switchId: transfer.id,
            amount: '66.88',
            status: 'pending',
          },
        ],
      });
      expect((await get<SwitchView>(`/v1/switches/${transfer.id}`)).items[1]).toMatchObject({
        positionId: target.id,
      });
      const calibrated = await send('PATCH', `/v1/positions/${target.id}`, {
        shares: '0',
        totalCost: '0',
      });
      expect(calibrated.status).toBe(200);
      expect(await calibrated.json()).toMatchObject({ isCleared: false, pendingAmount: '66.88' });
      expect(
        (await get<{ items: PositionView[] }>('/v1/positions')).items.some(
          (item) => item.id === target.id,
        ),
      ).toBe(true);
      expect((await send('DELETE', `/v1/positions/${target.id}`)).status).toBe(204);
      expect((await send('GET', `/v1/switches/${transfer.id}`)).status).toBe(404);
      expect(await get(`/v1/positions/${source.id}/trades`)).toEqual({ items: [] });
      now = new Date('2026-11-10T13:30:00Z');
      expect(await app.runSettlement()).toMatchObject({ confirmed: 0, pending: 0, failed: 0 });
      expect(
        (await get<{ items: PositionView[] }>('/v1/positions?includeCleared=true')).items.some(
          (item) => item.fundCode === '040046',
        ),
      ).toBe(false);
    },
  );

  it('removes a late-created target and its pending switch without resurrecting it on settlement', async () => {
    const source = await position();
    const transfer = await createSwitch(source.id, { targetFundCode: '040046' });
    const target = await position({ fundCode: '040046' });
    expect((await send('DELETE', `/v1/positions/${target.id}`)).status).toBe(204);
    now = new Date('2026-11-10T13:30:00Z');
    expect(await app.runSettlement()).toMatchObject({ confirmed: 0, pending: 0, failed: 0 });
    expect((await send('GET', `/v1/switches/${transfer.id}`)).status).toBe(404);
    expect(
      (await get<{ items: PositionView[] }>('/v1/positions?includeCleared=true')).items.map(
        (item) => item.id,
      ),
    ).toEqual([source.id]);
  });
  it('links late-created targets atomically with concurrent switch creation and supports cancellation from their history', async () => {
    const source = await position();
    const [transfer, target] = await Promise.all([
      createSwitch(source.id, { targetFundCode: '040046' }),
      position({ fundCode: '040046' }),
    ]);
    expect(await get(`/v1/positions/${target.id}/trades`)).toMatchObject({
      items: [{ id: transfer.items[1]!.id, positionId: target.id, switchId: transfer.id }],
    });
    expect(
      (await send('DELETE', `/v1/positions/${target.id}/trades/${transfer.items[1]!.id}`)).status,
    ).toBe(204);
    expect((await send('GET', `/v1/switches/${transfer.id}`)).status).toBe(404);
    expect(await get(`/v1/positions/${source.id}`)).toMatchObject({ availableShares: '100.0000' });
  });
  it('links all waiting incoming trades when settlement creates their shared target', async () => {
    const firstSource = await position();
    const secondSource = await position({ fundCode: '040046' });
    const first = await createSwitch(firstSource.id);
    const second = await createSwitch(secondSource.id);
    now = new Date('2026-11-09T13:30:00Z');
    expect(await app.runSettlement()).toMatchObject({ confirmed: 2, pending: 2, failed: 0 });
    const target = (await get<{ items: PositionView[] }>('/v1/positions')).items.find(
      (item) => item.fundCode === '000001',
    )!;
    const history = await get<{ items: TradeView[] }>(`/v1/positions/${target.id}/trades`);
    expect(history.items).toHaveLength(2);
    expect(history.items.find((item) => item.switchId === second.id)).toMatchObject({
      positionId: target.id,
      status: 'pending',
    });
    expect((await send('DELETE', `/v1/positions/${target.id}`)).status).toBe(204);
    expect((await send('GET', `/v1/switches/${first.id}`)).status).toBe(404);
    expect((await send('GET', `/v1/switches/${second.id}`)).status).toBe(404);
    now = new Date('2026-11-10T13:30:00Z');
    expect(await app.runSettlement()).toMatchObject({ confirmed: 0, pending: 0, failed: 0 });
  });
});
