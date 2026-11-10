import { z } from 'zod';
import { SystemClock, type Clock } from '../clock';
import type { Config } from '../config';

/** 小程序码生成出口；图片以 base64 返回，测试整体替换该适配器。 */
export interface WeChatQrCode {
  generate(scene: string): Promise<{ contentType: 'image/png' | 'image/jpeg'; base64: string }>;
}

const TokenSchema = z.object({
  access_token: z.string().min(1).max(2048).regex(/^\S+$/),
  expires_in: z.number().int().positive().max(86400),
  errcode: z.literal(0).optional(),
});

/** 固定 HTTPS 端点、单次 5 秒超时、禁止重定向及自动重试；凭据只留在内存。 */
export class HttpWeChatQrCode implements WeChatQrCode {
  private cached: { token: string; refreshAt: number } | undefined;
  private pending: Promise<string> | undefined;

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  private async accessToken(): Promise<string> {
    if (this.cached && this.clock.now().getTime() < this.cached.refreshAt) return this.cached.token;
    if (this.pending) return this.pending;
    this.pending = this.fetchAccessToken();
    try {
      return await this.pending;
    } finally {
      this.pending = undefined;
    }
  }

  private async fetchAccessToken(): Promise<string> {
    const requestedAt = this.clock.now().getTime();
    const url = new URL('https://api.weixin.qq.com/cgi-bin/token');
    url.search = new URLSearchParams({
      grant_type: 'client_credential',
      appid: this.appId,
      secret: this.appSecret,
    }).toString();
    const response = await this.fetcher(url, {
      method: 'GET',
      signal: AbortSignal.timeout(5_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('WeChat token request failed');
    const result = TokenSchema.parse(await response.json());
    const ttlMs = result.expires_in * 1000;
    // 提前 10%（最多 60 秒）刷新；同时覆盖较短的测试/上游有效期。
    this.cached = {
      token: result.access_token,
      refreshAt: requestedAt + ttlMs - Math.min(60_000, ttlMs * 0.1),
    };
    return result.access_token;
  }

  async generate(scene: string) {
    const token = await this.accessToken();
    const url = new URL('https://api.weixin.qq.com/wxa/getwxacodeunlimit');
    url.searchParams.set('access_token', token);
    const response = await this.fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scene }),
      signal: AbortSignal.timeout(5_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('WeChat QR request failed');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 2 * 1024 * 1024) throw new Error('WeChat QR image too large');
    let contentType: 'image/png' | 'image/jpeg';
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      contentType = 'image/png';
    else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
      contentType = 'image/jpeg';
    else {
      // 微信失败时返回 JSON，不能把它作为图片发送。失效凭据只在下一次请求重新获取。
      try {
        const error = JSON.parse(bytes.toString()) as { errcode?: number };
        if ([40001, 40014, 42001].includes(error?.errcode ?? 0) && this.cached?.token === token)
          this.cached = undefined;
      } catch {
        /* 非 JSON 的无效图片同样拒绝。 */
      }
      throw new Error('Invalid WeChat QR image');
    }
    return { contentType, base64: bytes.toString('base64') };
  }
}

/** 缺少 AppID/Secret 时禁用扫码登录，服务继续启动。 */
export function createWeChatQrCode(config: Config): WeChatQrCode | undefined {
  const appId = config.WECHAT_APP_ID?.trim();
  const appSecret = config.WECHAT_APP_SECRET?.trim();
  return appId && appSecret ? new HttpWeChatQrCode(appId, appSecret) : undefined;
}
