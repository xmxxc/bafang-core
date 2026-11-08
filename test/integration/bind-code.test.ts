import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../../src/app';
import { createDb } from '../../src/db';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';

describe('binding codes over HTTP', () => {
  let db: TestSchema;
  let sentCode = '';
  let offsetMs = 0;
  const clock = { now: () => new Date(Date.parse('2026-11-06T02:00:00Z') + offsetMs) };
  const mailer = {
    async sendVerificationCode(_email: string, code: string) {
      sentCode = code;
    },
  };
  const wechat = {
    async openid(code: string) {
      return `openid-${code}`;
    },
  };

  beforeEach(async () => {
    db = await createTestSchema();
    sentCode = '';
    offsetMs = 0;
  });
  afterEach(async () => dropTestSchema(db));

  const app = (extra: AppDeps = {}) =>
    createApp({ database: createDb(db.pool), mailer, clock, wechat, ...extra });

  async function webLogin(target: ReturnType<typeof app>, email = 'web@example.com') {
    await target.request('/v1/auth/email/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const response = await target.request('/v1/auth/email/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code: sentCode, device: 'web' }),
    });
    return response.headers
      .getSetCookie()
      .find((value) => value.startsWith('bafang_session='))!
      .split(';')[0]!;
  }

  async function miniLogin(target: ReturnType<typeof app>, code: string) {
    const response = await target.request('/v1/auth/wechat/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    return (await response.json()) as { user: { id: string }; token: string };
  }

  it('generates only for web sessions and returns a one-time six-digit code', async () => {
    const target = app();
    const web = await webLogin(target);
    const generated = await target.request('/v1/auth/bind-code', {
      method: 'POST',
      headers: { Cookie: web },
    });
    expect(generated.status).toBe(201);
    const body = (await generated.json()) as { code: string; expiresAt: string };
    expect(body.code).toMatch(/^\d{6}$/);
    expect(Date.parse(body.expiresAt)).toBe(clock.now().getTime() + 600_000);

    const mini = await miniLogin(target, 'web-only-check');
    const denied = await target.request('/v1/auth/bind-code', {
      method: 'POST',
      headers: { Authorization: `Bearer ${mini.token}` },
    });
    expect(denied.status).toBe(403);
    expect((await denied.json()) as object).toMatchObject({
      error: { code: 'bind_code_web_required' },
    });
  });

  it('transfers an empty WeChat user, returns a miniprogram session, and consumes once', async () => {
    const target = app();
    const web = await webLogin(target);
    const generated = await target.request('/v1/auth/bind-code', {
      method: 'POST',
      headers: { Cookie: web },
    });
    const bindCode = ((await generated.json()) as { code: string }).code;
    const empty = await miniLogin(target, 'transfer');
    const bound = await target.request('/v1/auth/wechat/bind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'transfer', bindCode }),
    });
    expect(bound.status).toBe(200);
    const body = (await bound.json()) as { user: { id: string }; token: string };
    expect(body.user.id).not.toBe(empty.user.id);
    expect(
      (await target.request('/v1/me', { headers: { Authorization: `Bearer ${body.token}` } }))
        .status,
    ).toBe(200);
    expect(
      (await target.request('/v1/me', { headers: { Authorization: `Bearer ${empty.token}` } }))
        .status,
    ).toBe(401);

    const replay = await target.request('/v1/auth/wechat/bind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'transfer', bindCode }),
    });
    expect(replay.status).toBe(400);
    expect((await replay.json()) as object).toMatchObject({ error: { code: 'bind_code_used' } });
  });

  it('distinguishes invalid and expired codes and reuses the shared conflict rules', async () => {
    const target = app();
    const web = await webLogin(target);
    const generated = await target.request('/v1/auth/bind-code', {
      method: 'POST',
      headers: { Cookie: web },
    });
    const bindCode = ((await generated.json()) as { code: string }).code;
    const invalid = await target.request('/v1/auth/wechat/bind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'invalid', bindCode: '000000' }),
    });
    expect((await invalid.json()) as object).toMatchObject({
      error: { code: 'bind_code_invalid' },
    });
    offsetMs = 600_001;
    const expired = await target.request('/v1/auth/wechat/bind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'expired', bindCode }),
    });
    expect((await expired.json()) as object).toMatchObject({
      error: { code: 'bind_code_expired' },
    });
  });

  it('returns login-method conflicts and is idempotent for the already-linked WeChat identity', async () => {
    const target = app({ hasUserPositions: async () => true });
    const web = await webLogin(target);
    const firstCode = (
      (await (
        await target.request('/v1/auth/bind-code', { method: 'POST', headers: { Cookie: web } })
      ).json()) as { code: string }
    ).code;
    expect(
      (
        await target.request('/v1/auth/wechat/bind', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: 'same', bindCode: firstCode }),
        })
      ).status,
    ).toBe(200);
    const secondCode = (
      (await (
        await target.request('/v1/auth/bind-code', { method: 'POST', headers: { Cookie: web } })
      ).json()) as { code: string }
    ).code;
    const idempotent = await target.request('/v1/auth/wechat/bind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'same', bindCode: secondCode }),
    });
    expect(idempotent.status).toBe(200);
    const thirdCode = (
      (await (
        await target.request('/v1/auth/bind-code', { method: 'POST', headers: { Cookie: web } })
      ).json()) as { code: string }
    ).code;
    const conflict = await target.request('/v1/auth/wechat/bind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'other', bindCode: thirdCode }),
    });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()) as object).toMatchObject({
      error: { code: 'login_method_type_conflict' },
    });
  });

  it('rejects a WeChat identity that belongs to a user with positions', async () => {
    const target = app({ hasUserPositions: async () => true });
    await miniLogin(target, 'held');
    const web = await webLogin(target, 'conflict@example.com');
    const bindCode = (
      (await (
        await target.request('/v1/auth/bind-code', {
          method: 'POST',
          headers: { Cookie: web },
        })
      ).json()) as { code: string }
    ).code;
    const rejected = await target.request('/v1/auth/wechat/bind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'held', bindCode }),
    });
    expect(rejected.status).toBe(409);
    expect((await rejected.json()) as object).toMatchObject({
      error: { code: 'login_method_conflict' },
    });
    const retry = await target.request('/v1/auth/wechat/bind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'held', bindCode }),
    });
    expect(retry.status).toBe(409);
  });

  it('allows only one concurrent consumer for the same code', async () => {
    const target = app();
    const web = await webLogin(target, 'race@example.com');
    const bindCode = (
      (await (
        await target.request('/v1/auth/bind-code', {
          method: 'POST',
          headers: { Cookie: web },
        })
      ).json()) as { code: string }
    ).code;
    const responses = await Promise.all(
      ['race-one', 'race-two'].map((code) =>
        target.request('/v1/auth/wechat/bind', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, bindCode }),
        }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    const errors = await Promise.all(
      responses.filter((response) => response.status === 400).map((response) => response.json()),
    );
    expect(errors[0]).toMatchObject({ error: { code: 'bind_code_used' } });
  });
});
