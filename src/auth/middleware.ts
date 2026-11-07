import { getCookie } from 'hono/cookie';
import type { Context, MiddlewareHandler } from 'hono';
import { errorBody } from '../errors';
import type { AuthService, SessionInfo } from './service';

/** 网页会话 Cookie 名。 */
export const SESSION_COOKIE = 'bafang_session';

export const AUTH_CONTEXT_KEY = 'auth';

export function extractSessionToken(c: Context): string | null {
  const cookie = getCookie(c, SESSION_COOKIE);
  if (cookie) return cookie;
  const header = c.req.header('Authorization');
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim();
  return null;
}

/** 需要登录的接口共用：未登录或会话失效时返回统一的 unauthorized 错误码。 */
export function requireAuth(auth: AuthService): MiddlewareHandler {
  return async (c, next) => {
    const token = extractSessionToken(c);
    if (!token) {
      return c.json(errorBody('unauthorized', '未登录'), 401);
    }
    const session = await auth.authenticate(token);
    if (!session) {
      return c.json(errorBody('unauthorized', '未登录或会话已失效'), 401);
    }
    c.set(AUTH_CONTEXT_KEY, session);
    await next();
  };
}

export function getAuth(c: Context): SessionInfo {
  return c.get(AUTH_CONTEXT_KEY) as SessionInfo;
}
