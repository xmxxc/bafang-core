import { z } from 'zod';
import type { Config } from '../config';

/** GitHub OAuth 出口：测试替换整个适配器，不访问真实 GitHub。 */
export interface GitHubOAuth {
  authorizationUrl(state: string, challenge: string): string;
  userId(code: string, verifier: string): Promise<string>;
}

export interface GitHubLogin {
  oauth: GitHubOAuth;
  /** 只使用部署配置的固定网页地址。 */
  redirectUrl: string;
}

const TokenSchema = z.object({
  access_token: z.string().min(1).regex(/^\S+$/),
  token_type: z.literal('bearer'),
  error: z.never().optional(),
});
const UserSchema = z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });

/** HTTPS 固定端点、单次 5 秒超时；授权码不重试，令牌不落库或写日志。 */
export class HttpGitHubOAuth implements GitHubOAuth {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly callbackUrl: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  authorizationUrl(state: string, challenge: string): string {
    const url = new URL('https://github.com/login/oauth/authorize');
    url.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.callbackUrl,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: '',
    }).toString();
    return url.toString();
  }

  async userId(code: string, verifier: string): Promise<string> {
    const tokenResponse = await this.fetcher('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.callbackUrl,
        code,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(5_000),
      redirect: 'error',
    });
    if (!tokenResponse.ok) throw new Error('GitHub token exchange failed');
    const token = TokenSchema.parse(await tokenResponse.json());
    const userResponse = await this.fetcher('https://api.github.com/user', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token.access_token}`,
        'User-Agent': 'bafang-core',
        'X-GitHub-Api-Version': '2026-03-10',
      },
      signal: AbortSignal.timeout(5_000),
      redirect: 'error',
    });
    if (!userResponse.ok) throw new Error('GitHub user lookup failed');
    return String(UserSchema.parse(await userResponse.json()).id);
  }
}

function httpUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('GitHub 跳转地址必须是无凭据和片段的 HTTP(S) 绝对地址');
  }
  return url.toString();
}

/** 缺少任何配置时禁用此登录方式，不影响其余服务启动。 */
export function createGitHubLogin(config: Config): GitHubLogin | undefined {
  const clientId = config.GITHUB_CLIENT_ID?.trim();
  const secret = config.GITHUB_CLIENT_SECRET?.trim();
  const callbackUrl = config.GITHUB_CALLBACK_URL?.trim();
  const redirectUrl = config.GITHUB_LOGIN_REDIRECT_URL?.trim();
  if (!clientId || !secret || !callbackUrl || !redirectUrl) return undefined;
  return {
    oauth: new HttpGitHubOAuth(clientId, secret, httpUrl(callbackUrl)),
    redirectUrl: httpUrl(redirectUrl),
  };
}
