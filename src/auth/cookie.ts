import type { Context } from 'hono';
import { setCookie } from 'hono/cookie';
import { SESSION_COOKIE } from './middleware';
import { SESSION_TTL_MS } from './service';

/** 邮箱与 GitHub 网页登录统一使用相同的会话 Cookie。 */
export function setSessionCookie(c: Context, token: string, expiresAt: Date): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    expires: expiresAt,
  });
}
