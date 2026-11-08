import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App, type AppDeps } from '../../src/app';
import { createDb } from '../../src/db';
import type { EmailLoginResponse } from '../../src/routes/auth';
import { UpstreamError } from '../../src/market/upstream';
import {
  eastmoneySamples,
  RecordedUpstream,
  sample,
  type Replay,
} from '../support/recorded-upstream';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';

interface PositionBody {
  id: string;
  fundCode: string;
  channelId: string;
  shares: string;
  totalCost: string;
  unitPrice: string | null;
  snapshotDate: string;
  nav: string | null;
  navDate: string | null;
  marketValue: string | null;
  holdingGain: string | null;
  holdingGainRate: string | null;
}

type Headers = Record<string, string>;

// 2026-11-06 10:00 Asia/Shanghai；录制样本里 110020 最新净值 1.6804（2026-11-06），000001 为 1.0000（2026-11-05）。
const clock = { now: () => new Date('2026-11-06T02:00:00Z') };

/** 000001 的基金信息照常，但净值接口返回空列表（基金暂无净值）。 */
const noNavFor000001: Replay = (url) =>
  url.hostname === 'api.fund.eastmoney.com' && url.searchParams.get('fundCode') === '000001'
    ? sample('eastmoney/nav-999999-latest.json')
    : eastmoneySamples(url);

