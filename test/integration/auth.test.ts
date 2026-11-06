import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../../src/app';
import { createDb, createHealthProbe } from '../../src/db';
import type { ErrorResponse } from '../../src/errors';
import { EMAIL_CODE_COOLDOWN_MS } from '../../src/auth/service';
import type { EmailLoginResponse, MeResponse } from '../../src/routes/auth';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';

/** 可推进的时钟替身。 */
function movableClock(iso: string) {
  let now = new Date(iso);
  return {
    now: () => now,
    set: (next: string) => {
      now = new Date(next);
    },
    advanceMs: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

/** 假发信适配器：记录发送的验证码，不发真实邮件。 */
function fakeMailer() {
  const sent: { email: string; code: string }[] = [];
  return {
    sent,
    async sendVerificationCode(email: string, code: string) {
      sent.push({ email, code });
    },
  };
}

function sessionCookie(res: Response): string {
  const header = res.headers.get('set-cookie') ?? '';
  const match = header.match(/bafang_session=([^;]+)/);
  if (!match || !match[1]) throw new Error(`no session cookie in ${header}`);
  return match[1];
}

describe('email verification-code login and sessions over in-process HTTP against a real PostgreSQL test database', () => {
  let db: TestSchema;
  let mailer: ReturnType<typeof fakeMailer>;
  let clock: ReturnType<typeof movableClock>;

  function app(deps: AppDeps = {}) {
    return createApp({
      db: createHealthProbe(db.pool),
      database: createDb(db.pool),
      mailer,
      clock,
      ...deps,
    });
  }

  beforeEach(async () => {
    db = await createTestSchema();
    mailer = fakeMailer();
    // 2026-11-06 10:00 Asia/Shanghai
    clock = movableClock('2026-11-06T02:00:00.000Z');
  });

  afterEach(async () => {
    await dropTestSchema(db);
  });

  async function requestCode(target: ReturnType<typeof app>, email: string, ip = '203.0.113.1') {
    return target.request('/v1/auth/email/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
      body: JSON.stringify({ email }),
    });
  }

  async function login(
    target: ReturnType<typeof app>,
    email: string,
    code: string,
    device: 'web' | 'miniprogram',
  ) {
    return target.request('/v1/auth/email/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code, device }),
    });
  }

  async function me(target: ReturnType<typeof app>, headers: Record<string, string> = {}) {
    return target.request('/v1/me', { headers });
  }

  async function latestCode(email: string): Promise<string> {
    const entry = [...mailer.sent].reverse().find((m) => m.email === email);
    if (!entry) throw new Error(`no code sent for ${email}`);
    return entry.code;
  }

  describe('POST /v1/auth/email/request', () => {
    it('sends a 6-digit code through the mailer and normalizes the email', async () => {
      const res = await requestCode(app(), '  User@Example.COM ');
      expect(res.status).toBe(200);
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]).toMatchObject({ email: 'user@example.com' });
      expect(mailer.sent[0]?.code).toMatch(/^\d{6}$/);
      expect(((await res.json()) as { retryAfterSeconds: number }).retryAfterSeconds).toBe(
        EMAIL_CODE_COOLDOWN_MS / 1000,
      );
    });

    it('rejects a malformed email with the unified validation error', async () => {
      const res = await requestCode(app(), 'not-an-email');
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorResponse).error.code).toBe('validation_error');
    });

    it('allows only one request per email within 60 seconds', async () => {
      const target = app();
      expect((await requestCode(target, 'a@example.com')).status).toBe(200);

      clock.advanceMs(59_000);
      const second = await requestCode(target, 'a@example.com');
      expect(second.status).toBe(429);
      expect(((await second.json()) as ErrorResponse).error.code).toBe('email_code_cooldown');

      clock.advanceMs(2_000);
      expect((await requestCode(target, 'a@example.com')).status).toBe(200);
    });

    it('enforces a per-email daily limit', async () => {
      const target = app();
      for (let i = 0; i < 10; i++) {
        expect((await requestCode(target, 'daily@example.com')).status).toBe(200);
        clock.advanceMs(EMAIL_CODE_COOLDOWN_MS + 1);
      }
      const over = await requestCode(target, 'daily@example.com');
      expect(over.status).toBe(429);
      expect(((await over.json()) as ErrorResponse).error.code).toBe('email_code_daily_limit');
    });

    it('rate limits a single IP across different emails', async () => {
      const target = app();
      for (let i = 0; i < 5; i++) {
        expect((await requestCode(target, `ip${i}@example.com`, '198.51.100.7')).status).toBe(200);
      }
      const limited = await requestCode(target, 'ip6@example.com', '198.51.100.7');
      expect(limited.status).toBe(429);
      expect(((await limited.json()) as ErrorResponse).error.code).toBe('rate_limited');

      // 另一个 IP 不受影响
      expect((await requestCode(target, 'ip7@example.com', '198.51.100.8')).status).toBe(200);
    });
  });

  describe('POST /v1/auth/email/login', () => {
    it('logs in over the web with an httpOnly + Secure cookie and no token in the body', async () => {
      const target = app();
      await requestCode(target, 'user@example.com');
      const code = await latestCode('user@example.com');

      const res = await login(target, 'user@example.com', code, 'web');
      expect(res.status).toBe(200);
      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('bafang_session=');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Secure');

      const body = (await res.json()) as EmailLoginResponse;
      expect(body.user.id).toBeTruthy();
      expect(body.session.device).toBe('web');
      expect(body.token).toBeNull();
    });

    it('logs in over the miniprogram and returns the token for the request header', async () => {
      const target = app();
      await requestCode(target, 'user@example.com');
      const code = await latestCode('user@example.com');

      const res = await login(target, 'user@example.com', code, 'miniprogram');
      expect(res.status).toBe(200);
      const body = (await res.json()) as EmailLoginResponse;
      expect(body.session.device).toBe('miniprogram');
      expect(body.token).toBeTruthy();
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('rejects a wrong code with verification_code_invalid', async () => {
      const target = app();
      await requestCode(target, 'user@example.com');
      const res = await login(target, 'user@example.com', '000000', 'web');
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorResponse).error.code).toBe('verification_code_invalid');
    });

    it('expires the code after 10 minutes', async () => {
      const target = app();
      await requestCode(target, 'user@example.com');
      const code = await latestCode('user@example.com');

      clock.advanceMs(10 * 60 * 1000 + 1);
      const res = await login(target, 'user@example.com', code, 'web');
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorResponse).error.code).toBe('verification_code_expired');
    });

    it('invalidates the code after 5 wrong attempts even with the correct code', async () => {
      const target = app();
      await requestCode(target, 'user@example.com');
      const code = await latestCode('user@example.com');

      for (let i = 0; i < 4; i++) {
        const res = await login(target, 'user@example.com', '000000', 'web');
        expect(res.status).toBe(400);
        expect(((await res.json()) as ErrorResponse).error.code).toBe('verification_code_invalid');
      }
      const fifth = await login(target, 'user@example.com', '000000', 'web');
      expect(fifth.status).toBe(400);
      expect(((await fifth.json()) as ErrorResponse).error.code).toBe(
        'verification_code_max_attempts',
      );

      const correct = await login(target, 'user@example.com', code, 'web');
      expect(correct.status).toBe(400);
      expect(((await correct.json()) as ErrorResponse).error.code).toBe(
        'verification_code_max_attempts',
      );
    });

    it('can only use a code once', async () => {
      const target = app();
      await requestCode(target, 'user@example.com');
      const code = await latestCode('user@example.com');

      expect((await login(target, 'user@example.com', code, 'web')).status).toBe(200);
      const second = await login(target, 'user@example.com', code, 'web');
      expect(second.status).toBe(400);
      expect(((await second.json()) as ErrorResponse).error.code).toBe('verification_code_used');
    });
  });

  describe('first login creates user, email login method and presets three channels', () => {
    it('presets 支付宝 / 天天基金 / 未指定 once and keeps them on the next login', async () => {
      const target = app();
      await requestCode(target, 'user@example.com');
      const first = await login(
        target,
        'user@example.com',
        await latestCode('user@example.com'),
        'web',
      );
      const firstMe = await me(target, { Cookie: `bafang_session=${sessionCookie(first)}` });
      expect(firstMe.status).toBe(200);
      const firstBody = (await firstMe.json()) as MeResponse;
      expect(firstBody.channels.map((ch) => ch.name)).toEqual(['支付宝', '天天基金', '未指定']);
      expect(firstBody.loginMethods).toEqual([{ type: 'email', externalId: 'user@example.com' }]);

      clock.advanceMs(EMAIL_CODE_COOLDOWN_MS + 1);
      await requestCode(target, 'user@example.com');
      const second = await login(
        target,
        'user@example.com',
        await latestCode('user@example.com'),
        'web',
      );
      const secondMe = await me(target, { Cookie: `bafang_session=${sessionCookie(second)}` });
      const secondBody = (await secondMe.json()) as MeResponse;
      expect(secondBody.channels.map((ch) => ch.name)).toEqual(['支付宝', '天天基金', '未指定']);
      expect(secondBody.loginMethods).toEqual([{ type: 'email', externalId: 'user@example.com' }]);
      expect(secondBody.user.id).toBe(firstBody.user.id);
    });
  });

  describe('GET /v1/me and logout', () => {
    it('returns the unified unauthorized error when not logged in', async () => {
      const res = await me(app());
      expect(res.status).toBe(401);
      expect(((await res.json()) as ErrorResponse).error.code).toBe('unauthorized');
    });

    it('returns the unified unauthorized error for a garbage cookie', async () => {
      const res = await me(app(), { Cookie: 'bafang_session=garbage' });
      expect(res.status).toBe(401);
      expect(((await res.json()) as ErrorResponse).error.code).toBe('unauthorized');
    });

    it('serves /v1/me with a web cookie and with a miniprogram bearer token', async () => {
      const target = app();
      await requestCode(target, 'user@example.com');
      const web = await login(
        target,
        'user@example.com',
        await latestCode('user@example.com'),
        'web',
      );
      expect((await me(target, { Cookie: `bafang_session=${sessionCookie(web)}` })).status).toBe(
        200,
      );

      clock.advanceMs(EMAIL_CODE_COOLDOWN_MS + 1);
      await requestCode(target, 'user@example.com');
      const mini = await login(
        target,
        'user@example.com',
        await latestCode('user@example.com'),
        'miniprogram',
      );
      const miniBody = (await mini.json()) as EmailLoginResponse;
      expect((await me(target, { Authorization: `Bearer ${miniBody.token}` })).status).toBe(200);
    });

    it('logout revokes only the current session, leaving other devices unaffected', async () => {
      const target = app();
      await requestCode(target, 'user@example.com');
      const web = await login(
        target,
        'user@example.com',
        await latestCode('user@example.com'),
        'web',
      );
      const webCookie = `bafang_session=${sessionCookie(web)}`;

      clock.advanceMs(EMAIL_CODE_COOLDOWN_MS + 1);
      await requestCode(target, 'user@example.com');
      const mini = await login(
        target,
        'user@example.com',
        await latestCode('user@example.com'),
        'miniprogram',
      );
      const miniBody = (await mini.json()) as EmailLoginResponse;
      const miniAuth = { Authorization: `Bearer ${miniBody.token}` };

      const logoutRes = await target.request('/v1/auth/logout', {
        method: 'POST',
        headers: miniAuth,
      });
      expect(logoutRes.status).toBe(204);

      expect((await me(target, miniAuth)).status).toBe(401);
      expect((await me(target, { Cookie: webCookie })).status).toBe(200);
    });

    it('returns unauthorized when logging out without a session', async () => {
      const res = await app().request('/v1/auth/logout', { method: 'POST' });
      expect(res.status).toBe(401);
      expect(((await res.json()) as ErrorResponse).error.code).toBe('unauthorized');
    });
  });
});
