import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../../src/app';
import { createDb } from '../../src/db';
import type { EmailLoginResponse } from '../../src/routes/auth';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';

interface Channel {
  id: string;
  name: string;
}

describe('channel management over in-process HTTP against real PostgreSQL', () => {
  let db: TestSchema;
  let app: App;
  let codes: Map<string, string>;

  beforeEach(async () => {
    db = await createTestSchema();
    codes = new Map();
    app = createApp({
      database: createDb(db.pool),
      mailer: {
        async sendVerificationCode(email, code) {
          codes.set(email, code);
        },
      },
    });
  });

  afterEach(async () => {
    await dropTestSchema(db);
  });

  async function login(email = 'channels@example.com') {
    expect((await request('/v1/auth/email/request', 'POST', '', { email })).status).toBe(200);
    const res = await request('/v1/auth/email/login', 'POST', '', {
      email,
      code: codes.get(email),
      device: 'miniprogram',
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as EmailLoginResponse).token!;
  }

  function request(path: string, method = 'GET', token = '', body?: unknown) {
    return app.request(path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function list(token: string): Promise<Channel[]> {
    const res = await request('/v1/channels', 'GET', token);
    expect(res.status).toBe(200);
    return ((await res.json()) as { items: Channel[] }).items;
  }

  it('lists exactly the three preset channels in their initial order', async () => {
    const token = await login();
    const items = await list(token);
    expect(items.map((channel) => channel.name)).toEqual(['支付宝', '天天基金', '未指定']);
    expect(new Set(items.map((channel) => channel.id)).size).toBe(3);
  });

  it('appends a new channel and rejects duplicate names including concurrent requests', async () => {
    const token = await login();
    const added = await request('/v1/channels', 'POST', token, { name: '  招商银行  ' });
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({ name: '招商银行' });
    const duplicate = await request('/v1/channels', 'POST', token, { name: '招商银行' });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({
      error: { code: 'channel_name_conflict', message: '已有同名渠道' },
    });
    const concurrent = await Promise.all([
      request('/v1/channels', 'POST', token, { name: '工商银行' }),
      request('/v1/channels', 'POST', token, { name: '工商银行' }),
    ]);
    expect(concurrent.map((res) => res.status).sort()).toEqual([201, 409]);
    const conflict = concurrent.find((res) => res.status === 409)!;
    expect(await conflict.json()).toMatchObject({ error: { code: 'channel_name_conflict' } });
    expect((await list(token)).map((channel) => channel.name)).toEqual([
      '支付宝',
      '天天基金',
      '未指定',
      '招商银行',
      '工商银行',
    ]);
  });

  it('renames a channel and persists a custom order across requests and app instances', async () => {
    const token = await login();
    const [alipay, tiantian, unspecified] = await list(token);
    const renamed = await request(`/v1/channels/${alipay!.id}`, 'PATCH', token, {
      name: '常用渠道',
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual({ id: alipay!.id, name: '常用渠道' });
    const ordered = await request('/v1/channels/order', 'PUT', token, {
      channelIds: [unspecified!.id, tiantian!.id, alipay!.id],
    });
    expect(ordered.status).toBe(200);
    expect(
      ((await ordered.json()) as { items: Channel[] }).items.map((channel) => channel.name),
    ).toEqual(['未指定', '天天基金', '常用渠道']);
    app = createApp({ database: createDb(db.pool) });
    expect((await list(token)).map((channel) => channel.name)).toEqual([
      '未指定',
      '天天基金',
      '常用渠道',
    ]);
    const me = await request('/v1/me', 'GET', token);
    expect(
      ((await me.json()) as { channels: Channel[] }).channels.map((channel) => channel.name),
    ).toEqual(['未指定', '天天基金', '常用渠道']);
    expect((await request('/v1/channels', 'POST', token, { name: '新渠道' })).status).toBe(201);
    expect((await list(token)).map((channel) => channel.name)).toEqual([
      '未指定',
      '天天基金',
      '常用渠道',
      '新渠道',
    ]);
  });

  it('keeps exactly one unspecified channel and refuses its rename or deletion', async () => {
    const token = await login();
    const initial = await list(token);
    const unspecified = initial.find((channel) => channel.name === '未指定')!;
    for (const name of ['新名字', '未指定']) {
      const renamed = await request(`/v1/channels/${unspecified.id}`, 'PATCH', token, { name });
      expect(renamed.status).toBe(409);
      expect(await renamed.json()).toMatchObject({ error: { code: 'channel_protected' } });
    }
    const removed = await request(`/v1/channels/${unspecified.id}`, 'DELETE', token);
    expect(removed.status).toBe(409);
    expect(await removed.json()).toMatchObject({ error: { code: 'channel_protected' } });
    const duplicate = await request('/v1/channels', 'POST', token, { name: ' 未指定 ' });
    expect(duplicate.status).toBe(409);
    const renameToDefault = await request(`/v1/channels/${initial[0]!.id}`, 'PATCH', token, {
      name: '未指定',
    });
    expect(renameToDefault.status).toBe(409);
    expect(await renameToDefault.json()).toMatchObject({
      error: { code: 'channel_name_conflict' },
    });
    expect(await list(token)).toEqual(initial);
  });

  it('deletes a channel without positions and allows the name to be reused at the end', async () => {
    const token = await login();
    const initial = await list(token);
    const removed = await request(`/v1/channels/${initial[0]!.id}`, 'DELETE', token);
    expect(removed.status).toBe(204);
    expect(await removed.text()).toBe('');
    expect(await list(token)).toEqual(initial.slice(1));
    const repeated = await request(`/v1/channels/${initial[0]!.id}`, 'DELETE', token);
    expect(repeated.status).toBe(404);
    expect(await repeated.json()).toMatchObject({ error: { code: 'not_found' } });
    expect((await request('/v1/channels', 'POST', token, { name: '支付宝' })).status).toBe(201);
    expect((await list(token)).map((channel) => channel.name)).toEqual([
      '天天基金',
      '未指定',
      '支付宝',
    ]);
  });

  it('requires a valid session on every channel operation before validating input', async () => {
    const operations: [string, string, unknown?][] = [
      ['/v1/channels', 'GET'],
      ['/v1/channels', 'POST', { name: '银行' }],
      ['/v1/channels/order', 'PUT', { channelIds: [] }],
      ['/v1/channels/not-a-uuid', 'PATCH', { name: '银行' }],
      ['/v1/channels/not-a-uuid', 'DELETE'],
    ];
    for (const token of ['', 'invalid-session']) {
      for (const [path, method, body] of operations) {
        const res = await request(path, method, token, body);
        expect(res.status).toBe(401);
        expect(await res.json()).toMatchObject({ error: { code: 'unauthorized' } });
      }
    }
    const token = await login();
    expect((await request('/v1/auth/logout', 'POST', token)).status).toBe(204);
    expect((await request('/v1/channels', 'GET', token)).status).toBe(401);
  });

  it('hides other users channels and refuses their rename, deletion and ordering', async () => {
    const alice = await login('alice@example.com');
    const bob = await login('bob@example.com');
    const aliceInitial = await list(alice);
    const bobInitial = await list(bob);
    expect(aliceInitial.every((a) => bobInitial.every((b) => a.id !== b.id))).toBe(true);
    const foreignId = bobInitial[0]!.id;
    for (const [method, body] of [
      ['PATCH', { name: '篡改' }],
      ['DELETE', undefined],
    ] as const) {
      const res = await request(`/v1/channels/${foreignId}`, method, alice, body);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: 'not_found', message: '渠道不存在' } });
    }
    const foreignOrder = await request('/v1/channels/order', 'PUT', alice, {
      channelIds: [foreignId, ...aliceInitial.slice(1).map((channel) => channel.id)],
    });
    expect(foreignOrder.status).toBe(404);
    expect(await foreignOrder.json()).toMatchObject({ error: { code: 'not_found' } });
    expect(await list(alice)).toEqual(aliceInitial);
    expect(await list(bob)).toEqual(bobInitial);
    for (const token of [alice, bob]) {
      expect((await request('/v1/channels', 'POST', token, { name: '同名银行' })).status).toBe(201);
    }
    expect((await list(alice)).map((channel) => channel.name)).toEqual([
      '支付宝',
      '天天基金',
      '未指定',
      '同名银行',
    ]);
    expect((await list(bob)).map((channel) => channel.name)).toEqual([
      '支付宝',
      '天天基金',
      '未指定',
      '同名银行',
    ]);
  });

  it('rejects rename conflicts including concurrent renames without losing either channel', async () => {
    const token = await login();
    const initial = await list(token);
    const conflict = await request(`/v1/channels/${initial[0]!.id}`, 'PATCH', token, {
      name: '天天基金',
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: 'channel_name_conflict' } });
    expect(await list(token)).toEqual(initial);
    const concurrent = await Promise.all(
      initial
        .slice(0, 2)
        .map((channel) => request(`/v1/channels/${channel.id}`, 'PATCH', token, { name: '同名' })),
    );
    expect(concurrent.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(await concurrent.find((res) => res.status === 409)!.json()).toMatchObject({
      error: { code: 'channel_name_conflict' },
    });
    const current = await list(token);
    expect(current).toHaveLength(3);
    expect(current.filter((channel) => channel.name === '同名')).toHaveLength(1);
    expect(current.map((channel) => channel.id)).toEqual(initial.map((channel) => channel.id));
  });

  it('rejects incomplete, duplicate and unknown ordering atomically', async () => {
    const token = await login();
    const initial = await list(token);
    const ids = initial.map((channel) => channel.id);
    for (const channelIds of [[], ids.slice(1), [ids[0], ids[0], ids[2]]]) {
      const res = await request('/v1/channels/order', 'PUT', token, { channelIds });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'validation_error' } });
      expect(await list(token)).toEqual(initial);
    }
    const unknown = await request('/v1/channels/order', 'PUT', token, {
      channelIds: [ids[0], ids[1], '00000000-0000-4000-8000-000000000000'],
    });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: { code: 'not_found' } });
    expect(await list(token)).toEqual(initial);
  });

  it('validates names, ids and JSON using the shared error shape', async () => {
    const token = await login();
    const initial = await list(token);
    for (const body of [
      {},
      { name: '' },
      { name: '   ' },
      { name: '字'.repeat(101) },
      { name: 123 },
    ]) {
      for (const [path, method] of [
        ['/v1/channels', 'POST'],
        [`/v1/channels/${initial[0]!.id}`, 'PATCH'],
      ]) {
        const res = await request(path!, method!, token, body);
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: { code: 'validation_error' } });
      }
    }
    for (const method of ['PATCH', 'DELETE']) {
      const res = await request('/v1/channels/not-a-uuid', method, token, { name: '银行' });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'validation_error' } });
    }
    const malformed = await app.request('/v1/channels', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: 'validation_error' } });
    const unsupported = await app.request('/v1/channels', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body: JSON.stringify({ name: '银行' }),
    });
    expect(unsupported.status).toBe(400);
    expect(await unsupported.json()).toMatchObject({ error: { code: 'validation_error' } });
    expect(await list(token)).toEqual(initial);
  });

  it('accepts the existing web session cookie for channel reads and writes', async () => {
    const email = 'web@example.com';
    expect((await request('/v1/auth/email/request', 'POST', '', { email })).status).toBe(200);
    const signedIn = await request('/v1/auth/email/login', 'POST', '', {
      email,
      code: codes.get(email),
      device: 'web',
    });
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers.get('set-cookie')!.split(';')[0]!;
    const added = await app.request('/v1/channels', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '网页渠道' }),
    });
    expect(added.status).toBe(201);
    const listed = await app.request('/v1/channels', { headers: { Cookie: cookie } });
    expect(listed.status).toBe(200);
    expect(
      ((await listed.json()) as { items: Channel[] }).items.map((channel) => channel.name),
    ).toEqual(['支付宝', '天天基金', '未指定', '网页渠道']);
  });

  it('returns the shared database unavailable response when no database is configured', async () => {
    app = createApp();
    for (const [path, method] of [
      ['/v1/channels', 'GET'],
      ['/v1/channels', 'POST'],
      ['/v1/channels/order', 'PUT'],
      ['/v1/channels/00000000-0000-4000-8000-000000000000', 'PATCH'],
      ['/v1/channels/00000000-0000-4000-8000-000000000000', 'DELETE'],
    ]) {
      const res = await request(path!, method!);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: { code: 'database_unavailable', message: '数据库不可用' },
      });
    }
  });
});