describe('持仓：建仓快照、校准与持有收益', () => {
  let db: TestSchema;
  let code = '';

  beforeEach(async () => {
    db = await createTestSchema();
    code = '';
  });
  afterEach(async () => dropTestSchema(db));

  function makeApp(replay: Replay = eastmoneySamples, extra: AppDeps = {}): App {
    return createApp({
      database: createDb(db.pool),
      upstream: new RecordedUpstream(replay),
      clock,
      mailer: {
        async sendVerificationCode(_email, sentCode) {
          code = sentCode;
        },
      },
      ...extra,
    });
  }

  async function login(app: App): Promise<Headers> {
    const email = `position-${randomUUID()}@example.com`;
    await app.request('/v1/auth/email/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const response = await app.request('/v1/auth/email/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code, device: 'miniprogram' }),
    });
    expect(response.status).toBe(200);
    return { Authorization: `Bearer ${((await response.json()) as EmailLoginResponse).token}` };
  }

  async function channelIds(app: App, headers: Headers): Promise<string[]> {
    const response = await app.request('/v1/channels', { headers });
    return ((await response.json()) as { items: { id: string }[] }).items.map((item) => item.id);
  }

  function send(app: App, headers: Headers, method: string, path: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function create(app: App, headers: Headers, body: Record<string, unknown>) {
    return send(app, headers, 'POST', '/v1/positions', body);
  }

  async function errorCode(response: Response): Promise<string> {
    return ((await response.json()) as { error: { code: string } }).error.code;
  }

  it('requires login', async () => {
    const app = makeApp();
    expect((await app.request('/v1/positions')).status).toBe(401);
    expect((await app.request(`/v1/positions/${randomUUID()}`)).status).toBe(401);
  });

  it('creates from total cost, derives unit price, and values with the latest NAV', async () => {
    const app = makeApp();
    const headers = await login(app);
    const [channelId] = await channelIds(app, headers);
    const response = await create(app, headers, {
      fundCode: '110020',
      channelId,
      shares: '1000',
      totalCost: '1500',
      snapshotDate: '2026-11-01',
    });
    expect(response.status).toBe(201);
    const position = (await response.json()) as PositionBody;
    expect(position).toMatchObject({
      fundCode: '110020',
      channelId,
      shares: '1000.0000',
      totalCost: '1500.00',
      unitPrice: '1.5000',
      snapshotDate: '2026-11-01',
      nav: '1.6804',
      navDate: '2026-11-06',
      marketValue: '1680.40',
      holdingGain: '180.40',
      // 180.40 ÷ 1500.00 = 0.120266… → 0.1203
      holdingGainRate: '0.1203',
    });
    const detail = await app.request(`/v1/positions/${position.id}`, { headers });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual(position);
  });

  it('defaults the snapshot date to today in Shanghai', async () => {
    const app = makeApp();
    const headers = await login(app);
    const [channelId] = await channelIds(app, headers);
    const response = await create(app, headers, {
      fundCode: '110020',
      channelId,
      shares: '1',
      totalCost: '1',
    });
    expect(((await response.json()) as PositionBody).snapshotDate).toBe('2026-11-06');
  });

  it('converts between unit price and total cost with half-up rounding at the boundary', async () => {
    const app = makeApp();
    const headers = await login(app);
    const [first, second, third] = await channelIds(app, headers);
    const cases: [string, Record<string, string>, Partial<PositionBody>][] = [
      // 1 × 2.3450 = 2.345 → 2.35（四舍五入；银行家舍入会得到 2.34）
      [first!, { shares: '1', unitPrice: '2.3450' }, { totalCost: '2.35', unitPrice: '2.3500' }],
      // 1 × 2.3449 = 2.3449 → 2.34
      [second!, { shares: '1', unitPrice: '2.3449' }, { totalCost: '2.34', unitPrice: '2.3400' }],
      // 1.00 ÷ 32 = 0.03125 → 0.0313
      [third!, { shares: '32', totalCost: '1.00' }, { totalCost: '1.00', unitPrice: '0.0313' }],
    ];
    for (const [channelId, cost, expected] of cases) {
      const response = await create(app, headers, { fundCode: '110020', channelId, ...cost });
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject(expected);
    }
    // 份额 × 单价 = 3 × 2.3456 = 7.0368 → 7.04；市值 3 × 1.0000；收益率 −4.04 ÷ 7.04 = −0.57386… → −0.5739
    const negative = await create(app, headers, {
      fundCode: '000001',
      channelId: first,
      shares: '3.0000',
      unitPrice: '2.3456',
    });
    expect(await negative.json()).toMatchObject({
      totalCost: '7.04',
      marketValue: '3.00',
      holdingGain: '-4.04',
      holdingGainRate: '-0.5739',
    });
  });

  it('rejects invalid amounts with validation_error', async () => {
    const app = makeApp();
    const headers = await login(app);
    const [channelId] = await channelIds(app, headers);
    const invalid: Record<string, unknown>[] = [
      { shares: '1', totalCost: '1.00', unitPrice: '1.0000' },
      { shares: '1' },
      { shares: 1, totalCost: '1.00' },
      { shares: '1', totalCost: 1 },
      { shares: '1.00001', totalCost: '1.00' },
      { shares: '1', totalCost: '1.001' },
      { shares: '1', unitPrice: '1.00001' },
      { shares: '-1', totalCost: '1.00' },
      { shares: '0', totalCost: '0' },
      { shares: '1', totalCost: '1.00', snapshotDate: '2026-02-30' },
      { shares: '1e3', totalCost: '1.00' },
    ];
    for (const body of invalid) {
      const response = await create(app, headers, { fundCode: '110020', channelId, ...body });
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await errorCode(response)).toBe('validation_error');
    }
    const badFundCode = await create(app, headers, {
      fundCode: '11002',
      channelId,
      shares: '1',
      totalCost: '1',
    });
    expect(badFundCode.status).toBe(400);
    expect(await (await app.request('/v1/positions', { headers })).json()).toEqual({ items: [] });
  });

  it('rejects unknown funds and channels that are not the user’s', async () => {
    const app = makeApp();
    const headers = await login(app);
    const [channelId] = await channelIds(app, headers);
    const unknownFund = await create(app, headers, {
      fundCode: '999999',
      channelId,
      shares: '1',
      totalCost: '1',
    });
    expect(unknownFund.status).toBe(404);
    expect(await errorCode(unknownFund)).toBe('fund_not_found');

    const other = await login(app);
    const [otherChannel] = await channelIds(app, other);
    const foreignChannel = await create(app, headers, {
      fundCode: '110020',
      channelId: otherChannel,
      shares: '1',
      totalCost: '1',
    });
    expect(foreignChannel.status).toBe(404);
    expect(await errorCode(foreignChannel)).toBe('not_found');
  });

  it('reports upstream failure when the fund cannot be checked', async () => {
    const app = makeApp(() => new UpstreamError('timeout', 'recorded timeout'));
    const headers = await login(app);
    const [channelId] = await channelIds(app, headers);
    const response = await create(app, headers, {
      fundCode: '110020',
      channelId,
      shares: '1',
      totalCost: '1',
    });
    expect(response.status).toBe(502);
    expect(await errorCode(response)).toBe('upstream_unavailable');
  });

  it('returns null valuation instead of zero when the fund has no NAV or NAV is unavailable', async () => {
    const app = makeApp(noNavFor000001);
    const headers = await login(app);
    const [channelId] = await channelIds(app, headers);
    const response = await create(app, headers, {
      fundCode: '000001',
      channelId,
      shares: '10',
      totalCost: '12.34',
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      shares: '10.0000',
      totalCost: '12.34',
      unitPrice: '1.2340',
      nav: null,
      navDate: null,
      marketValue: null,
      holdingGain: null,
      holdingGainRate: null,
    });

    // 净值接口整体不可用时，列表仍返回持仓本身。
    const created = await create(makeApp(), headers, {
      fundCode: '110020',
      channelId,
      shares: '1',
      totalCost: '1',
    });
    expect(created.status).toBe(201);
    const fresh = makeApp(() => new UpstreamError('timeout', 'recorded timeout'));
    const list = await fresh.request('/v1/positions', { headers });
    expect(list.status).toBe(200);
    const items = ((await list.json()) as { items: PositionBody[] }).items;
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item).toMatchObject({ nav: null, marketValue: null, holdingGain: null });
    }
  });

  it('reports a null gain rate when total cost is zero', async () => {
    const app = makeApp();
    const headers = await login(app);
    const [channelId] = await channelIds(app, headers);
    const response = await create(app, headers, {
      fundCode: '110020',
      channelId,
      shares: '10',
      unitPrice: '0',
    });
    expect(await response.json()).toMatchObject({
      totalCost: '0.00',
      marketValue: '16.80',
      holdingGain: '16.80',
      holdingGainRate: null,
    });
  });

  it('enforces one position per user, fund and channel, including under concurrency', async () => {
    const app = makeApp();
    const headers = await login(app);
    const [first, second, third] = await channelIds(app, headers);
    const body = { fundCode: '110020', shares: '1', totalCost: '1' };
    expect((await create(app, headers, { ...body, channelId: first })).status).toBe(201);
    const duplicate = await create(app, headers, { ...body, channelId: first, shares: '2' });
    expect(duplicate.status).toBe(409);
    expect(await errorCode(duplicate)).toBe('position_exists');
    // 不同渠道可以各持有同一只基金。
    expect((await create(app, headers, { ...body, channelId: second })).status).toBe(201);
    // 别的用户也可以在自己的渠道持有同一只基金。
    const other = await login(app);
    const [otherChannel] = await channelIds(app, other);
    expect((await create(app, other, { ...body, channelId: otherChannel })).status).toBe(201);

    const statuses = await Promise.all(
      Array.from({ length: 4 }, () =>
        create(app, headers, { ...body, channelId: third }).then((response) => response.status),
      ),
    );
    expect(statuses.sort()).toEqual([201, 409, 409, 409]);
    const list = await app.request(`/v1/positions?channelId=${third}`, { headers });
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(1);
  });

  it('filters the list by channel and only shows the user’s own positions', async () => {
    const app = makeApp();
    const headers = await login(app);
    const [first, second, third] = await channelIds(app, headers);
    const a = (await (
      await create(app, headers, {
        fundCode: '110020',
        channelId: first,
        shares: '1',
        totalCost: '1',
      })
    ).json()) as PositionBody;
    const b = (await (
      await create(app, headers, {
        fundCode: '000001',
        channelId: first,
        shares: '1',
        totalCost: '1',
      })
    ).json()) as PositionBody;
    const c = (await (
      await create(app, headers, {
        fundCode: '110020',
        channelId: second,
        shares: '1',
        totalCost: '1',
      })
    ).json()) as PositionBody;
    const ids = async (path: string, as: Headers = headers) =>
      (
        (await (await app.request(path, { headers: as })).json()) as { items: PositionBody[] }
      ).items.map((item) => item.id);
    expect(await ids('/v1/positions')).toEqual([a.id, b.id, c.id]);
    expect(await ids(`/v1/positions?channelId=${first}`)).toEqual([a.id, b.id]);
    expect(await ids(`/v1/positions?channelId=${second}`)).toEqual([c.id]);
    expect(await ids(`/v1/positions?channelId=${third}`)).toEqual([]);
    expect((await app.request('/v1/positions?channelId=nope', { headers })).status).toBe(400);

    const other = await login(app);
    expect(await ids('/v1/positions', other)).toEqual([]);
    // 别人的渠道与不存在的渠道都返回 404，不暴露为空列表。
    for (const [path, as] of [
      [`/v1/positions?channelId=${first}`, other],
      [`/v1/positions?channelId=${randomUUID()}`, headers],
    ] as const) {
      const response = await app.request(path, { headers: as });
      expect(response.status).toBe(404);
      expect(await errorCode(response)).toBe('not_found');
    }
  });

  it('calibrates by overwriting shares and cost, keeping snapshot identity', async () => {
    const app = makeApp();
    const headers = await login(app);
    const [channelId] = await channelIds(app, headers);
    const created = (await (
      await create(app, headers, {
        fundCode: '110020',
        channelId,
        shares: '2',
        totalCost: '4.00',
        snapshotDate: '2026-11-01',
      })
    ).json()) as PositionBody;
    const byPrice = await send(app, headers, 'PATCH', `/v1/positions/${created.id}`, {
      shares: '1.0000',
      unitPrice: '3.0000',
    });
    expect(byPrice.status).toBe(200);
    expect(await byPrice.json()).toMatchObject({
      id: created.id,
      fundCode: '110020',
      channelId,
      snapshotDate: '2026-11-01',
      shares: '1.0000',
      totalCost: '3.00',
      unitPrice: '3.0000',
      marketValue: '1.68',
      holdingGain: '-1.32',
      holdingGainRate: '-0.4400',
    });
    const byCost = await send(app, headers, 'PATCH', `/v1/positions/${created.id}`, {
      shares: '100',
      totalCost: '150.5',
    });
    expect(await byCost.json()).toMatchObject({ shares: '100.0000', totalCost: '150.50' });
    const detail = await app.request(`/v1/positions/${created.id}`, { headers });
    expect(await detail.json()).toMatchObject({ shares: '100.0000', totalCost: '150.50' });

    // 校准到 0 份即已清仓：持仓仍保留，成本单价为 null。
    const cleared = await send(app, headers, 'PATCH', `/v1/positions/${created.id}`, {
      shares: '0',
      totalCost: '0',
    });
    expect(await cleared.json()).toMatchObject({
      shares: '0.0000',
      totalCost: '0.00',
      unitPrice: null,
      marketValue: '0.00',
      holdingGainRate: null,
    });

    const invalid = await send(app, headers, 'PATCH', `/v1/positions/${created.id}`, {
      shares: '1',
    });
    expect(invalid.status).toBe(400);
    expect(await errorCode(invalid)).toBe('validation_error');
  });

  it('treats other users’ positions as not found for detail, calibration and deletion', async () => {
    const app = makeApp();
    const owner = await login(app);
    const [channelId] = await channelIds(app, owner);
    const created = (await (
      await create(app, owner, { fundCode: '110020', channelId, shares: '1', totalCost: '1' })
    ).json()) as PositionBody;
    const intruder = await login(app);
    const path = `/v1/positions/${created.id}`;
    for (const response of [
      await app.request(path, { headers: intruder }),
      await send(app, intruder, 'PATCH', path, { shares: '9', totalCost: '9' }),
      await send(app, intruder, 'DELETE', path),
      await app.request(`/v1/positions/${randomUUID()}`, { headers: owner }),
    ]) {
      expect(response.status).toBe(404);
      expect(await errorCode(response)).toBe('not_found');
    }
    expect((await app.request(path, { headers: owner })).status).toBe(200);
    expect(await (await app.request(path, { headers: owner })).json()).toMatchObject({
      shares: '1.0000',
    });
    expect((await app.request('/v1/positions/not-a-uuid', { headers: owner })).status).toBe(400);
  });

  it('deletes a position permanently so the same combination can be created again', async () => {
    const app = makeApp();
    const headers = await login(app);
    const [channelId] = await channelIds(app, headers);
    const body = { fundCode: '110020', channelId, shares: '1', totalCost: '1' };
    const created = (await (await create(app, headers, body)).json()) as PositionBody;
    expect((await send(app, headers, 'DELETE', `/v1/positions/${created.id}`)).status).toBe(204);
    expect((await app.request(`/v1/positions/${created.id}`, { headers })).status).toBe(404);
    expect((await send(app, headers, 'DELETE', `/v1/positions/${created.id}`)).status).toBe(404);
    expect(await (await app.request('/v1/positions', { headers })).json()).toEqual({ items: [] });
    expect((await create(app, headers, body)).status).toBe(201);
  });

  it('blocks deleting a channel that still holds positions', async () => {
    const app = makeApp();
    const headers = await login(app);
    const channel = await send(app, headers, 'POST', '/v1/channels', { name: '有持仓渠道' });
    const channelId = ((await channel.json()) as { id: string }).id;
    const created = (await (
      await create(app, headers, { fundCode: '110020', channelId, shares: '1', totalCost: '1' })
    ).json()) as PositionBody;

    const open = await send(app, headers, 'DELETE', `/v1/channels/${channelId}`);
    expect(open.status).toBe(409);
    expect(await errorCode(open)).toBe('channel_has_positions');

    // 只剩已清仓持仓：#19 之前同样拒绝，持仓不会随渠道被删掉。
    await send(app, headers, 'PATCH', `/v1/positions/${created.id}`, {
      shares: '0',
      totalCost: '0',
    });
    const cleared = await send(app, headers, 'DELETE', `/v1/channels/${channelId}`);
    expect(cleared.status).toBe(409);
    expect(await errorCode(cleared)).toBe('channel_has_positions');
    expect((await app.request(`/v1/positions/${created.id}`, { headers })).status).toBe(200);

    expect((await send(app, headers, 'DELETE', `/v1/positions/${created.id}`)).status).toBe(204);
    expect((await send(app, headers, 'DELETE', `/v1/channels/${channelId}`)).status).toBe(204);
  });
});
