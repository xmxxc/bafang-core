import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../../src/app';
import { createDb } from '../../src/db';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';

const root = '/v1/auth/wechat/qr';

describe('QR sign-in over HTTP', () => {
  let database: TestSchema;
  beforeEach(async () => {
    database = await createTestSchema();
  });
  afterEach(async () => {
    await dropTestSchema(database);
  });

  let offsetMs = 0;
  function target(extra: AppDeps = {}) {
    return createApp({
      database: createDb(database.pool),
      clock: { now: () => new Date(Date.parse('2026-11-06T02:00:00Z') + offsetMs) },
      wechat: {
        async openid(code) {
          return code;
        },
      },
      wechatQr: {
        async generate(scene) {
          return { contentType: 'image/png', base64: Buffer.from(scene).toString('base64') };
        },
      },
      ...extra,
    });
  }
  beforeEach(() => {
    offsetMs = 0;
  });
  async function start(app: ReturnType<typeof target>) {
    const response = await app.request(root, { method: 'POST' });
    expect(response.status).toBe(201);
    return {
      ...((await response.json()) as { ticketId: string; expiresAt: string }),
      cookie: response.headers.getSetCookie()[0]!.split(';')[0]!,
      browserExpiresAt: Date.parse(
        response.headers.getSetCookie()[0]!.match(/Expires=([^;]+)/)![1]!,
      ),
      browserMaxAgeMs:
        Number(response.headers.getSetCookie()[0]!.match(/Max-Age=(\d+)/)![1]) * 1000,
    };
  }
  async function mini(app: ReturnType<typeof target>, code = 'wechat-user') {
    const response = await app.request('/v1/auth/wechat/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as { user: { id: string }; token: string };
  }
  function confirm(app: ReturnType<typeof target>, ticketId: string, token?: string) {
    return app.request(`${root}/${ticketId}/confirm`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  }

  it('confirms with the miniprogram Bearer session and delivers a web session once', async () => {
    const app = target();
    const request = await start(app);
    const glance = await mini(app);
    const confirmation = await confirm(app, request.ticketId, glance.token);
    expect(confirmation.status).toBe(200);
    expect(await confirmation.json()).toEqual({ status: 'confirmed' });
    expect(confirmation.headers.get('set-cookie')).toBeNull();
    const poll = await app.request(`${root}/${request.ticketId}`, {
      headers: { Cookie: request.cookie },
    });
    expect(poll.status).toBe(200);
    expect(await poll.json()).toEqual({
      status: 'confirmed',
      user: glance.user,
      session: { device: 'web', expiresAt: '2026-12-06T02:00:00.000Z' },
      token: null,
    });
    const webCookie = poll.headers
      .getSetCookie()
      .find((value) => value.startsWith('bafang_session='))!;
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/'])
      expect(webCookie).toContain(flag);
    expect(
      await (await app.request('/v1/me', { headers: { Cookie: webCookie.split(';')[0]! } })).json(),
    ).toMatchObject({ user: glance.user });
    const replay = await app.request(`${root}/${request.ticketId}`, {
      headers: { Cookie: request.cookie },
    });
    expect(await replay.json()).toEqual({ status: 'consumed' });
    expect(replay.headers.get('set-cookie')).toBeNull();
    await app.request('/v1/auth/logout', {
      method: 'POST',
      headers: { Cookie: webCookie.split(';')[0]! },
    });
    expect(
      (await app.request('/v1/me', { headers: { Authorization: `Bearer ${glance.token}` } }))
        .status,
    ).toBe(200);
  });

  it('rejects anonymous, invalid, revoked, Cookie-only and web-session confirmations', async () => {
    const app = target();
    const request = await start(app);
    for (const token of [undefined, 'invalid']) {
      const response = await confirm(app, request.ticketId, token);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: 'unauthorized' } });
    }
    const glance = await mini(app);
    const cookieOnly = await app.request(`${root}/${request.ticketId}/confirm`, {
      method: 'POST',
      headers: { Cookie: `bafang_session=${glance.token}` },
    });
    expect(cookieOnly.status).toBe(401);
    await app.request('/v1/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${glance.token}` },
    });
    expect((await confirm(app, request.ticketId, glance.token)).status).toBe(401);
    const active = await mini(app);
    expect((await confirm(app, request.ticketId, active.token)).status).toBe(200);
    const delivered = await app.request(`${root}/${request.ticketId}`, {
      headers: { Cookie: request.cookie },
    });
    const web = delivered.headers
      .getSetCookie()
      .find((value) => value.startsWith('bafang_session='))!
      .split(';')[0]!;
    const other = await start(app);
    expect(
      (
        await app.request(`${root}/${other.ticketId}/confirm`, {
          method: 'POST',
          headers: { Cookie: web },
        })
      ).status,
    ).toBe(401);
    const webToken = web.slice('bafang_session='.length);
    const rejected = await confirm(app, other.ticketId, webToken);
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ error: { code: 'qr_miniprogram_required' } });
  });

  it('distinguishes nonexistent, expired, already confirmed and consumed tickets', async () => {
    const app = target();
    const glance = await mini(app);
    const missing = await confirm(app, 'a'.repeat(32), glance.token);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: 'qr_ticket_invalid' } });
    const request = await start(app);
    expect((await confirm(app, request.ticketId, glance.token)).status).toBe(200);
    const duplicate = await confirm(app, request.ticketId, glance.token);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: { code: 'qr_ticket_confirmed' } });
    await app.request(`${root}/${request.ticketId}`, { headers: { Cookie: request.cookie } });
    const consumed = await confirm(app, request.ticketId, glance.token);
    expect(consumed.status).toBe(409);
    expect(await consumed.json()).toMatchObject({ error: { code: 'qr_ticket_used' } });
    const expired = await start(app);
    offsetMs = 300_000;
    const denied = await confirm(app, expired.ticketId, glance.token);
    expect(denied.status).toBe(400);
    expect(await denied.json()).toMatchObject({ error: { code: 'qr_ticket_expired' } });
    const poll = await app.request(`${root}/${expired.ticketId}`, {
      headers: { Cookie: expired.cookie },
    });
    expect(await poll.json()).toEqual({ status: 'expired' });
    expect(poll.headers.get('set-cookie')).toBeNull();
  });

  it('expires a confirmed ticket before delivery and honors a configured TTL', async () => {
    const app = target({ qrTicketTtlMs: 60_000 });
    const request = await start(app);
    expect(request.expiresAt).toBe('2026-11-06T02:01:00.000Z');
    const glance = await mini(app);
    await confirm(app, request.ticketId, glance.token);
    offsetMs = 60_000;
    // 浏览器仅在 Max-Age 与 Expires 均未到期时发送临时 Cookie。
    const browserStillHasCookie =
      offsetMs < request.browserMaxAgeMs &&
      Date.parse('2026-11-06T02:01:00Z') < request.browserExpiresAt;
    const poll = await app.request(`${root}/${request.ticketId}`, {
      headers: browserStillHasCookie ? { Cookie: request.cookie } : {},
    });
    expect(await poll.json()).toEqual({ status: 'expired' });
    expect(poll.headers.get('set-cookie')).toBeNull();
  });

  it('blocks leaked tickets without the original browser Cookie without consuming the session', async () => {
    const app = target();
    const original = await start(app);
    const other = await start(app);
    const glance = await mini(app);
    await confirm(app, original.ticketId, glance.token);
    for (const cookie of [undefined, '__Host-bafang_qr=wrong', other.cookie]) {
      const response = await app.request(`${root}/${original.ticketId}`, {
        headers: cookie ? { Cookie: cookie } : {},
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'qr_browser_invalid' } });
      expect(response.headers.get('set-cookie')).toBeNull();
    }
    const response = await app.request(`${root}/${original.ticketId}`, {
      headers: { Cookie: original.cookie },
    });
    expect(await response.json()).toMatchObject({ status: 'confirmed', user: glance.user });
  });

  it('allows just one concurrent confirmer and one concurrent session delivery across app instances', async () => {
    const a = target();
    const b = target();
    const request = await start(a);
    const first = await mini(a, 'one');
    const second = await mini(b, 'two');
    const confirmations = await Promise.all([
      confirm(a, request.ticketId, first.token),
      confirm(b, request.ticketId, second.token),
    ]);
    expect(confirmations.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = confirmations[0]!.status === 200 ? first : second;
    const polls = await Promise.all(
      [a, b].map((app) =>
        app.request(`${root}/${request.ticketId}`, { headers: { Cookie: request.cookie } }),
      ),
    );
    const bodies = await Promise.all(
      polls.map(async (r) => (await r.json()) as { status: string; user?: { id: string } }),
    );
    expect(bodies.filter((body) => body.status === 'confirmed')).toEqual([
      expect.objectContaining({ user: winner.user, token: null }),
    ]);
    expect(bodies.filter((body) => body.status === 'consumed')).toHaveLength(1);
    expect(polls.filter((r) => r.headers.get('set-cookie'))).toHaveLength(1);
  });

  it('keeps the delivered web session active when the confirming miniprogram logs out', async () => {
    const app = target();
    const request = await start(app);
    const glance = await mini(app);
    await confirm(app, request.ticketId, glance.token);
    const delivered = await app.request(`${root}/${request.ticketId}`, {
      headers: { Cookie: request.cookie },
    });
    const web = delivered.headers
      .getSetCookie()
      .find((value) => value.startsWith('bafang_session='))!
      .split(';')[0]!;
    await app.request('/v1/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${glance.token}` },
    });
    expect((await app.request('/v1/me', { headers: { Cookie: web } })).status).toBe(200);
    expect(
      (await app.request('/v1/me', { headers: { Authorization: `Bearer ${glance.token}` } }))
        .status,
    ).toBe(401);
  });

  it('validates ticket IDs and fails closed without configuration or database', async () => {
    for (const [app, error] of [
      [target({ wechatQr: undefined }), 'wechat_not_configured'],
      [
        createApp({
          wechatQr: {
            async generate() {
              throw new Error('unused');
            },
          },
        }),
        'database_unavailable',
      ],
    ] as const) {
      for (const [path, method] of [
        [root, 'POST'],
        [`${root}/${'a'.repeat(32)}`, 'GET'],
        [`${root}/${'a'.repeat(32)}/confirm`, 'POST'],
      ] as const) {
        const response = await app.request(path, { method });
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ error: { code: error } });
        expect(response.headers.get('cache-control')).toBe('no-store');
      }
    }
    expect((await target().request(`${root}/bad-id`)).status).toBe(400);
    expect((await target().request(`${root}/bad-id/confirm`, { method: 'POST' })).status).toBe(400);
  });

  it('limits ticket creation by IP including failed attempts and resets the window', async () => {
    const app = target({
      wechatQr: {
        async generate() {
          throw new Error('secret upstream');
        },
      },
    });
    for (let i = 0; i < 5; i++)
      expect((await app.request(root, { method: 'POST' })).status).toBe(502);
    const limited = await app.request(root, { method: 'POST' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect(
      (await app.request(root, { method: 'POST', headers: { 'X-Forwarded-For': '203.0.113.2' } }))
        .status,
    ).toBe(502);
    offsetMs = 60_000;
    expect((await app.request(root, { method: 'POST' })).status).toBe(502);
  });

  it('limits polling by ticket even across IPs, and by IP across tickets', async () => {
    const app = target();
    const request = await start(app);
    for (let i = 0; i < 60; i++) {
      expect(
        (
          await app.request(`${root}/${request.ticketId}`, {
            headers: { Cookie: request.cookie, 'X-Forwarded-For': `ip-${i}` },
          })
        ).status,
      ).toBe(200);
    }
    const limited = await app.request(`${root}/${request.ticketId}`, {
      headers: { Cookie: request.cookie, 'X-Forwarded-For': 'another' },
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    for (let i = 0; i < 120; i++) {
      expect(
        (
          await app.request(`${root}/${String(i).padStart(32, '0')}`, {
            headers: { 'X-Forwarded-For': 'same-ip' },
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await app.request(`${root}/${'z'.repeat(32)}`, {
          headers: { 'X-Forwarded-For': 'same-ip' },
        })
      ).status,
    ).toBe(429);
    offsetMs = 60_000;
    expect(
      (await app.request(`${root}/${request.ticketId}`, { headers: { Cookie: request.cookie } }))
        .status,
    ).toBe(200);
  });

  it('generates a scene-bearing miniprogram code and polls pending in the initiating browser', async () => {
    const app = createApp({
      database: createDb(database.pool),
      clock: { now: () => new Date('2026-11-06T02:00:00Z') },
      wechatQr: {
        async generate(scene: string) {
          return {
            contentType: 'image/png' as const,
            base64: Buffer.from(scene).toString('base64'),
          };
        },
      },
    });
    const response = await app.request(root, { method: 'POST' });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      ticketId: string;
      expiresAt: string;
      image: { contentType: string; base64: string };
    };
    expect(body.ticketId).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(body.expiresAt).toBe('2026-11-06T02:05:00.000Z');
    expect(body.image).toEqual({
      contentType: 'image/png',
      base64: Buffer.from(body.ticketId).toString('base64'),
    });
    const cookie = response.headers.getSetCookie()[0]!;
    expect(cookie).toContain('__Host-bafang_qr=');
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=600'])
      expect(cookie).toContain(flag);
    const poll = await app.request(`${root}/${body.ticketId}`, {
      headers: { Cookie: cookie.split(';')[0]! },
    });
    expect(poll.status).toBe(200);
    expect(await poll.json()).toEqual({ status: 'pending' });
    expect(poll.headers.get('set-cookie')).toBeNull();
    expect(poll.headers.get('cache-control')).toBe('no-store');
  });
});
