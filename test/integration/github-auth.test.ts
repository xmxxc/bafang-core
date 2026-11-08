import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MeResponse } from '../../src/routes/auth';
import { createHash } from 'node:crypto';
import { createGitHubLogin, HttpGitHubOAuth, type GitHubOAuth } from '../../src/auth/github';
import { loadConfig } from '../../src/config';
import { createApp, type AppDeps } from '../../src/app';
import { createDb } from '../../src/db';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';

describe('GitHub login over HTTP with real PostgreSQL and a fake GitHub adapter', () => {
  let database: TestSchema;
  let now: Date;
  beforeEach(async () => {
    database = await createTestSchema();
    now = new Date('2026-11-06T02:00:00Z');
  });
  afterEach(async () => {
    await dropTestSchema(database);
  });

  const oauth: GitHubOAuth = {
    authorizationUrl(state, challenge) {
      const url = new URL('https://github.com/login/oauth/authorize');
      url.search = new URLSearchParams({
        client_id: 'test-client',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString();
      return url.toString();
    },
    async userId() {
      return '12345';
    },
  };
  function target(deps: AppDeps = {}) {
    return createApp({
      database: createDb(database.pool),
      github: { oauth, redirectUrl: 'https://studio.example.com/' },
      clock: { now: () => now },
      ...deps,
    });
  }
  async function begin(app: ReturnType<typeof target>, query = '') {
    const response = await app.request('/v1/auth/github' + query);
    expect(response.status).toBe(302);
    const url = new URL(response.headers.get('location')!);
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    return { state: url.searchParams.get('state')!, cookie, response, url };
  }
  function callback(app: ReturnType<typeof target>, state: string, cookie: string, extra = '') {
    return app.request(
      '/v1/auth/github/callback?code=valid&state=' + encodeURIComponent(state) + extra,
      { headers: { Cookie: cookie } },
    );
  }
  async function current(app: ReturnType<typeof target>, response: Response) {
    const cookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith('bafang_session='))!
      .split(';')[0]!;
    const me = await app.request('/v1/me', { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    return (await me.json()) as MeResponse;
  }

  it('creates a user with the GitHub numeric ID, three preset channels and the standard web session Cookie', async () => {
    const app = target();
    const start = await begin(app);
    expect(start.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(start.url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(start.response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(start.response.headers.get('set-cookie')).toContain('Secure');
    expect(start.response.headers.get('set-cookie')).toContain('SameSite=Lax');
    const response = await callback(app, start.state, start.cookie);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://studio.example.com/');
    const cookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith('bafang_session='))!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    const me = await current(app, response);
    expect(me.loginMethods).toEqual([{ type: 'github', externalId: '12345' }]);
    expect(me.channels.map((channel) => channel.name)).toEqual(['支付宝', '天天基金', '未指定']);
  });

  async function rejected(response: Response, code = 'github_state_invalid', status = 400) {
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
    expect(
      response.headers.getSetCookie().some((value) => value.startsWith('bafang_session=')),
    ).toBe(false);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
  }

  it('returns the same user and channel IDs on later logins, including across app instances', async () => {
    const app = target();
    const first = await begin(app);
    const original = await current(app, await callback(app, first.state, first.cookie));
    const anotherApp = target();
    const second = await begin(anotherApp);
    const again = await current(anotherApp, await callback(app, second.state, second.cookie));
    expect(again).toEqual(original);
  });

  it('serializes concurrent first logins for the same GitHub ID into one user and three channels', async () => {
    const app = target();
    const [first, second] = await Promise.all([begin(app), begin(app)]);
    const [a, b] = await Promise.all([
      callback(app, first.state, first.cookie),
      callback(app, second.state, second.cookie),
    ]);
    expect(a.status).toBe(302);
    expect(b.status).toBe(302);
    expect(await current(app, a)).toEqual(await current(app, b));
  });

  it('rejects state from a different request or browser before contacting GitHub', async () => {
    const app = target({
      github: {
        redirectUrl: 'https://studio.example.com/',
        oauth: {
          ...oauth,
          async userId() {
            throw new Error('must not reach GitHub');
          },
        },
      },
    });
    const [a, b] = await Promise.all([begin(app), begin(app)]);
    expect(a.state).not.toBe(b.state);
    expect(a.cookie).not.toBe(b.cookie);
    await rejected(await callback(app, a.state, b.cookie));
    await rejected(await callback(app, 'wrong-state', a.cookie));
  });

  it.each(['state', 'cookie', 'both'])(
    'rejects missing %s before contacting GitHub',
    async (missing) => {
      const app = target();
      const start = await begin(app);
      const query =
        missing === 'state' || missing === 'both'
          ? '?code=valid'
          : '?code=valid&state=' + start.state;
      const response = await app.request('/v1/auth/github/callback' + query, {
        headers: missing === 'cookie' || missing === 'both' ? {} : { Cookie: start.cookie },
      });
      await rejected(response);
    },
  );

  it('rejects expired state even when the original browser Cookie is replayed', async () => {
    const app = target();
    const start = await begin(app);
    now = new Date(now.getTime() + 600_000);
    await rejected(await callback(app, start.state, start.cookie));
  });

  it('rejects replay after success and permits only one concurrent callback', async () => {
    const app = target();
    const start = await begin(app);
    const responses = await Promise.all([
      callback(app, start.state, start.cookie),
      callback(app, start.state, start.cookie),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([302, 400]);
    await rejected(responses.find((response) => response.status === 400)!);
    await rejected(await callback(target(), start.state, start.cookie));
  });

  it.each(['error=access_denied', 'error=', ''])(
    'consumes state when authorization has no code (%s)',
    async (query) => {
      const app = target();
      const start = await begin(app);
      const response = await app.request(
        '/v1/auth/github/callback?state=' + start.state + '&' + query,
        { headers: { Cookie: start.cookie } },
      );
      await rejected(response, 'github_authorization_failed');
      await rejected(await callback(app, start.state, start.cookie));
    },
  );

  it('fails closed on GitHub failure, consumes state and allows a fresh attempt', async () => {
    let unavailable = true;
    const app = target({
      github: {
        redirectUrl: 'https://studio.example.com/',
        oauth: {
          ...oauth,
          async userId() {
            if (unavailable) throw new Error('secret upstream details');
            return '12345';
          },
        },
      },
    });
    const start = await begin(app);
    await rejected(await callback(app, start.state, start.cookie), 'github_unavailable', 502);
    expect((await app.request('/v1/me', { headers: { Cookie: start.cookie } })).status).toBe(401);
    unavailable = false;
    await rejected(await callback(app, start.state, start.cookie));
    const fresh = await begin(app);
    const me = await current(app, await callback(app, fresh.state, fresh.cookie));
    expect(me.loginMethods).toEqual([{ type: 'github', externalId: '12345' }]);
    expect(me.channels).toHaveLength(3);
  });

  it('uses only the configured redirect even when start and callback supply arbitrary URLs', async () => {
    const app = target();
    const start = await begin(
      app,
      '?redirect_uri=https://evil.example/callback&redirectUrl=https://evil.example/&next=//evil.example',
    );
    expect(start.url.origin).toBe('https://github.com');
    expect(start.url.toString()).not.toContain('evil.example');
    const response = await callback(
      app,
      start.state,
      start.cookie,
      '&redirectUrl=https://evil.example/&next=//evil.example',
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://studio.example.com/');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(
      response.headers.getSetCookie().find((value) => value.startsWith('__Host-bafang_github=')),
    ).toContain('Max-Age=0');
  });

  it('does not associate GitHub with an already signed-in email user', async () => {
    let code = '';
    const app = target({
      mailer: {
        async sendVerificationCode(_email, sent) {
          code = sent;
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
      body: JSON.stringify({ email: 'user@example.com', code, device: 'web' }),
    });
    const original = await current(app, email);
    const start = await begin(app);
    const cookie = email.headers.get('set-cookie')!.split(';')[0]!;
    const response = await callback(app, start.state, start.cookie + '; ' + cookie);
    const github = await current(app, response);
    expect(github.user.id).not.toBe(original.user.id);
    expect(github.loginMethods).toEqual([{ type: 'github', externalId: '12345' }]);
    expect(await current(app, email)).toEqual(original);
    const logout = await app.request('/v1/auth/logout', {
      method: 'POST',
      headers: {
        Cookie: response.headers
          .getSetCookie()
          .find((value) => value.startsWith('bafang_session='))!
          .split(';')[0]!,
      },
    });
    expect(logout.status).toBe(204);
    expect(await current(app, email)).toEqual(original);
  });

  it('documents both redirects and all GitHub business errors in OpenAPI', async () => {
    const response = await target().request('/v1/openapi');
    const doc = (await response.json()) as {
      paths: Record<string, { get: { responses: Record<string, unknown> } }>;
      components: {
        schemas: { Error: { properties: { error: { properties: { code: { enum: string[] } } } } } };
      };
    };
    for (const path of ['/v1/auth/github', '/v1/auth/github/callback']) {
      expect(doc.paths[path]?.get.responses).toHaveProperty('302');
      expect(doc.paths[path]?.get.responses).toHaveProperty('400');
      expect(doc.paths[path]?.get.responses).toHaveProperty('502');
      expect(doc.paths[path]?.get.responses).toHaveProperty('503');
    }
    expect(doc.components.schemas.Error.properties.error.properties.code.enum).toEqual(
      expect.arrayContaining([
        'github_not_configured',
        'github_state_invalid',
        'github_authorization_failed',
        'github_unavailable',
      ]),
    );
  });

  function httpGitHub(
    options: {
      token?: () => Response;
      user?: () => Response;
      networkFailure?: boolean;
    } = {},
  ) {
    let challenge = '';
    const fetcher: typeof fetch = async (input, init) => {
      if (options.networkFailure) throw new Error('network down with secret details');
      const headers = new Headers(init?.headers);
      if (String(input) === 'https://github.com/login/oauth/access_token') {
        const body = new URLSearchParams(init?.body as URLSearchParams);
        const verifier = body.get('code_verifier') ?? '';
        if (
          init?.method !== 'POST' ||
          body.get('client_id') !== 'client-id' ||
          body.get('client_secret') !== 'client-secret' ||
          body.get('redirect_uri') !== 'https://core.example.com/v1/auth/github/callback' ||
          body.get('code') !== 'valid' ||
          headers.get('Accept') !== 'application/json' ||
          createHash('sha256').update(verifier).digest('base64url') !== challenge
        ) {
          return Response.json({ error: 'incorrect OAuth request' }, { status: 400 });
        }
        return (
          options.token?.() ??
          Response.json({ access_token: 'fake-github-token', token_type: 'bearer' })
        );
      }
      if (
        String(input) === 'https://api.github.com/user' &&
        headers.get('Authorization') === 'Bearer fake-github-token'
      ) {
        return (
          options.user?.() ??
          Response.json({ id: 12345, login: 'octocat', email: 'private@example.com' })
        );
      }
      throw new Error('unexpected GitHub request');
    };
    const adapter = new HttpGitHubOAuth(
      'client-id',
      'client-secret',
      'https://core.example.com/v1/auth/github/callback',
      fetcher,
    );
    const app = target({ github: { oauth: adapter, redirectUrl: 'https://studio.example.com/' } });
    return {
      app,
      async start() {
        const result = await begin(app);
        challenge = result.url.searchParams.get('code_challenge')!;
        return result;
      },
    };
  }

  it('completes the real OAuth wire protocol with PKCE through a fake HTTP transport and ignores GitHub login name changes', async () => {
    let login = 'octocat';
    const http = httpGitHub({ user: () => Response.json({ id: 12345, login }) });
    const start = await http.start();
    expect(start.url.searchParams.get('client_id')).toBe('client-id');
    expect(start.url.searchParams.get('redirect_uri')).toBe(
      'https://core.example.com/v1/auth/github/callback',
    );
    expect(start.url.searchParams.get('scope')).toBe('');
    expect(start.url.searchParams.get('code_challenge_method')).toBe('S256');
    const first = await current(http.app, await callback(http.app, start.state, start.cookie));
    expect(first.loginMethods).toEqual([{ type: 'github', externalId: '12345' }]);
    login = 'renamed-user';
    const second = await http.start();
    expect(await current(http.app, await callback(http.app, second.state, second.cookie))).toEqual(
      first,
    );
  });

  it.each([
    ['network failure', { networkFailure: true }],
    ['token HTTP failure', { token: () => Response.json({ error: 'bad_code' }, { status: 401 }) }],
    ['token OAuth error', { token: () => Response.json({ error: 'bad_verification_code' }) }],
    ['missing token', { token: () => Response.json({ token_type: 'bearer' }) }],
    [
      'wrong token type',
      { token: () => Response.json({ access_token: 'fake-github-token', token_type: 'mac' }) },
    ],
    ['malformed token JSON', { token: () => new Response('not JSON') }],
    ['user HTTP failure', { user: () => Response.json({ error: 'unavailable' }, { status: 503 }) }],
    ['missing user ID', { user: () => Response.json({ login: 'octocat' }) }],
    ['string user ID', { user: () => Response.json({ id: '12345', login: 'octocat' }) }],
    ['unsafe numeric user ID', { user: () => Response.json({ id: 9007199254740992 }) }],
    ['zero user ID', { user: () => Response.json({ id: 0 }) }],
    ['fractional user ID', { user: () => Response.json({ id: 1.5 }) }],
    ['malformed user JSON', { user: () => new Response('not JSON') }],
  ])(
    'rejects %s without issuing a session or changing the signed-in user',
    async (_name, options) => {
      const existingApp = target();
      const existingStart = await begin(existingApp);
      const session = await callback(existingApp, existingStart.state, existingStart.cookie);
      const existing = await current(existingApp, session);
      const http = httpGitHub(options);
      const start = await http.start();
      const response = await callback(http.app, start.state, start.cookie);
      await rejected(response, 'github_unavailable', 502);
      expect((await http.app.request('/v1/me', { headers: { Cookie: start.cookie } })).status).toBe(
        401,
      );
      expect(await current(existingApp, session)).toEqual(existing);
      await rejected(await callback(http.app, start.state, start.cookie));
    },
  );

  it.each([
    {},
    { GITHUB_CLIENT_ID: 'client' },
    {
      GITHUB_CLIENT_ID: 'client',
      GITHUB_CLIENT_SECRET: ' ',
      GITHUB_CALLBACK_URL: 'https://core.example.com/v1/auth/github/callback',
      GITHUB_LOGIN_REDIRECT_URL: 'https://studio.example.com/',
    },
  ])(
    'keeps the app available with missing or partial GitHub environment configuration (%j)',
    async (env) => {
      const github = createGitHubLogin(loadConfig({ PGPASSWORD: 'test-only', ...env }));
      const app = target({ github });
      expect((await app.request('/v1/openapi')).status).toBe(200);
      await rejected(await app.request('/v1/auth/github'), 'github_not_configured', 503);
    },
  );

  it('returns a clear business error on both endpoints when GitHub is not configured', async () => {
    const app = createApp({ database: createDb(database.pool) });
    for (const path of ['/v1/auth/github', '/v1/auth/github/callback?code=x&state=x']) {
      const response = await app.request(path);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: 'github_not_configured' } });
      expect(response.headers.get('set-cookie')).toBeNull();
    }
    expect((await app.request('/v1/openapi')).status).toBe(200);
  });
});
