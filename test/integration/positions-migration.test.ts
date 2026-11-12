import { rm } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { createDb, migrateSchema, MIGRATIONS_FOLDER } from '../../src/db';
import type { WeChatLoginResponse } from '../../src/routes/auth';
import { eastmoneySamples, estimateSamples, RecordedUpstream } from '../support/recorded-upstream';
import { migrationFolderThrough } from '../support/migrations';
import { createTestSchema, dropTestSchema } from '../support/test-db';
import { loadTradingCalendar } from '../../src/trading-calendar';
import { importHolidays } from '../../src/trading-calendar/holidays';
import { tradingHolidays } from '../../src/db/schema';
import cn2026 from '../../data/holidays/2026.json';

it('upgrades a schema migrated through 0007 and then creates positions over HTTP', async () => {
  const prior = await migrationFolderThrough(7);
  const db = await createTestSchema(prior);
  try {
    const app = createApp({
      database: createDb(db.pool),
      upstream: new RecordedUpstream(eastmoneySamples),
      clock: { now: () => new Date('2026-11-06T02:00:00Z') },
      wechat: { openid: async (code: string) => `openid-${code}` },
    });
    // 升级前已存在的用户与渠道；与 channels-migration 一致，旧 schema 上用假微信登录建立会话。
    const login = await app.request('/v1/auth/wechat/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'before-positions' }),
    });
    expect(login.status).toBe(200);
    const headers = {
      Authorization: `Bearer ${((await login.json()) as WeChatLoginResponse).token}`,
      'Content-Type': 'application/json',
    };
    const channels = (await (await app.request('/v1/channels', { headers })).json()) as {
      items: { id: string }[];
    };

    await migrateSchema(db.pool, MIGRATIONS_FOLDER, db.schema);
    await migrateSchema(db.pool, MIGRATIONS_FOLDER, db.schema);

    const body = JSON.stringify({
      fundCode: '110020',
      channelId: channels.items[0]!.id,
      shares: '1000',
      totalCost: '1500',
    });
    const created = await app.request('/v1/positions', { method: 'POST', headers, body });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ marketValue: '1680.40', holdingGain: '180.40' });
    const duplicate = await app.request('/v1/positions', { method: 'POST', headers, body });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: { code: 'position_exists' } });
  } finally {
    await dropTestSchema(db);
    await rm(prior, { recursive: true, force: true });
  }
});

it('upgrades 0000–0008 with 0009 and submits a buy trade over HTTP', async () => {
  const prior = await migrationFolderThrough(8);
  const db = await createTestSchema(prior);
  try {
    const app = createApp({
      database: createDb(db.pool),
      upstream: new RecordedUpstream(eastmoneySamples),
      clock: { now: () => new Date('2026-11-06T02:00:00Z') },
      wechat: { openid: async (code: string) => `openid-${code}` },
    });
    const login = await app.request('/v1/auth/wechat/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'before-trades' }),
    });
    expect(login.status).toBe(200);
    const headers = {
      Authorization: `Bearer ${((await login.json()) as WeChatLoginResponse).token}`,
      'Content-Type': 'application/json',
    };
    const channels = (await (await app.request('/v1/channels', { headers })).json()) as {
      items: { id: string }[];
    };
    await migrateSchema(db.pool, MIGRATIONS_FOLDER, db.schema);
    await migrateSchema(db.pool, MIGRATIONS_FOLDER, db.schema);
    const created = await app.request('/v1/positions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        fundCode: '110020',
        channelId: channels.items[0]!.id,
        shares: '1000',
        totalCost: '1500',
      }),
    });
    expect(created.status).toBe(201);
    const position = (await created.json()) as { id: string };
    const bought = await app.request(`/v1/positions/${position.id}/trades`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'buy', amount: '123.45', feeRate: '0.0015' }),
    });
    expect(bought.status).toBe(201);
    expect(await bought.json()).toMatchObject({
      type: 'buy',
      status: 'pending',
      applicationDate: '2026-11-06',
      settlementDate: '2026-11-09',
      amount: '123.45',
      confirmedNav: null,
      source: 'web',
    });
    expect(
      await (await app.request(`/v1/positions/${position.id}`, { headers })).json(),
    ).toMatchObject({ shares: '1000.0000', totalCost: '1500.00', pendingAmount: '123.45' });
  } finally {
    await dropTestSchema(db);
    await rm(prior, { recursive: true, force: true });
  }
});

