import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../../src/app';
import { createDb } from '../../src/db';
import { loadConfig } from '../../src/config';
import { createWeChatLogin, HttpWeChatCode2Session } from '../../src/auth/wechat';
import type { MeResponse, WeChatLoginResponse } from '../../src/routes/auth';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';

describe('WeChat login over HTTP with real PostgreSQL and a fake WeChat adapter', () => {
  let database: TestSchema;
  beforeEach(async () => {
    database = await createTestSchema();
  });
  afterEach(async () => {
    await dropTestSchema(database);
  });

  function target(deps: AppDeps = {}) {
    return createApp({
      database: createDb(database.pool),
      wechat: {
        async openid() {
          return 'wechat-user';
        },
      },
      clock: { now: () => new Date('2026-11-06T02:00:00Z') },
      ...deps,
    });
  }
  function login(app: ReturnType<typeof target>, code = 'valid-code') {
    return app.request('/v1/auth/wechat/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
  }
  async function current(app: ReturnType<typeof target>, token: string) {
    const response = await app.request('/v1/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    return (await response.json()) as MeResponse;
  }

  it('creates a user identified by openid with three preset channels and a Bearer session without a Cookie', async () => {
    const app = target();
    const response = await login(app);
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as WeChatLoginResponse;
    expect(body).toEqual({
      user: { id: expect.any(String) },
      session: { device: 'miniprogram', expiresAt: '2026-12-06T02:00:00.000Z' },
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    const me = await current(app, body.token);
    expect(me.user).toEqual(body.user);
    expect(me.loginMethods).toEqual([{ type: 'wechat', externalId: 'wechat-user' }]);
    expect(me.channels.map((channel) => channel.name)).toEqual(['支付宝', '天天基金', '未指定']);
    expect((await app.request('/v1/me')).status).toBe(401);
  });

  it('exchanges wx.login code through the real adapter with a fake HTTP transport and needs no unionid', async () => {
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (
        url.origin !== 'https://api.weixin.qq.com' ||
        url.pathname !== '/sns/jscode2session' ||
        url.searchParams.get('appid') !== 'test-app-id' ||
        url.searchParams.get('secret') !== 'test-app-secret' ||
        url.searchParams.get('js_code') !== 'valid-code' ||
        url.searchParams.get('grant_type') !== 'authorization_code' ||
        init?.method !== 'GET' ||
        init?.redirect !== 'error' ||
        !init.signal
      )
        return Response.json({ errcode: -1 });
      return Response.json({ openid: 'wire-user', session_key: 'private-session-key' });
    };
    const app = target({
      wechat: new HttpWeChatCode2Session('test-app-id', 'test-app-secret', fetcher),
    });
    const response = await login(app);
    expect(response.status).toBe(200);
    const body = (await response.json()) as WeChatLoginResponse;
    expect(JSON.stringify(body)).not.toContain('private-session-key');
    expect((await current(app, body.token)).loginMethods).toEqual([
      { type: 'wechat', externalId: 'wire-user' },
    ]);
  });

  it('returns the same user and channel IDs for the same openid across app instances', async () => {
    const firstApp = target();
    const first = (await (await login(firstApp)).json()) as WeChatLoginResponse;
    const original = await current(firstApp, first.token);
    const secondApp = target();
    const second = (await (await login(secondApp, 'another-code')).json()) as WeChatLoginResponse;
    expect(second.token).not.toBe(first.token);
    expect(await current(secondApp, second.token)).toEqual(original);
  });

  it('serializes concurrent first logins for the same openid into one user and three channels', async () => {
    const a = target();
    const b = target();
    const responses = await Promise.all([login(a, 'first-code'), login(b, 'second-code')]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const [first, second] = (await Promise.all(
      responses.map((response) => response.json()),
    )) as WeChatLoginResponse[];
    const original = await current(a, first!.token);
    expect(original.channels).toHaveLength(3);
    expect(await current(b, second!.token)).toEqual(original);
  });

  it('keeps different openids separate even when WeChat supplies the same unionid', async () => {
    const fetcher: typeof fetch = async (input) => {
      const code = new URL(String(input)).searchParams.get('js_code');
      return Response.json({ openid: code, session_key: 'private-key', unionid: 'same-unionid' });
    };
    const app = target({ wechat: new HttpWeChatCode2Session('app', 'secret', fetcher) });
    const first = (await (await login(app, 'openid-a')).json()) as WeChatLoginResponse;
    const second = (await (await login(app, 'openid-b')).json()) as WeChatLoginResponse;
    expect(first.user.id).not.toBe(second.user.id);
    expect((await current(app, first.token)).loginMethods).toEqual([
      { type: 'wechat', externalId: 'openid-a' },
    ]);
    expect((await current(app, second.token)).loginMethods).toEqual([
      { type: 'wechat', externalId: 'openid-b' },
    ]);
  });

  it('revokes only the current miniprogram session and keeps the same user signed in on another device', async () => {
    const app = target();
    const first = (await (await login(app)).json()) as WeChatLoginResponse;
    const second = (await (await login(app, 'second-code')).json()) as WeChatLoginResponse;
    expect(second.user).toEqual(first.user);
    const original = await current(app, second.token);
    const logout = await app.request('/v1/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${first.token}` },
    });
    expect(logout.status).toBe(204);
    expect(
      (await app.request('/v1/me', { headers: { Authorization: `Bearer ${first.token}` } })).status,
    ).toBe(401);
    expect(await current(app, second.token)).toEqual(original);
  });

  async function rejected(response: Response, code: string, status: number) {
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code, message: expect.any(String) } });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
  }

  it.each([40029, 40163])('returns wechat_code_invalid for WeChat error %s', async (errcode) => {
    const app = target({
      wechat: new HttpWeChatCode2Session('app', 'secret', async () =>
        Response.json({ errcode, errmsg: 'private details' }),
      ),
    });
    await rejected(await login(app), 'wechat_code_invalid', 400);
    expect((await app.request('/v1/me')).status).toBe(401);
  });

  it.each([
    ['rate limit', () => Response.json({ errcode: 45011 })],
    ['system busy', () => Response.json({ errcode: -1 })],
    ['blocked login', () => Response.json({ errcode: 40226 })],
    ['invalid app credentials', () => Response.json({ errcode: 40013 })],
    [
      'error with openid',
      () => Response.json({ errcode: -1, openid: 'untrusted', session_key: 'private-key' }),
    ],
    ['HTTP rate limit', () => Response.json({ errcode: 40029 }, { status: 429 })],
    ['HTTP failure', () => Response.json({}, { status: 503 })],
    ['missing openid', () => Response.json({ session_key: 'private-key' })],
    ['empty openid', () => Response.json({ openid: '', session_key: 'private-key' })],
    ['wrong openid type', () => Response.json({ openid: 123, session_key: 'private-key' })],
    ['whitespace openid', () => Response.json({ openid: ' bad ', session_key: 'private-key' })],
    ['missing session key', () => Response.json({ openid: 'untrusted' })],
    [
      'malformed error code',
      () => Response.json({ errcode: '0', openid: 'untrusted', session_key: 'private-key' }),
    ],
    ['malformed JSON', () => new Response('not JSON')],
    ['null JSON', () => Response.json(null)],
    [
      'network failure',
      () => {
        throw new Error('network secret');
      },
    ],
    [
      'timeout',
      () => {
        throw new DOMException('timeout secret', 'TimeoutError');
      },
    ],
  ])(
    'fails closed on %s, issues no session and leaves the existing user unchanged',
    async (_name, fail) => {
      const existingApp = target();
      const session = (await (await login(existingApp)).json()) as WeChatLoginResponse;
      const original = await current(existingApp, session.token);
      let unavailable = true;
      const fetcher: typeof fetch = async () =>
        unavailable
          ? fail()
          : Response.json({ errcode: 0, openid: 'fresh-user', session_key: 'private-key' });
      const app = target({ wechat: new HttpWeChatCode2Session('app', 'secret', fetcher) });
      await rejected(await login(app), 'wechat_unavailable', 502);
      expect((await app.request('/v1/me')).status).toBe(401);
      expect(await current(app, session.token)).toEqual(original);
      unavailable = false;
      const success = await login(app, 'fresh-code');
      expect(success.status).toBe(200);
      const body = (await success.json()) as WeChatLoginResponse;
      expect(body.user.id).not.toBe(session.user.id);
      const fresh = await current(app, body.token);
      expect(fresh.loginMethods).toEqual([{ type: 'wechat', externalId: 'fresh-user' }]);
      expect(fresh.channels).toHaveLength(3);
    },
  );

  it.each([
    {},
    { WECHAT_APP_ID: 'app' },
    { WECHAT_APP_SECRET: 'secret' },
    { WECHAT_APP_ID: 'app', WECHAT_APP_SECRET: ' ' },
  ])(
    'keeps the app available with missing or partial WeChat environment configuration (%j)',
    async (env) => {
      const app = target({
        wechat: createWeChatLogin(loadConfig({ PGPASSWORD: 'test-only', ...env })),
      });
      expect((await app.request('/v1/openapi')).status).toBe(200);
      await rejected(await login(app), 'wechat_not_configured', 503);
    },
  );

  it.each([{}, { code: '' }, { code: 'bad code' }, { code: 'a'.repeat(513) }, { code: 123 }])(
    'rejects malformed login input (%j)',
    async (body) => {
      const response = await target().request('/v1/auth/wechat/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await rejected(response, 'validation_error', 400);
    },
  );

  it('limits login by the trusted client IP and opens a fresh window after one minute', async () => {
    let now = new Date('2026-11-06T02:00:00Z');
    const app = target({
      clock: { now: () => now },
      wechat: new HttpWeChatCode2Session('app', 'secret', async () =>
        Response.json({ errcode: 40029 }),
      ),
    });
    const attempt = (ip: string) =>
      app.request('/v1/auth/wechat/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
        body: JSON.stringify({ code: 'bad' }),
      });
    for (let i = 0; i < 10; i++) expect((await attempt('spoofed, 192.0.2.1')).status).toBe(400);
    const limited = await attempt('different-spoof, 192.0.2.1');
    expect(limited.headers.get('retry-after')).toBe('60');
    await rejected(limited, 'rate_limited', 429);
    expect((await attempt('192.0.2.2')).status).toBe(400);
    now = new Date('2026-11-06T02:01:00Z');
    expect((await attempt('192.0.2.1')).status).toBe(400);
  });

  it('does not retry a failed one-time code exchange even when the next upstream response would succeed', async () => {
    let first = true;
    const fetcher: typeof fetch = async () => {
      if (first) {
        first = false;
        return new Response(null, { status: 503 });
      }
      return Response.json({ openid: 'wire-user', session_key: 'private-key' });
    };
    const app = target({ wechat: new HttpWeChatCode2Session('app', 'secret', fetcher) });
    await rejected(await login(app), 'wechat_unavailable', 502);
    const next = await login(app, 'fresh-code');
    expect(next.status).toBe(200);
    const body = (await next.json()) as WeChatLoginResponse;
    expect((await current(app, body.token)).channels).toHaveLength(3);
  });

  it('does not associate WeChat with a signed-in web user or revoke that web session on miniprogram logout', async () => {
    let sentCode = '';
    const app = target({
      mailer: {
        async sendVerificationCode(_email, code) {
          sentCode = code;
        },
      },
    });
    await app.request('/v1/auth/email/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com' }),
    });
    const email = await app.request('/v1/auth/email/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', code: sentCode, device: 'web' }),
    });
    expect(email.status).toBe(200);
    const cookie = email.headers.get('set-cookie')!.split(';')[0]!;
    const web = await app.request('/v1/me', { headers: { Cookie: cookie } });
    const original = (await web.json()) as MeResponse;
    const wechat = await app.request('/v1/auth/wechat/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ code: 'valid-code' }),
    });
    expect(wechat.status).toBe(200);
    expect(wechat.headers.get('set-cookie')).toBeNull();
    const body = (await wechat.json()) as WeChatLoginResponse;
    expect(body.user.id).not.toBe(original.user.id);
    expect((await current(app, body.token)).loginMethods).toEqual([
      { type: 'wechat', externalId: 'wechat-user' },
    ]);
    expect(
      (
        await app.request('/v1/auth/logout', {
          method: 'POST',
          headers: { Authorization: `Bearer ${body.token}` },
        })
      ).status,
    ).toBe(204);
    const stillSignedIn = await app.request('/v1/me', { headers: { Cookie: cookie } });
    expect(stillSignedIn.status).toBe(200);
    expect(await stillSignedIn.json()).toEqual(original);
  });

  it('documents the miniprogram session and all WeChat errors in OpenAPI', async () => {
    const response = await target().request('/v1/openapi');
    const doc = (await response.json()) as {
      paths: Record<string, { post: { responses: Record<string, unknown>; requestBody: unknown } }>;
      components: {
        schemas: {
          WeChatLoginResult: unknown;
          Error: { properties: { error: { properties: { code: { enum: string[] } } } } };
        };
      };
    };
    const operation = doc.paths['/v1/auth/wechat/login']!.post;
    for (const status of ['200', '400', '429', '500', '502', '503'])
      expect(operation.responses).toHaveProperty(status);
    expect(operation.requestBody).toMatchObject({ required: true });
    expect(doc.components.schemas.WeChatLoginResult).toMatchObject({
      properties: { token: { type: 'string' } },
    });
    expect(doc.components.schemas.Error.properties.error.properties.code.enum).toEqual(
      expect.arrayContaining([
        'wechat_code_invalid',
        'wechat_unavailable',
        'wechat_not_configured',
      ]),
    );
  });
});
