import { timingSafeEqual } from 'node:crypto';
import { and, count, desc, eq, gte, isNull } from 'drizzle-orm';
import { shanghaiDate, type Clock } from '../clock';
import type { Db } from '../db';
import { channels, emailVerificationCodes, loginMethods, sessions, users } from '../db/schema';
import type { ErrorCode } from '../errors';
import type { Mailer } from './mailer';
import { generateSessionToken, generateVerificationCode, sha256Hex } from './token';

/** 会话所属的设备类型：网页（httpOnly Cookie）或小程序（请求头）。 */
export type Device = 'web' | 'miniprogram';

/** 登录方式类型。 */
export type LoginMethodType = 'email' | 'github' | 'wechat';

/** 业务规则抛出的错误：由路由层映射成统一的错误响应。 */
export class AuthError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: 400 | 429,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/** 验证码有效期。 */
export const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
/** 同一邮箱两次请求验证码的最小间隔。 */
export const EMAIL_CODE_COOLDOWN_MS = 60 * 1000;
/** 同一邮箱每天最多请求验证码的次数。 */
export const EMAIL_CODE_DAILY_LIMIT = 10;
/** 验证码最多允许输错的次数，达到后作废。 */
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
/** 会话有效期。 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 新用户首次登录时预置的渠道。 */
export const PRESET_CHANNELS = ['支付宝', '天天基金', '未指定'] as const;

export interface SessionInfo {
  userId: string;
  sessionId: string;
  device: Device;
}

