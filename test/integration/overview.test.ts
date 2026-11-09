import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../../src/app';
import { createDb } from '../../src/db';
import { UpstreamError } from '../../src/market/upstream';
import type { WeChatLoginResponse } from '../../src/routes/auth';
import { OverviewSchema, type OverviewResponse } from '../../src/routes/overview';
import {
  eastmoneySamples,
  quoteSamples,
  RecordedUpstream,
  sample,
  sinaSamples,
  tiantianSamples,
  type Replay,
} from '../support/recorded-upstream';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';

describe('今日概览（HTTP）', () => {
  let database: TestSchema;
  let app: App;
  let now: Date;
  let published: boolean;
  let changePercent: number;
  let verificationCode: string;

  const replay: Replay = (url) => {
    if (url.hostname === 'qt.gtimg.cn' || url.hostname === 'd.10jqka.com.cn')
      return quoteSamples(url);
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
        row.FCODE === '110020'
          ? { ...row, PDATE: '2026-11-05', NAV: 1.703, GSZZL: changePercent }
          : row,
      );
      return tiantianSamples(JSON.stringify(body))(url);
    }
    if (url.hostname === 'hq.sinajs.cn') return '';
    return eastmoneySamples(url);
  };

  function makeApp(source: Replay = replay) {
    return createApp({
      database: createDb(database.pool),
      clock: { now: () => now },
      upstream: new RecordedUpstream(source),
      wechat: {
        async openid(code) {
          return code;
        },
      },
      mailer: {
        async sendVerificationCode(_email, code) {
          verificationCode = code;
        },
      },
    });
  }

  beforeEach(async () => {
    database = await createTestSchema();
    now = new Date('2026-11-06T02:00:00Z');
    published = false;
    changePercent = -1.44;
    app = makeApp();
  });
  afterEach(async () => dropTestSchema(database));

  function send(headers: Record<string, string>, method: string, path: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function login() {
    const response = await send({}, 'POST', '/v1/auth/wechat/login', { code: randomUUID() });
    expect(response.status).toBe(200);
    return { Authorization: `Bearer ${((await response.json()) as WeChatLoginResponse).token}` };
  }
  async function channels(headers: Record<string, string>) {
    return (
      (await (await app.request('/v1/channels', { headers })).json()) as {
        items: { id: string; name: string }[];
      }
    ).items;
  }
  async function create(
    headers: Record<string, string>,
    channelId: string,
    fundCode = '110020',
    shares = '1000',
  ) {
    const response = await send(headers, 'POST', '/v1/positions', {
      channelId,
      fundCode,
      shares,
      totalCost: '1500',
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string };
  }
  async function overview(headers: Record<string, string>, suffix = '') {
    const response = await app.request(`/v1/overview${suffix}`, { headers });
    expect(response.status).toBe(200);
    const body = (await response.json()) as OverviewResponse;
    expect(OverviewSchema.safeParse(body).success).toBe(true);
    return body;
  }

  it('returns totals, position quote provenance, channel names and indices in one request', async () => {
    const headers = await login();
    const [channel] = await channels(headers);
    const position = await create(headers, channel!.id);
    const body = await overview(headers);
    expect(body).toMatchObject({
      summary: {
        totalAssets: '1703.00',
        todayGain: '-24.52',
        todayGainRate: '-0.0144',
        todayGainStatus: 'estimated',
        holdingGain: '203.00',
        risingCount: 0,
        fallingCount: 1,
        isComplete: true,
      },
      positions: [
        {
          id: position.id,
          fundCode: '110020',
          fundName: '易方达沪深300ETF联接A',
          channelId: channel!.id,
          channelName: channel!.name,
          todayGain: '-24.52',
          quote: {
            type: 'estimate',
            value: '1.6785',
            changePercent: -1.44,
            source: 'tiantian',
            sourceName: '天天基金',
            fallback: false,
            date: '2026-11-06',
            time: '2026-11-06T07:00:00.000Z',
          },
        },
      ],
      referenceOnly: true,
      time: now.toISOString(),
    });
    expect(body.indices.items.map((item) => item.code)).toEqual([
      '000001.SH',
      '399001.SZ',
      '399006.SZ',
      'HSI.HK',
    ]);
    expect(body.indices.items.every((item) => item.available)).toBe(true);
  });

  it('switches from estimated to confirmed gain with the same NAV quote and date', async () => {
    const headers = await login();
    const [channel] = await channels(headers);
    await create(headers, channel!.id);
    expect((await overview(headers)).positions[0]!.quote.type).toBe('estimate');
    published = true;
    now = new Date('2026-11-06T11:05:00Z');
    const body = await overview(headers);
    expect(body.summary).toMatchObject({
      totalAssets: '1680.40',
      todayGain: '-22.60',
      todayGainRate: '-0.0133',
      todayGainStatus: 'confirmed',
      holdingGain: '180.40',
      isComplete: true,
      risingCount: 0,
      fallingCount: 1,
    });
    expect(body.positions[0]).toMatchObject({
      todayGain: '-22.60',
      todayGainStatus: 'confirmed',
      quote: {
        type: 'nav',
        value: '1.6804',
        changePercent: -1.33,
        date: '2026-11-06',
        time: '2026-11-06',
        source: 'eastmoney',
        sourceName: '东方财富',
        fallback: false,
      },
    });
  });

  it('filters every position total and counts each held fund once across channels', async () => {
    const headers = await login();
    const [first, second, empty] = await channels(headers);
    await create(headers, first!.id);
    await create(headers, second!.id, '110020', '500');
    const body = await overview(headers);
    expect(body.positions).toHaveLength(2);
    expect(body.summary).toMatchObject({
      totalAssets: '2554.50',
      todayGain: '-36.78',
      todayGainRate: '-0.0144',
      fallingCount: 1,
      risingCount: 0,
    });
    const filtered = await overview(headers, `?channelId=${second!.id.toUpperCase()}`);
    expect(filtered.positions).toHaveLength(1);
    expect(filtered.positions[0]!.channelId).toBe(second!.id);
    expect(filtered.summary).toMatchObject({
      totalAssets: '851.50',
      todayGain: '-12.26',
      fallingCount: 1,
    });
    expect(filtered.indices.items).toEqual(body.indices.items);
    const vacant = await overview(headers, `?channelId=${empty!.id}`);
    expect(vacant.positions).toEqual([]);
    expect(vacant.summary).toMatchObject({
      totalAssets: '0.00',
      todayGain: '0.00',
      todayGainStatus: 'none',
      isComplete: true,
    });
  });

  it('marks unavailable estimates explicitly and excludes them from the gain denominator', async () => {
    const headers = await login();
    const [channel] = await channels(headers);
    await create(headers, channel!.id);
    await create(headers, channel!.id, '040046');
    const body = await overview(headers);
    expect(body.summary).toMatchObject({
      totalAssets: '9018.90',
      holdingGain: '6018.90',
      todayGain: '-24.52',
      todayGainRate: '-0.0144',
      previousMarketValue: '1703.00',
      todayGainStatus: 'estimated',
      valuationComplete: true,
      todayGainComplete: false,
      isComplete: false,
      risingCount: 0,
      fallingCount: 1,
    });
    expect(body.positions[1]).toMatchObject({
      fundCode: '040046',
      todayGain: null,
      todayGainStatus: 'unavailable',
      quote: {
        type: 'unavailable',
        value: null,
        changePercent: null,
        time: null,
        date: null,
        source: null,
        sourceName: null,
      },
    });
  });

  it('preserves null totals when all estimates or all NAVs are unavailable', async () => {
    const headers = await login();
    const [channel] = await channels(headers);
    await create(headers, channel!.id);
    app = makeApp((url) =>
      url.hostname === 'fundcomapi.tiantianfunds.com'
        ? JSON.stringify({ success: true, data: [] })
        : replay(url),
    );
    expect((await overview(headers)).summary).toMatchObject({
      totalAssets: '1703.00',
      todayGain: null,
      todayGainRate: null,
      todayGainStatus: 'unavailable',
      todayGainComplete: false,
      isComplete: false,
      fallingCount: 0,
      risingCount: 0,
    });
    app = makeApp((url) =>
      url.hostname === 'api.fund.eastmoney.com'
        ? new UpstreamError('timeout', 'recorded timeout')
        : replay(url),
    );
    const body = await overview(headers);
    expect(body.summary).toMatchObject({
      totalAssets: null,
      holdingGain: null,
      todayGain: null,
      valuationComplete: false,
      todayGainComplete: false,
      isComplete: false,
    });
    expect(body.positions[0]).toMatchObject({
      marketValue: null,
      nav: null,
      quote: { type: 'unavailable' },
    });
  });

  it('keeps mixed confirmed and estimated rows with a mixed summary', async () => {
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
    await create(headers, channel!.id, '000001');
    const body = await overview(headers);
    expect(body.summary).toMatchObject({
      todayGainStatus: 'mixed',
      todayGain: '-14.52', // 110020: -24.52; 000001: 1000 × (1.0100 − 1.0000) = 10.00
      todayGainRate: '-0.0054',
      risingCount: 1,
      fallingCount: 1,
      isComplete: true,
    });
    expect(body.positions.map((item) => item.quote.type)).toEqual(['estimate', 'nav']);
  });

  it('reports the fallback estimate source actually used for the gain', async () => {
    const headers = await login();
    const [channel] = await channels(headers);
    await create(headers, channel!.id);
    app = makeApp((url) => {
      if (url.hostname === 'fundcomapi.tiantianfunds.com')
        return new UpstreamError('timeout', 'recorded timeout');
      if (url.hostname === 'hq.sinajs.cn') return sinaSamples()(url);
      return replay(url);
    });
    const body = await overview(headers);
    expect(body.positions[0]).toMatchObject({
      todayGain: '-23.04',
      todayGainStatus: 'estimated',
      quote: {
        type: 'estimate',
        source: 'sina',
        sourceName: '新浪财经',
        fallback: true,
        changePercent: -1.3531,
        time: '2026-11-06T08:03:00.000Z',
      },
    });
  });

  it.each([
    ['10.0001', '0.10', 1, 0],
    ['9.9999', '-0.10', 0, 1],
  ])(
    'counts small confirmed NAV movements at %s before rounding the displayed percent',
    async (nav, gain, risingCount, fallingCount) => {
      const headers = await login();
      const [channel] = await channels(headers);
      await create(headers, channel!.id);
      now = new Date('2026-11-06T11:05:00Z');
      app = makeApp((url) => {
        if (
          url.hostname === 'api.fund.eastmoney.com' &&
          url.searchParams.get('fundCode') === '110020'
        ) {
          const body = JSON.parse(sample('eastmoney/nav-110020-history-2026-10-06-p1.json')) as {
            Data: { LSJZList: { FSRQ: string; DWJZ: string }[] };
          };
          body.Data.LSJZList = body.Data.LSJZList.slice(0, 2).map((row, i) => ({
            ...row,
            DWJZ: i === 0 ? nav : '10.0000',
          }));
          if (url.searchParams.get('pageSize') === '1')
            body.Data.LSJZList = body.Data.LSJZList.slice(0, 1);
          return JSON.stringify(body);
        }
        return replay(url);
      });
      const body = await overview(headers);
      expect(body.summary).toMatchObject({
        todayGain: gain,
        todayGainStatus: 'confirmed',
        risingCount,
        fallingCount,
      });
      expect(body.positions[0]!.quote).toMatchObject({
        changePercent: 0,
        direction: risingCount === 1 ? 'up' : 'down',
      });
    },
  );

  it.each([
    ['2026-11-06T00:00:00Z', 'pre-market'],
    ['2026-11-07T02:00:00Z', 'holiday'],
  ])('does not reuse a previous day’s gain at %s (%s)', async (time) => {
    const headers = await login();
    const [channel] = await channels(headers);
    await create(headers, channel!.id);
    now = new Date(time);
    const body = await overview(headers);
    expect(body.summary).toMatchObject({
      todayGain: null,
      todayGainStatus: 'unavailable',
      isComplete: false,
      risingCount: 0,
      fallingCount: 0,
    });
    expect(body.positions[0]).toMatchObject({
      todayGain: null,
      quote: { type: 'unavailable', changePercent: null, time: null },
    });
  });

  it.each([0, 0.000001, 2])(
    'counts funds from the quote at %s percent, even when gain rounds to zero',
    async (percent) => {
      changePercent = percent;
      const headers = await login();
      const [channel] = await channels(headers);
      await create(headers, channel!.id, '110020', '0.0001');
      const body = await overview(headers);
      expect(body.summary).toMatchObject({
        todayGain: '0.00',
        todayGainStatus: 'estimated',
        fallingCount: 0,
        risingCount: percent > 0 ? 1 : 0,
        isComplete: true,
      });
      expect(body.positions[0]!.quote.changePercent).toBe(percent);
    },
  );

  it('hides cleared positions and excludes zero-share pending buys from counts', async () => {
    const headers = await login();
    const [channel] = await channels(headers);
    const position = await create(headers, channel!.id);
    expect(
      (
        await send(headers, 'PATCH', `/v1/positions/${position.id}`, {
          shares: '0',
          totalCost: '0',
        })
      ).status,
    ).toBe(200);
    expect((await overview(headers)).positions).toEqual([]);
    expect(
      (
        await send(headers, 'POST', `/v1/positions/${position.id}/trades`, {
          type: 'buy',
          amount: '100',
          feeRate: '0',
        })
      ).status,
    ).toBe(201);
    const body = await overview(headers);
    expect(body.positions).toHaveLength(1);
    expect(body.positions[0]).toMatchObject({ shares: '0.0000', pendingAmount: '100.00' });
    expect(body.summary).toMatchObject({
      risingCount: 0,
      fallingCount: 0,
      totalAssets: '0.00',
      todayGain: '0.00',
    });
  });

  it('continues returning positions when names and all index sources fail', async () => {
    const headers = await login();
    const [channel] = await channels(headers);
    await create(headers, channel!.id);
    app = makeApp((url) =>
      ['fundmobapi.eastmoney.com', 'qt.gtimg.cn', 'd.10jqka.com.cn'].includes(url.hostname)
        ? new UpstreamError('timeout', 'recorded timeout')
        : replay(url),
    );
    const body = await overview(headers);
    expect(body.positions[0]).toMatchObject({
      fundName: null,
      fundCode: '110020',
      todayGain: '-24.52',
    });
    expect(body.indices.items).toHaveLength(4);
    expect(body.indices.items.every((item) => !item.available && item.point === null)).toBe(true);
  });

  it('requires a valid session, isolates users and rejects unknown or foreign channels', async () => {
    expect((await app.request('/v1/overview')).status).toBe(401);
    expect(
      (await app.request('/v1/overview', { headers: { Authorization: 'Bearer invalid' } })).status,
    ).toBe(401);
    const headers = await login();
    const [channel] = await channels(headers);
    await create(headers, channel!.id);
    const other = await login();
    const otherOverview = await overview(other);
    expect(otherOverview.positions).toEqual([]);
    expect(otherOverview.summary).toMatchObject({
      totalAssets: '0.00',
      todayGainStatus: 'none',
      isComplete: true,
    });
    for (const channelId of [channel!.id, randomUUID()]) {
      const response = await app.request(`/v1/overview?channelId=${channelId}`, { headers: other });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
    }
    expect((await app.request('/v1/overview?channelId=bad', { headers })).status).toBe(400);
    expect((await send(headers, 'POST', '/v1/auth/logout')).status).toBe(204);
    expect((await app.request('/v1/overview', { headers })).status).toBe(401);
  });

  it('supports a real web Cookie session alongside miniprogram Bearer sessions', async () => {
    const email = `overview-${randomUUID()}@example.com`;
    expect((await send({}, 'POST', '/v1/auth/email/request', { email })).status).toBe(200);
    const login = await send({}, 'POST', '/v1/auth/email/login', {
      email,
      code: verificationCode,
      device: 'web',
    });
    expect(login.status).toBe(200);
    const headers = { Cookie: login.headers.get('set-cookie')!.split(';')[0]! };
    const [channel] = await channels(headers);
    await create(headers, channel!.id);
    expect((await overview(headers)).positions).toHaveLength(1);
  });

  it('returns the documented database-unavailable response without a configured database', async () => {
    const response = await createApp().request('/v1/overview');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'database_unavailable' } });
  });
});
