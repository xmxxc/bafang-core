import { createHash } from 'node:crypto';
import { and, eq, gt, lte } from 'drizzle-orm';
import type { Clock } from '../clock';
import type { Db } from '../db';
import { githubOAuthStates } from '../db/schema';
import type { GitHubOAuth } from './github';
import { AuthError, type AuthService, type SessionInfo } from './service';
import { generateSessionToken, sha256Hex } from './token';

export const GITHUB_STATE_TTL_MS = 10 * 60 * 1000;
export const GITHUB_BROWSER_COOKIE = '__Host-bafang_github';

export function createGitHubLoginService(deps: {
  db: Db;
  clock: Clock;
  oauth: GitHubOAuth;
  auth: AuthService;
}) {
  const { db, clock, oauth, auth } = deps;
  return {
    /** 关联意图须传入发起会话：state 绑定该会话的 id（不存令牌）。 */
    async start(purpose: 'login' | 'link' = 'login', session?: SessionInfo) {
      const state = generateSessionToken();
      const browser = generateSessionToken();
      const verifier = generateSessionToken();
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const now = clock.now();
      await db.delete(githubOAuthStates).where(lte(githubOAuthStates.expiresAt, now));
      await db.insert(githubOAuthStates).values({
        stateHash: sha256Hex(state),
        browserHash: sha256Hex(browser),
        verifier,
        purpose,
        userId: session?.userId,
        sessionId: session?.sessionId,
        expiresAt: new Date(now.getTime() + GITHUB_STATE_TTL_MS),
      });
      return { browser, url: oauth.authorizationUrl(state, challenge) };
    },

    async callback(
      state: string | undefined,
      browser: string | undefined,
      code: string | undefined,
      error: string | undefined,
      current?: SessionInfo | null,
    ) {
      if (!state || !browser)
        throw new AuthError('github_state_invalid', 'GitHub 登录请求无效或已过期，请重新登录', 400);
      // DELETE RETURNING 在网络调用之前提交，跨实例/并发回调也只有一个消费者。
      const [request] = await db
        .delete(githubOAuthStates)
        .where(
          and(
            eq(githubOAuthStates.stateHash, sha256Hex(state)),
            eq(githubOAuthStates.browserHash, sha256Hex(browser)),
            gt(githubOAuthStates.expiresAt, clock.now()),
          ),
        )
        .returning({
          verifier: githubOAuthStates.verifier,
          purpose: githubOAuthStates.purpose,
          userId: githubOAuthStates.userId,
          sessionId: githubOAuthStates.sessionId,
        });
      if (!request)
        throw new AuthError('github_state_invalid', 'GitHub 登录请求无效或已过期，请重新登录', 400);
      if (error !== undefined || !code)
        throw new AuthError('github_authorization_failed', 'GitHub 授权未完成，请重新登录', 400);
      let externalId: string;
      try {
        externalId = await oauth.userId(code, request.verifier);
      } catch {
        // 不传播上游响应、授权码或令牌，且失败前不写用户、登录方式或会话。
        throw new AuthError('github_unavailable', 'GitHub 登录暂不可用，请稍后重试', 502);
      }
      if (request.purpose === 'link') {
        // 回调必须来自发起关联的同一会话且该会话仍有效（current 已过有效性校验）。
        if (
          !current ||
          !request.sessionId ||
          request.sessionId !== current.sessionId ||
          request.userId !== current.userId
        ) {
          throw new AuthError('unauthorized', '关联登录方式需要发起关联的会话仍然有效', 401);
        }
        await auth.associateLoginMethod(current.userId, 'github', externalId);
        return { kind: 'link' as const, userId: current.userId };
      }
      const result = await auth.loginWithGitHubId(externalId);
      return { kind: 'login' as const, ...result };
    },
  };
}