export interface AuthService {
  requestCode(email: string): Promise<void>;
  loginWithEmail(
    email: string,
    code: string,
    device: Device,
  ): Promise<{ userId: string; token: string; device: Device; expiresAt: Date }>;
  logout(token: string): Promise<void>;
  authenticate(token: string): Promise<SessionInfo | null>;
  me(userId: string): Promise<{
    id: string;
    loginMethods: { type: LoginMethodType; externalId: string }[];
    channels: { id: string; name: string }[];
  }>;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hashMatches(storedHex: string, candidateHex: string): boolean {
  const stored = Buffer.from(storedHex, 'hex');
  const candidate = Buffer.from(candidateHex, 'hex');
  return stored.length === candidate.length && timingSafeEqual(stored, candidate);
}

/** 按 Asia/Shanghai 理解的当日 00:00 对应的时刻。 */
function shanghaiDayStart(date: Date): Date {
  return new Date(`${shanghaiDate(date)}T00:00:00+08:00`);
}

export function createAuthService(deps: { db: Db; mailer: Mailer; clock: Clock }): AuthService {
  const { db, mailer, clock } = deps;

  return {
    async requestCode(email) {
      const normalized = normalizeEmail(email);
      const now = clock.now();

      const [latest] = await db
        .select({ createdAt: emailVerificationCodes.createdAt })
        .from(emailVerificationCodes)
        .where(eq(emailVerificationCodes.email, normalized))
        .orderBy(desc(emailVerificationCodes.createdAt))
        .limit(1);
      if (latest && latest.createdAt.getTime() + EMAIL_CODE_COOLDOWN_MS > now.getTime()) {
        throw new AuthError('email_code_cooldown', '验证码请求过于频繁，请稍后再试', 429);
      }

      const dayStart = shanghaiDayStart(now);
      const [todayCount] = await db
        .select({ n: count() })
        .from(emailVerificationCodes)
        .where(
          and(
            eq(emailVerificationCodes.email, normalized),
            gte(emailVerificationCodes.createdAt, dayStart),
          ),
        );
      if ((todayCount?.n ?? 0) >= EMAIL_CODE_DAILY_LIMIT) {
        throw new AuthError('email_code_daily_limit', '今日验证码请求次数已达上限', 429);
      }

      const code = generateVerificationCode();
      const codeHash = sha256Hex(code);
      const expiresAt = new Date(now.getTime() + EMAIL_CODE_TTL_MS);

      // 新验证码作废该邮箱此前尚未使用的验证码，保证只有最新一个可用。
      await db
        .update(emailVerificationCodes)
        .set({ usedAt: now })
        .where(
          and(eq(emailVerificationCodes.email, normalized), isNull(emailVerificationCodes.usedAt)),
        );
      await db
        .insert(emailVerificationCodes)
        .values({ email: normalized, codeHash, expiresAt, createdAt: now });
      await mailer.sendVerificationCode(normalized, code);
    },

    async loginWithEmail(email, code, device) {
      const normalized = normalizeEmail(email);
      const trimmedCode = code.trim();
      const now = clock.now();

      const [latest] = await db
        .select()
        .from(emailVerificationCodes)
        .where(eq(emailVerificationCodes.email, normalized))
        .orderBy(desc(emailVerificationCodes.createdAt))
        .limit(1);
      if (!latest) {
        throw new AuthError('verification_code_invalid', '验证码不正确', 400);
      }
      if (latest.usedAt) {
        throw new AuthError('verification_code_used', '验证码已使用', 400);
      }
      if (latest.expiresAt <= now) {
        throw new AuthError('verification_code_expired', '验证码已过期', 400);
      }
      if (latest.attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
        throw new AuthError('verification_code_max_attempts', '验证码已作废，请重新获取', 400);
      }
      if (!hashMatches(latest.codeHash, sha256Hex(trimmedCode))) {
        const nextAttempts = latest.attempts + 1;
        await db
          .update(emailVerificationCodes)
          .set({ attempts: nextAttempts })
          .where(eq(emailVerificationCodes.id, latest.id));
        if (nextAttempts >= EMAIL_CODE_MAX_ATTEMPTS) {
          throw new AuthError('verification_code_max_attempts', '验证码错误次数过多，已作废', 400);
        }
        throw new AuthError('verification_code_invalid', '验证码不正确', 400);
      }

      const token = generateSessionToken();
      const tokenHash = sha256Hex(token);
      const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

      const { userId } = await db.transaction(async (tx) => {
        await tx
          .update(emailVerificationCodes)
          .set({ usedAt: now })
          .where(eq(emailVerificationCodes.id, latest.id));

        const [method] = await tx
          .select()
          .from(loginMethods)
          .where(and(eq(loginMethods.type, 'email'), eq(loginMethods.externalId, normalized)))
          .limit(1);

        let userId = method?.userId;
        if (!userId) {
          const [created] = await tx.insert(users).values({}).returning({ id: users.id });
          if (!created) {
            throw new Error('创建用户失败');
          }
          userId = created.id;
          await tx.insert(loginMethods).values({ userId, type: 'email', externalId: normalized });
          await tx
            .insert(channels)
            .values(
              PRESET_CHANNELS.map((name, sortOrder) => ({ userId: created.id, name, sortOrder })),
            );
        }

        await tx.insert(sessions).values({ userId, tokenHash, device, expiresAt });
        return { userId };
      });

      return { userId, token, device, expiresAt };
    },

    async logout(token) {
      const tokenHash = sha256Hex(token);
      await db
        .update(sessions)
        .set({ revokedAt: clock.now() })
        .where(eq(sessions.tokenHash, tokenHash));
    },

    async authenticate(token) {
      const tokenHash = sha256Hex(token);
      const now = clock.now();
      const [session] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.tokenHash, tokenHash))
        .limit(1);
      if (!session || session.revokedAt || session.expiresAt <= now) {
        return null;
      }
      return { userId: session.userId, sessionId: session.id, device: session.device as Device };
    },

    async me(userId) {
      const methods = await db
        .select({ type: loginMethods.type, externalId: loginMethods.externalId })
        .from(loginMethods)
        .where(eq(loginMethods.userId, userId));
      const userChannels = await db
        .select({ id: channels.id, name: channels.name })
        .from(channels)
        .where(eq(channels.userId, userId))
        .orderBy(channels.sortOrder);
      return {
        id: userId,
        loginMethods: methods.map((m) => ({
          type: m.type as LoginMethodType,
          externalId: m.externalId,
        })),
        channels: userChannels,
      };
    },
  };
}