it('upgrades 0000–0010 with 0011 and confirms a sell through HTTP-visible state', async () => {
  const prior = await migrationFolderThrough(10);
  const db = await createTestSchema(prior);
  let now = new Date('2026-11-06T02:00:00Z');
  try {
    const app = createApp({
      database: createDb(db.pool),
      upstream: new RecordedUpstream(eastmoneySamples),
      clock: { now: () => now },
      wechat: { openid: async (code: string) => code },
    });
    const login = await app.request('/v1/auth/wechat/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'before-sells' }),
    });
    expect(login.status).toBe(200);
    const headers = {
      Authorization: `Bearer ${((await login.json()) as WeChatLoginResponse).token}`,
      'Content-Type': 'application/json',
    };
    const channels = (await (await app.request('/v1/channels', { headers })).json()) as {
      items: { id: string }[];
    };
    await migrateSchema(db.pool, MIGRATIONS_FOLDER, db.schema);
    await migrateSchema(db.pool, MIGRATIONS_FOLDER, db.schema);
    const created = await app.request('/v1/positions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        fundCode: '110020',
        channelId: channels.items[0]!.id,
        shares: '100',
        totalCost: '150',
      }),
    });
    expect(created.status).toBe(201);
    const position = (await created.json()) as { id: string };
    expect(position).toMatchObject({
      realizedGain: '0.00',
      realizedGainCost: '0.00',
      isCleared: false,
    });
    const sold = await app.request(`/v1/positions/${position.id}/trades`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'sell', shares: '100', feeRate: '0.005' }),
    });
    expect(sold.status).toBe(201);
    now = new Date('2026-11-09T13:30:00Z');
    expect(await app.runSettlement()).toMatchObject({ confirmed: 1, failed: 0 });
    // A weekend avoids requesting an estimate unrelated to this migration check.
    now = new Date('2026-11-14T02:00:00Z');
    expect(
      await (await app.request(`/v1/positions/${position.id}`, { headers })).json(),
    ).toMatchObject({
      shares: '0.0000',
      totalCost: '0.00',
      realizedGain: '17.20',
      realizedGainCost: '150.00',
      isCleared: true,
    });
    expect(await (await app.request('/v1/positions', { headers })).json()).toMatchObject({
      items: [],
    });
    expect(
      await (await app.request('/v1/positions?includeCleared=true', { headers })).json(),
    ).toMatchObject({ items: [{ id: position.id }] });
  } finally {
    await dropTestSchema(db);
    await rm(prior, { recursive: true, force: true });
  }
});

it('upgrades 0000–0012 with 0013 and creates a paired switch to a missing target through HTTP', async () => {
  const prior = await migrationFolderThrough(12);
  const db = await createTestSchema(prior);
  try {
    const app = createApp({
      database: createDb(db.pool),
      upstream: new RecordedUpstream(eastmoneySamples),
      clock: { now: () => new Date('2026-11-06T02:00:00Z') },
      wechat: { openid: async (code) => code },
    });
    const login = await app.request('/v1/auth/wechat/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'before-switches' }),
    });
    expect(login.status).toBe(200);
    const headers = {
      Authorization: `Bearer ${((await login.json()) as WeChatLoginResponse).token}`,
      'Content-Type': 'application/json',
    };
    const channels = (await (await app.request('/v1/channels', { headers })).json()) as {
      items: { id: string }[];
    };
    await migrateSchema(db.pool, MIGRATIONS_FOLDER, db.schema);
    await migrateSchema(db.pool, MIGRATIONS_FOLDER, db.schema);
    expect(await (await app.request('/v1/channels', { headers })).json()).toEqual(channels);
    const response = await app.request('/v1/positions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        fundCode: '110020',
        channelId: channels.items[0]!.id,
        shares: '100',
        totalCost: '150',
      }),
    });
    expect(response.status).toBe(201);
    const position = (await response.json()) as { id: string };
    const switched = await app.request(`/v1/positions/${position.id}/switches`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        targetFundCode: '000001',
        targetChannelId: channels.items[0]!.id,
        shares: '40',
        outFeeRate: '0.005',
        inFeeRate: '0.0015',
      }),
    });
    expect(switched.status).toBe(201);
    const transfer = (await switched.json()) as { id: string; items: { id: string }[] };
    expect(transfer).toMatchObject({
      items: [
        { type: 'switch_out', positionId: position.id, switchId: transfer.id },
        { type: 'switch_in', positionId: null, switchId: transfer.id },
      ],
    });
    expect(
      await (await app.request(`/v1/positions/${position.id}`, { headers })).json(),
    ).toMatchObject({ availableShares: '60.0000', pendingShares: '40.0000' });
    expect(
      (
        await app.request(`/v1/switches/${transfer.id}/trades/${transfer.items[1]!.id}`, {
          method: 'DELETE',
          headers,
        })
      ).status,
    ).toBe(204);
    expect(
      await (await app.request(`/v1/positions/${position.id}/trades`, { headers })).json(),
    ).toEqual({ items: [] });
  } finally {
    await dropTestSchema(db);
    await rm(prior, { recursive: true, force: true });
  }
});

