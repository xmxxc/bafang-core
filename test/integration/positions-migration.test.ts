import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { createDb, migrateSchema, MIGRATIONS_FOLDER } from '../../src/db';
import type { WeChatLoginResponse } from '../../src/routes/auth';
import { eastmoneySamples, RecordedUpstream } from '../support/recorded-upstream';
import { createTestSchema, dropTestSchema } from '../support/test-db';

async function migrationFolderThrough(maxIdx: number): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), `positions-migrations-${maxIdx}-`));
  const sourceMeta = join(MIGRATIONS_FOLDER, 'meta');
  await mkdir(join(folder, 'meta'));
  const journal = JSON.parse(await readFile(join(sourceMeta, '_journal.json'), 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  journal.entries = journal.entries.filter((entry) => entry.idx <= maxIdx);
  await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
  for (const entry of journal.entries) {
    await copyFile(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  for (const name of await readdir(sourceMeta)) {
    if (name.endsWith('.json') && name !== '_journal.json' && Number(name.slice(0, 4)) <= maxIdx) {
      await copyFile(join(sourceMeta, name), join(folder, 'meta', name));
    }
  }
  return folder;
}

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
