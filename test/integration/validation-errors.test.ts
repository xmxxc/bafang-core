import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoute, z } from '@hono/zod-openapi';
import { createApp, type App } from '../../src/app';
import { createDb, createHealthProbe } from '../../src/db';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';
import { eastmoneySamples, RecordedUpstream } from '../support/recorded-upstream';

describe('readable validation errors over HTTP against real PostgreSQL', () => {
  let db: TestSchema;
  let app: App;

  beforeEach(async () => {
    db = await createTestSchema();
    app = createApp({
      database: createDb(db.pool),
      db: createHealthProbe(db.pool),
      upstream: new RecordedUpstream(eastmoneySamples),
    });
  });

  afterEach(async () => {
    await dropTestSchema(db);
  });

  it.each([
    ['/v1/funds/abc', '基金代码为 6 位数字'],
    ['/v1/funds/search?q=', '搜索词不能为空'],
  ])('returns a business explanation for %s', async (path, message) => {
    const response = await app.request(path);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: 'validation_error', message } });
  });

  // Test-only routes exercise the app's HTTP validation contract for shapes not yet
  // exposed by business routes, without calling the validation hook directly.
  function validationRoute(schema: z.ZodType) {
    app.openapi(
      createRoute({
        method: 'post',
        path: '/test/validation',
        request: { body: { required: true, content: { 'application/json': { schema } } } },
        responses: { 200: { description: 'Valid request' } },
      }),
      (c) => c.json({ ok: true }, 200),
    );
  }

  function post(body: unknown) {
    return app.request('/test/validation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('combines distinct problems in validation order and keeps nested locations', async () => {
    validationRoute(
      z.object({
        items: z.array(
          z.object({
            code: z.string().superRefine((_value, ctx) => {
              ctx.addIssue({ code: 'custom', message: '基金代码为 6 位数字' });
              ctx.addIssue({ code: 'custom', message: '基金代码为 6 位数字' });
            }),
            name: z.string().min(1, '名称不能为空'),
          }),
        ),
      }),
    );
    const response = await post({ items: [{ name: '', code: 'private-input' }] });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: 'validation_error',
        message: 'items.0.code：基金代码为 6 位数字；items.0.name：名称不能为空',
      },
    });
  });

  it('provides a readable fallback for an empty validation explanation', async () => {
    validationRoute(z.string().refine(() => false, { message: '' }));
    const response = await post('private-input');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: 'validation_error', message: '请求参数不合法' },
    });
  });

  it('keeps identical explanations for different nested locations', async () => {
    validationRoute(
      z.object({ items: z.array(z.object({ name: z.string().min(1, '名称不能为空') })) }),
    );
    const response = await post({ items: [{ name: '' }, { name: '' }] });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: 'validation_error',
        message: 'items.0.name：名称不能为空；items.1.name：名称不能为空',
      },
    });
  });

  it('keeps the location of a single nested problem', async () => {
    validationRoute(
      z.object({ items: z.array(z.object({ name: z.string().min(1, '名称不能为空') })) }),
    );
    const response = await post({ items: [{ name: '' }] });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: 'validation_error', message: 'items.0.name：名称不能为空' },
    });
  });

  it('uses the default explanation when a refinement has no custom message', async () => {
    validationRoute(z.string().refine(() => false));
    const response = await post('private-input');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: 'validation_error', message: 'Invalid input' },
    });
  });

  it('combines problems on a business route without echoing submitted values', async () => {
    const response = await app.request('/v1/auth/email/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'private-code', email: 'private-email', device: 'web' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: 'validation_error',
        message: 'email：Invalid email address；code：验证码为 6 位数字',
      },
    });
  });

  it('does not expose an internal regex in a default validation explanation', async () => {
    const response = await app.request('/v1/auth/wechat/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'private input' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: 'validation_error', message: '格式不合法' },
    });
  });

  it('does not echo unrecognized input keys in a validation explanation', async () => {
    validationRoute(z.strictObject({ name: z.string() }));
    const response = await post({ name: 'valid', 'private-input-key': 'private-input' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: 'validation_error', message: '包含不支持的字段' },
    });
  });

  it.each([
    ['application/json', '{'],
    ['text/plain', 'private-input'],
  ])('preserves the existing JSON format error for %s', async (contentType, body) => {
    const response = await app.request('/v1/auth/email/request', {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: 'validation_error', message: '请求格式不合法' },
    });
  });

  it('continues serving valid requests and other error codes', async () => {
    const search = await app.request('/v1/funds/search?q=000001');
    expect(search.status).toBe(200);
    expect(await search.json()).toMatchObject({ items: [{ code: '000001' }] });
    const health = await app.request('/v1/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ database: { connected: true } });
    const unauthorized = await app.request('/v1/me');
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({
      error: { code: 'unauthorized', message: '未登录' },
    });
  });
});
