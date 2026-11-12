import { rm } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { createDb, migrateSchema, MIGRATIONS_FOLDER } from '../../src/db';
import type { WeChatLoginResponse } from '../../src/routes/auth';
import { migrationFolderThrough } from '../support/migrations';
import { createTestSchema, dropTestSchema } from '../support/test-db';

it('upgrades 0000–0011 to 0012, preserves the existing user and delivers their web session over HTTP', async () => {
  const prior = await migrationFolderThrough(11);
  let database: Awaited<ReturnType<typeof createTestSchema>> | undefined;
  try {
    database = await createTestSchema(prior);
    const app = createApp({
      database: createDb(database.pool),
      clock: { now: () => new Date('2026-11-06T02:00:00Z') },
      wechat: {
        async openid() {
          return 'existing-qr-user';
        },
      },
      wechatQr: {
        async generate() {
          return { contentType: 'image/png', base64: 'test-image' };
        },
      },
    });
    const login = await app.request('/v1/auth/wechat/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'before-migration' }),
    });
    expect(login.status).toBe(200);
    const mini = (await login.json()) as WeChatLoginResponse;
    const original = await (
      await app.request('/v1/me', { headers: { Authorization: `Bearer ${mini.token}` } })
    ).json();
    await migrateSchema(database.pool, MIGRATIONS_FOLDER, database.schema);
    await migrateSchema(database.pool, MIGRATIONS_FOLDER, database.schema);
    const start = await app.request('/v1/auth/wechat/qr', { method: 'POST' });
    expect(start.status).toBe(201);
    const { ticketId } = (await start.json()) as { ticketId: string };
    const cookie = start.headers.getSetCookie()[0]!.split(';')[0]!;
    const confirmed = await app.request(`/v1/auth/wechat/qr/${ticketId}/confirm`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mini.token}` },
    });
    expect(confirmed.status).toBe(200);
    const delivered = await app.request(`/v1/auth/wechat/qr/${ticketId}`, {
      headers: { Cookie: cookie },
    });
    expect(delivered.status).toBe(200);
    expect(await delivered.json()).toMatchObject({
      status: 'confirmed',
      user: mini.user,
      session: { device: 'web' },
      token: null,
    });
    const web = delivered.headers
      .getSetCookie()
      .find((value) => value.startsWith('bafang_session='))!
      .split(';')[0]!;
    expect(await (await app.request('/v1/me', { headers: { Cookie: web } })).json()).toEqual(
      original,
    );
  } finally {
    if (database) await dropTestSchema(database);
    await rm(prior, { recursive: true, force: true });
  }
});
