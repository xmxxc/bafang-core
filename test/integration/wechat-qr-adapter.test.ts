import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { createDb } from '../../src/db';
import { HttpWeChatQrCode } from '../../src/auth/wechat-qr';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';

const root = '/v1/auth/wechat/qr';
// 1×1 PNG；协议测试仅用录制的图片字节，不访问真实微信。
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6WQAAAAASUVORK5CYII=';
const image = () =>
  new Response(Buffer.from(png, 'base64'), { headers: { 'Content-Type': 'image/png' } });

describe('QR adapter protocol observed through core HTTP', () => {
  let database: TestSchema;
  let offsetMs = 0;
  const clock = { now: () => new Date(Date.parse('2026-11-06T02:00:00Z') + offsetMs) };
  beforeEach(async () => {
    database = await createTestSchema();
    offsetMs = 0;
  });
  afterEach(async () => {
    await dropTestSchema(database);
  });
  const target = (fetcher: typeof fetch) =>
    createApp({
      database: createDb(database.pool),
      clock,
      wechatQr: new HttpWeChatQrCode('app-id', 'app-secret', fetcher, clock),
    });

  it('gets and caches access_token, posts getUnlimited with scene, and refreshes before expiry', async () => {
    let tokenSerial = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== 'https://api.weixin.qq.com' || init?.redirect !== 'error' || !init.signal)
        return Response.json({ errcode: -1 });
      if (
        url.pathname === '/cgi-bin/token' &&
        init.method === 'GET' &&
        url.searchParams.get('grant_type') === 'client_credential' &&
        url.searchParams.get('appid') === 'app-id' &&
        url.searchParams.get('secret') === 'app-secret'
      ) {
        tokenSerial++;
        return Response.json({ access_token: `private-token-${tokenSerial}`, expires_in: 120 });
      }
      if (
        url.pathname !== '/wxa/getwxacodeunlimit' ||
        init.method !== 'POST' ||
        new Headers(init.headers).get('Content-Type') !== 'application/json'
      )
        return Response.json({ errcode: -1 });
      const expected = offsetMs < 108_000 ? 'private-token-1' : 'private-token-2';
      if (url.searchParams.get('access_token') !== expected)
        return Response.json({ errcode: 40001 });
      const { scene } = JSON.parse(String(init.body)) as { scene: string };
      if (!/^[A-Za-z0-9_-]{32}$/.test(scene)) return Response.json({ errcode: 40097 });
      // 图片出口携带 scene，使 API 可观察到准确的绑定，不依赖内部调用次数断言。
      return new Response(Buffer.concat([Buffer.from(png, 'base64'), Buffer.from(scene)]), {
        headers: { 'Content-Type': 'image/png' },
      });
    };
    const app = target(fetcher);
    for (const time of [0, 60_000, 108_000]) {
      offsetMs = time;
      const response = await app.request(root, { method: 'POST' });
      expect(response.status).toBe(201);
      const body = (await response.json()) as {
        ticketId: string;
        image: { contentType: string; base64: string };
      };
      expect(body.image.contentType).toBe('image/png');
      expect(Buffer.from(body.image.base64, 'base64').subarray(-32).toString()).toBe(body.ticketId);
      expect(JSON.stringify(body)).not.toMatch(/private-token|app-secret/);
    }
  });

  it('shares in-flight token acquisition for simultaneous ticket requests', async () => {
    let issued = false;
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/cgi-bin/token') {
        if (issued) return Response.json({ errcode: 45009 });
        issued = true;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return Response.json({ access_token: 'single-token', expires_in: 7200 });
      }
      return url.searchParams.get('access_token') === 'single-token'
        ? image()
        : Response.json({ errcode: 40001 });
    };
    const app = target(fetcher);
    const responses = await Promise.all([
      app.request(root, { method: 'POST' }),
      app.request(root, { method: 'POST' }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([201, 201]);
    const bodies = await Promise.all(
      responses.map(async (r) => (await r.json()) as { ticketId: string }),
    );
    expect(bodies[0]!.ticketId).not.toBe(bodies[1]!.ticketId);
  });

  it.each([
    ['token HTTP failure', 'token', () => Response.json({}, { status: 503 })],
    ['token error', 'token', () => Response.json({ errcode: 40013, errmsg: 'private app-secret' })],
    [
      'token error with token',
      'token',
      () => Response.json({ errcode: -1, access_token: 'untrusted', expires_in: 7200 }),
    ],
    ['missing expiry', 'token', () => Response.json({ access_token: 'untrusted' })],
    ['invalid expiry', 'token', () => Response.json({ access_token: 'untrusted', expires_in: 0 })],
    [
      'whitespace token',
      'token',
      () => Response.json({ access_token: 'bad token', expires_in: 7200 }),
    ],
    ['malformed token', 'token', () => new Response('not JSON')],
    ['image HTTP failure', 'image', () => new Response('', { status: 503 })],
    [
      'WeChat JSON error',
      'image',
      () => Response.json({ errcode: 45009, errmsg: 'private access-token' }),
    ],
    [
      'JSON disguised as image',
      'image',
      () => new Response('{"errcode":0}', { headers: { 'Content-Type': 'image/png' } }),
    ],
    ['empty image', 'image', () => new Response('', { headers: { 'Content-Type': 'image/png' } })],
    [
      'timeout',
      'token',
      () => {
        throw new DOMException('private timeout', 'TimeoutError');
      },
    ],
    [
      'network failure',
      'image',
      () => {
        throw new Error('private secret');
      },
    ],
  ] as const)(
    'fails closed on %s and can recover on a later request without automatic retry',
    async (_name, phase, fail) => {
      let failed = false;
      const fetcher: typeof fetch = async (input) => {
        const isToken = new URL(String(input)).pathname === '/cgi-bin/token';
        if ((phase === 'token') === isToken && !failed) {
          failed = true;
          return fail();
        }
        return isToken
          ? Response.json({ access_token: 'private-token', expires_in: 7200 })
          : image();
      };
      const app = target(fetcher);
      const rejected = await app.request(root, { method: 'POST' });
      expect(rejected.status).toBe(502);
      expect(await rejected.json()).toEqual({
        error: { code: 'wechat_unavailable', message: expect.not.stringMatching(/private|secret/) },
      });
      expect(rejected.headers.get('set-cookie')).toBeNull();
      const recovered = await app.request(root, { method: 'POST' });
      expect(recovered.status).toBe(201);
      expect(((await recovered.json()) as { image: { base64: string } }).image.base64).toBe(png);
    },
  );
});