it('upgrades deployed 0013 with legacy holidays to 0014 without guessing coverage, then restores estimates by explicit import', async () => {
  const prior = await migrationFolderThrough(13);
  const db = await createTestSchema(prior);
  try {
    // Deployed 0013 fixture: yearly holiday rows exist but no annual coverage metadata exists.
    await createDb(db.pool)
      .insert(tradingHolidays)
      .values(cn2026.holidays.map((day) => ({ ...day, market: 'cn' })));
    const upstream = new RecordedUpstream(
      estimateSamples({
        tiantian: () =>
          JSON.stringify({
            success: true,
            data: [
              {
                FCODE: '000001',
                GSZ: '1.0100',
                GSZZL: 1,
                GZTIME: '2026-11-06 10:00',
                PDATE: '2026-11-05',
                NAV: '1.0000',
              },
            ],
          }),
      }),
    );
    let now = new Date('2026-11-06T02:00:00Z');
    const deps = {
      database: createDb(db.pool),
      upstream,
      clock: { now: () => now },
      wechat: { openid: async (code: string) => code },
    };
    const old = createApp(deps);
    const login = await old.request('/v1/auth/wechat/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'before-coverage' }),
    });
    expect(login.status).toBe(200);
    const headers = {
      Authorization: `Bearer ${((await login.json()) as WeChatLoginResponse).token}`,
      'Content-Type': 'application/json',
    };
    const channels = (await (await old.request('/v1/channels', { headers })).json()) as {
      items: { id: string }[];
    };

    await migrateSchema(db.pool, MIGRATIONS_FOLDER, db.schema);
    await migrateSchema(db.pool, MIGRATIONS_FOLDER, db.schema);
    const target = createApp({ ...deps, tradingCalendar: await loadTradingCalendar(db.pool) });
    expect(await (await target.request('/v1/channels', { headers })).json()).toEqual(channels);
    const estimates = await target.request('/v1/funds/estimates?codes=000001');
    expect(estimates.status).toBe(200);
    expect(await estimates.json()).toMatchObject({
      items: [{ status: 'unavailable', estimate: null }],
    });
    now = new Date('2026-10-01T02:00:00Z');
    expect(await (await target.request('/v1/market/status')).json()).toMatchObject({
      status: 'holiday',
    });
    now = new Date('2026-11-06T02:00:00Z');
    const created = await target.request('/v1/positions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        fundCode: '000001',
        channelId: channels.items[0]!.id,
        shares: '1000',
        totalCost: '1000',
      }),
    });
    expect(created.status).toBe(201);
    const position = (await created.json()) as { id: string };
    expect(position).toMatchObject({ todayGain: null, todayGainStatus: 'unavailable' });

    await importHolidays(db.pool, cn2026.year, cn2026.holidays);
    const restored = createApp({ ...deps, tradingCalendar: await loadTradingCalendar(db.pool) });
    expect(await (await restored.request('/v1/funds/estimates?codes=000001')).json()).toMatchObject(
      {
        items: [
          {
            status: 'estimated',
            estimate: { source: 'tiantian', time: '2026-11-06T02:00:00.000Z' },
          },
        ],
      },
    );
    expect(
      await (await restored.request(`/v1/positions/${position.id}`, { headers })).json(),
    ).toMatchObject({ todayGain: '10.00', todayGainStatus: 'estimated' });
    await migrateSchema(db.pool, MIGRATIONS_FOLDER, db.schema);
    expect(await (await restored.request('/v1/funds/estimates?codes=000001')).json()).toMatchObject(
      { items: [{ status: 'estimated' }] },
    );
  } finally {
    await dropTestSchema(db);
    await rm(prior, { recursive: true, force: true });
  }
});
