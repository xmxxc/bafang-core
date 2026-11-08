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

  it.each([undefined, '', '  '])(
    'fails closed with production secret %j and accepts an explicit secret',
    async (secret) => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalSecret = process.env.BIND_CODE_SECRET;
      try {
        process.env.NODE_ENV = 'production';
        if (secret === undefined) delete process.env.BIND_CODE_SECRET;
        else process.env.BIND_CODE_SECRET = secret;
        const missing = app();
        const web = await webLogin(missing, 'production-missing@example.com');
        const generated = await missing.request('/v1/auth/bind-code', {
          method: 'POST',
          headers: { Cookie: web },
        });
        expect(generated.status).toBe(503);
        expect((await generated.json()) as object).toMatchObject({
          error: { code: 'bind_code_not_configured' },
        });
        const submitted = await missing.request('/v1/auth/wechat/bind', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: 'production-missing', bindCode: '000000' }),
        });
        expect(submitted.status).toBe(503);
        expect((await submitted.json()) as object).toMatchObject({
          error: { code: 'bind_code_not_configured' },
        });

        process.env.BIND_CODE_SECRET = 'production-only-secret';
        const configured = app();
        const configuredWeb = await webLogin(configured, 'production-configured@example.com');
        const configuredResult = await configured.request('/v1/auth/bind-code', {
          method: 'POST',
          headers: { Cookie: configuredWeb },
        });
        expect(configuredResult.status).toBe(201);
        const { code } = (await configuredResult.json()) as { code: string };
        expect(
          (
            await configured.request('/v1/auth/wechat/bind', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code: 'configured', bindCode: code }),
            })
          ).status,
        ).toBe(200);
      } finally {
        if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = originalNodeEnv;
        if (originalSecret === undefined) delete process.env.BIND_CODE_SECRET;
        else process.env.BIND_CODE_SECRET = originalSecret;
      }
    },
  );

  it('enforces persistent openid and global failure budgets across client IPs', async () => {
    const target = app({
      wechat: {
        async openid(code: string) {
          return code === 'same-openid' ? 'openid-budget' : `openid-${code}`;
        },
      },
    });
    const otherInstance = app({
      wechat: {
        async openid(code) {
          return code === 'same-openid' ? 'openid-budget' : `openid-${code}`;
        },
      },
    });
    let requests = 0;
    const attempt = (code: string, bindCode: string, ip: string) =>
      (requests++ % 2 ? target : otherInstance).request('/v1/auth/wechat/bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
        body: JSON.stringify({ code, bindCode }),
      });
    for (let i = 0; i < 10; i += 1)
      expect((await attempt('same-openid', '000000', `192.0.2.${i + 1}`)).status).toBe(400);
    for (let i = 11; i <= 20; i += 1) {
      expect((await attempt('same-openid', '000000', `192.0.2.${i}`)).status).toBe(429);
    }
    offsetMs = 24 * 60 * 60 * 1000 + 1;
    expect((await attempt('same-openid', '000000', '192.0.2.21')).status).toBe(400);

    for (let i = 0; i < 298; i += 1)
      expect((await attempt(`global-${i}`, '000000', `198.51.100.${i + 1}`)).status).toBe(400);
    expect((await attempt('global-limit', '000000', '198.51.100.300')).status).toBe(400);
    const globalLimited = await attempt('global-after', '000000', '203.0.113.1');
    expect(globalLimited.status).toBe(429);
    const cookie = await webLogin(target, 'global-budget-valid@example.com');
    const generate = async () => {
      const response = await target.request('/v1/auth/bind-code', {
        method: 'POST',
        headers: { Cookie: cookie },
      });
      expect(response.status).toBe(201);
      return ((await response.json()) as { code: string }).code;
    };
    const validCode = await generate();
    expect((await attempt('global-valid', validCode, '203.0.113.3')).status).toBe(429);
    offsetMs += 60 * 60 * 1000 + 1;
    const freshCode = await generate();
    expect((await attempt('global-valid', freshCode, '203.0.113.4')).status).toBe(200);
    expect((await attempt('global-recovered', '000000', '203.0.113.2')).status).toBe(400);
  });

  it('retries active-code collisions and permits reuse of expired or used historical values', async () => {
    const target = app({ bindCodeGenerator: () => '123456' });
    const first = await webLogin(target, 'collision-first@example.com');
    const firstCode = await target.request('/v1/auth/bind-code', {
      method: 'POST',
      headers: { Cookie: first, 'X-Forwarded-For': '192.0.2.101' },
    });
    expect(firstCode.status).toBe(201);

    const second = await webLogin(target, 'collision-second@example.com');
    const activeCollision = await target.request('/v1/auth/bind-code', {
      method: 'POST',
      headers: { Cookie: second, 'X-Forwarded-For': '192.0.2.102' },
    });
    expect(activeCollision.status).toBe(503);
    expect((await activeCollision.json()) as object).toMatchObject({
      error: { code: 'bind_code_unavailable' },
    });

    offsetMs = 10 * 60 * 1000 + 1;
    const expiredCollision = await target.request('/v1/auth/bind-code', {
      method: 'POST',
      headers: { Cookie: second, 'X-Forwarded-For': '192.0.2.103' },
    });
    expect(expiredCollision.status).toBe(201);
    const consumed = await target.request('/v1/auth/wechat/bind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '192.0.2.104' },
      body: JSON.stringify({ code: 'historical-used', bindCode: '123456' }),
    });
    expect(consumed.status).toBe(200);
    const consumedBody = (await consumed.json()) as { user: { id: string } };
    const secondUser = (await (
      await target.request('/v1/me', { headers: { Cookie: second } })
    ).json()) as { user: { id: string } };
    expect(consumedBody.user.id).toBe(secondUser.user.id);

    const third = await webLogin(target, 'collision-third@example.com');
    const usedCollision = await target.request('/v1/auth/bind-code', {
      method: 'POST',
      headers: { Cookie: third, 'X-Forwarded-For': '192.0.2.105' },
    });
    expect(usedCollision.status).toBe(201);
  });

  it('retries a collision with a fresh value and keeps ownership unambiguous', async () => {
    const candidates = ['123456', '123456', '654321'];
    const target = app({ bindCodeGenerator: () => candidates.shift()! });
    const first = await webLogin(target, 'retry-first@example.com');
    const second = await webLogin(target, 'retry-second@example.com');
    const generate = (cookie: string) =>
      target.request('/v1/auth/bind-code', { method: 'POST', headers: { Cookie: cookie } });
    expect((await generate(first)).status).toBe(201);
    const retry = await generate(second);
    expect(retry.status).toBe(201);
    expect(await retry.json()).toMatchObject({ code: '654321' });
    const response = await target.request('/v1/auth/wechat/bind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'retry', bindCode: '654321' }),
    });
    const secondMe = await target.request('/v1/me', { headers: { Cookie: second } });
    expect(await response.json()).toMatchObject({
      user: ((await secondMe.json()) as { user: { id: string } }).user,
    });
  });

  it('retries collisions with its own active code and preserves it when all five candidates collide', async () => {
    let candidate = '123456';
    const target = app({ bindCodeGenerator: () => candidate });
    const cookie = await webLogin(target, 'own-collision@example.com');
    const generate = () =>
      target.request('/v1/auth/bind-code', { method: 'POST', headers: { Cookie: cookie } });
    expect((await generate()).status).toBe(201);
    offsetMs += 1000;
    const exhausted = await generate();
    expect(exhausted.status).toBe(503);
    expect(await exhausted.json()).toMatchObject({ error: { code: 'bind_code_unavailable' } });
    const oldCodeStillWorks = await target.request('/v1/auth/wechat/bind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'own-collision', bindCode: '123456' }),
    });
    expect(oldCodeStillWorks.status).toBe(200);
    candidate = '654321';
    const fresh = await generate();
    expect(fresh.status).toBe(201);
    expect(await fresh.json()).toMatchObject({ code: '654321' });
  });

  it('retries its own active code with a fresh candidate and invalidates the previous code', async () => {
    const candidates = ['123456', '123456', '654321'];
    const target = app({ bindCodeGenerator: () => candidates.shift()! });
    const cookie = await webLogin(target, 'own-retry@example.com');
    const generate = () =>
      target.request('/v1/auth/bind-code', { method: 'POST', headers: { Cookie: cookie } });
    expect((await generate()).status).toBe(201);
    const next = await generate();
    expect(next.status).toBe(201);
    expect(await next.json()).toMatchObject({ code: '654321' });
    const submit = (bindCode: string) =>
      target.request('/v1/auth/wechat/bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'own-retry', bindCode }),
      });
    const old = await submit('123456');
    expect(old.status).toBe(400);
    expect(await old.json()).toMatchObject({ error: { code: 'bind_code_used' } });
    expect((await submit('654321')).status).toBe(200);
  });

  it('does not reset failure budgets after success, blocks valid codes at the limit and recovers', async () => {
    const target = app({ bindCodeGenerator: () => '123456' });
    const cookie = await webLogin(target, 'failure-success@example.com');
    const generate = () =>
      target.request('/v1/auth/bind-code', { method: 'POST', headers: { Cookie: cookie } });
    let ip = 1;
    const submit = (bindCode: string) =>
      target.request('/v1/auth/wechat/bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `192.0.2.${ip++}` },
        body: JSON.stringify({ code: 'stable-identity', bindCode }),
      });
    for (let i = 0; i < 9; i++) expect((await submit('000000')).status).toBe(400);
    expect((await generate()).status).toBe(201);
    expect((await submit('123456')).status).toBe(200);
    expect((await submit('000000')).status).toBe(400);
    expect((await generate()).status).toBe(201);
    expect((await submit('123456')).status).toBe(429);
    offsetMs += 24 * 60 * 60 * 1000 + 1;
    expect((await generate()).status).toBe(201);
    expect((await submit('123456')).status).toBe(200);
  });

  it('serializes generation with paused consumption after the user rows are locked', async () => {
    let resume!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let candidate = 100000;
    const target = app({
      bindCodeGenerator: () => String(candidate++),
      hasUserPositions: async () => {
        entered();
        await gate;
        return false;
      },
    });
    const cookie = await webLogin(target, 'lock-order@example.com');
    const generated = await target.request('/v1/auth/bind-code', {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    const bindCode = ((await generated.json()) as { code: string }).code;
    await miniLogin(target, 'lock-owner');
    const consume = target.request('/v1/auth/wechat/bind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'lock-owner', bindCode }),
    });
    await paused;
    const regenerate = target.request('/v1/auth/bind-code', {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    try {
      // Give the generator time to reach its user lock while consumption is paused.
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      resume();
    }
    const [consumed, regenerated] = await Promise.all([consume, regenerate]);
    expect(consumed.status).toBe(200);
    expect(regenerated.status).toBe(201);
    const me = await target.request('/v1/me', { headers: { Cookie: cookie } });
    expect(await me.json()).toMatchObject({
      loginMethods: expect.arrayContaining([{ type: 'wechat', externalId: 'openid-lock-owner' }]),
    });
  });
  it('limits historical error recognition to 24 hours and cleans history when generating', async () => {
    let candidate = '123456';
    const target = app({ bindCodeGenerator: () => candidate });
    const cookie = await webLogin(target, 'retention@example.com');
    expect(
      (await target.request('/v1/auth/bind-code', { method: 'POST', headers: { Cookie: cookie } }))
        .status,
    ).toBe(201);
    offsetMs = 10 * 60 * 1000;
    const submit = () =>
      target.request('/v1/auth/wechat/bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'retention', bindCode: '123456' }),
      });
    expect(await (await submit()).json()).toMatchObject({ error: { code: 'bind_code_expired' } });
    offsetMs = 24 * 60 * 60 * 1000 + 1;
    candidate = '654321';
    expect(
      (await target.request('/v1/auth/bind-code', { method: 'POST', headers: { Cookie: cookie } }))
        .status,
    ).toBe(201);
    expect(await (await submit()).json()).toMatchObject({ error: { code: 'bind_code_invalid' } });
  });
});
