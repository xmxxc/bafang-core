import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { createDb, migrateSchema, MIGRATIONS_FOLDER } from '../../src/db';
import type { WeChatLoginResponse } from '../../src/routes/auth';
import { migrationFolderThrough } from '../support/migrations';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';

// 旧版 schema 上用微信登录建立会话：它只用 0003 起已有的表，不依赖后续迁移新增的验证码列。
const fakeWeChat = { openid: async (code: string) => `openid-${code}` };

async function wechatLogin(app: ReturnType<typeof createApp>) {
  const login = await app.request('/v1/auth/wechat/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: randomUUID() }),
  });
  expect(login.status).toBe(200);
  const token = ((await login.json()) as WeChatLoginResponse).token;
  expect(token).toBeTruthy();
  return { Authorization: `Bearer ${token}` };
}

async function loggedInApp(db: TestSchema) {
  const app = createApp({ database: createDb(db.pool), wechat: fakeWeChat });
  return { app, headers: await wechatLogin(app) };
}

it('preserves existing users preset order when upgrading from migration 0003, observed over HTTP', async () => {
  const folder = await migrationFolderThrough(3);
  let db: TestSchema | undefined;
  try {
    // 只准备旧版迁移环境，所有业务状态仍由 HTTP 创建、观察。
    db = await createTestSchema(folder);
    const app = createApp({ database: createDb(db.pool), wechat: fakeWeChat });
    const headers = await wechatLogin(app);
    const before = await (await app.request('/v1/channels', { headers })).json();
    await migrateSchema(db.pool, MIGRATIONS_FOLDER, db.schema);
    // 重复迁移也是幂等的，不会重置渠道或顺序。
    await migrateSchema(db.pool, MIGRATIONS_FOLDER, db.schema);
    const after = await app.request('/v1/channels', { headers });
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual(before);
    const added = await app.request('/v1/channels', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '迁移后新增' }),
    });
    expect(added.status).toBe(201);
    const listed = await app.request('/v1/channels', { headers });
    expect(
      ((await listed.json()) as { items: { name: string }[] }).items.map((channel) => channel.name),
    ).toEqual(['支付宝', '天天基金', '未指定', '迁移后新增']);
    const duplicate = await app.request('/v1/channels', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '支付宝' }),
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: { code: 'channel_name_conflict' } });
  } finally {
    if (db) await dropTestSchema(db);
    await rm(folder, { recursive: true, force: true });
  }
});

it('applies the 0006 unique index when upgrading a schema already migrated through 0005', async () => {
  const prior = await migrationFolderThrough(5);
  const db = await createTestSchema(prior);
  try {
    const { app, headers } = await loggedInApp(db);
    const first = await app.request('/v1/channels', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '迁移唯一性检查' }),
    });
    expect(first.status).toBe(201);
    await migrateSchema(db.pool, MIGRATIONS_FOLDER, db.schema);
    const duplicate = await app.request('/v1/channels', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '迁移唯一性检查' }),
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({
      error: { code: 'channel_name_conflict' },
    });
  } finally {
    await dropTestSchema(db);
    await rm(prior, { recursive: true, force: true });
  }
});

it('fails clearly instead of silently skipping 0006 when existing data violates its unique index', async () => {
  const prior = await migrationFolderThrough(5);
  const db = await createTestSchema(prior);
  try {
    const { app, headers } = await loggedInApp(db);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const duplicate = await app.request('/v1/channels', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '迁移前重名渠道' }),
      });
      expect(duplicate.status).toBe(201);
    }
    await expect(migrateSchema(db.pool, MIGRATIONS_FOLDER, db.schema)).rejects.toThrow(
      /channels_user_name_uidx|could not create unique index|duplicate key/i,
    );
  } finally {
    await dropTestSchema(db);
    await rm(prior, { recursive: true, force: true });
  }
});
