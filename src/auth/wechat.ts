import { z } from 'zod';
import type { Config } from '../config';

/** 微信 code2session 出口；只向登录流程提供 openid。 */
export interface WeChatCode2Session {
  openid(code: string): Promise<string>;
}

/** 适配器明确识别到无效/已消费的 code；其他异常全部按上游不可用处理。 */
export class WeChatCodeInvalidError extends Error {}

const ResponseSchema = z.object({
  errcode: z.number().int().optional(),
  openid: z.string().min(1).max(255).regex(/^\S+$/).optional(),
  session_key: z.string().min(1).regex(/^\S+$/).optional(),
});

/** 固定 HTTPS 端点、单次 5 秒超时，不重试一次性 code，不保留 session_key。 */
export class HttpWeChatCode2Session implements WeChatCode2Session {
  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async openid(code: string): Promise<string> {
    const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
    url.search = new URLSearchParams({
      appid: this.appId,
      secret: this.appSecret,
      js_code: code,
      grant_type: 'authorization_code',
    }).toString();
    const response = await this.fetcher(url, {
      method: 'GET',
      signal: AbortSignal.timeout(5_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('WeChat code exchange failed');
    const result = ResponseSchema.parse(await response.json());
    if (result.errcode === 40029 || result.errcode === 40163) {
      throw new WeChatCodeInvalidError('Invalid WeChat code');
    }
    if (
      (result.errcode !== undefined && result.errcode !== 0) ||
      !result.openid ||
      !result.session_key
    ) {
      throw new Error('Invalid WeChat response');
    }
    return result.openid;
  }
}

/** 配置缺失时仅禁用微信登录，服务仍可启动。 */
export function createWeChatLogin(config: Config): WeChatCode2Session | undefined {
  const appId = config.WECHAT_APP_ID?.trim();
  const appSecret = config.WECHAT_APP_SECRET?.trim();
  if (!appId || !appSecret) return undefined;
  return new HttpWeChatCode2Session(appId, appSecret);
}
