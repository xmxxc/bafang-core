import { timingSafeEqual } from 'node:crypto';
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { shanghaiDate, type Clock } from '../clock';
import type { Db } from '../db';
import { BIND_CODE_POLICY } from '../config';
import {
  bindCodes,
  bindCodeFailures,
  channels,
  emailVerificationCodes,
  loginMethods,
  sessions,
  users,
} from '../db/schema';
import { userHasPositions as queryUserHasPositions } from '../positions/service';
import type { ErrorCode } from '../errors';
import type { Mailer } from './mailer';
import { generateSessionToken, generateVerificationCode, hmacSha256Hex, sha256Hex } from './token';

/** 会话所属的设备类型：网页（httpOnly Cookie）或小程序（请求头）。 */
export type Device = 'web' | 'miniprogram';

/** 登录方式类型。 */
export type LoginMethodType = 'email' | 'github' | 'wechat';
export type VerificationPurpose = 'login' | 'link';

/** 业务规则抛出的错误：由路由层映射成统一的错误响应。 */
export class AuthError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 502 | 503,
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
/** 绑定码有效期。 */
export const BIND_CODE_TTL_MS = 10 * 60 * 1000;
/** 绑定码历史保留窗口；超过窗口后清理，避免永久占用码值。 */
const BIND_CODE_RETENTION_MS = BIND_CODE_POLICY.retentionMs;
/** 生成绑定码遇到有效码值碰撞时的最大重试次数。 */
const BIND_CODE_GENERATION_ATTEMPTS = BIND_CODE_POLICY.generationAttempts;
/** 同一微信身份 24 小时内最多允许的无效绑定码失败次数。 */
const BIND_CODE_OPENID_FAILURE_LIMIT = BIND_CODE_POLICY.openidFailureLimit;
const BIND_CODE_OPENID_FAILURE_WINDOW_MS = BIND_CODE_POLICY.openidFailureWindowMs;
/** 全站 1 小时内最多允许的无效绑定码失败次数。 */
const BIND_CODE_GLOBAL_FAILURE_LIMIT = BIND_CODE_POLICY.globalFailureLimit;
const BIND_CODE_GLOBAL_FAILURE_WINDOW_MS = BIND_CODE_POLICY.globalFailureWindowMs;

/** 新用户首次登录时预置的渠道。 */
export const PRESET_CHANNELS = ['支付宝', '天天基金', '未指定'] as const;

export interface SessionInfo {
  userId: string;
  sessionId: string;
  device: Device;
}

export interface AuthService {
  requestCode(email: string, purpose?: VerificationPurpose): Promise<void>;
  loginWithEmail(
    email: string,
    code: string,
    device: Device,
  ): Promise<{ userId: string; token: string; device: Device; expiresAt: Date }>;
  loginWithGitHubId(externalId: string): ReturnType<AuthService['loginWithEmail']>;
  loginWithWeChatOpenId(openid: string): ReturnType<AuthService['loginWithEmail']>;
  associateLoginMethod(
    userId: string,
    type: LoginMethodType,
    externalId: string,
  ): Promise<{ userId: string; type: LoginMethodType; externalId: string }>;
  associateEmail(
    userId: string,
    email: string,
    code: string,
  ): Promise<{ userId: string; type: LoginMethodType; externalId: string }>;
  unlinkLoginMethod(userId: string, type: LoginMethodType): Promise<void>;
  listLoginMethods(userId: string): Promise<{ type: LoginMethodType; display: string }[]>;
  logout(sessionId: string): Promise<void>;
  generateBindCode(userId: string): Promise<{ code: string; expiresAt: Date }>;
  bindWeChatCode(
    code: string,
    openid: string,
  ): Promise<{ userId: string; token: string; device: 'miniprogram'; expiresAt: Date }>;
  authenticate(token: string): Promise<SessionInfo | null>;
  me(userId: string): Promise<{
    id: string;
    loginMethods: { type: LoginMethodType; externalId: string }[];
    channels: { id: string; name: string }[];
  }>;
}

type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];
export type UserPositionsChecker = (tx: Transaction, userId: string) => Promise<boolean>;

/** 在当前事务里查询用户是否有任何持仓（含已清仓），用于空用户判定。 */
export const userHasPositions: UserPositionsChecker = queryUserHasPositions;

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

export function createAuthService(deps: {
  db: Db;
  mailer: Mailer;
  clock: Clock;
  hasPositions?: UserPositionsChecker;
  bindCodeSecret?: string;
  bindCodeGenerator?: () => string;
}): AuthService {
  const { db, mailer, clock } = deps;
  const hasPositions = deps.hasPositions ?? userHasPositions;
  const bindCodeSecret = deps.bindCodeSecret?.trim();
  const bindCodeGenerator = deps.bindCodeGenerator ?? generateVerificationCode;

  async function lockIdentity(tx: Transaction, type: string, externalId: string) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${type + ':' + externalId}))`);
  }

  // 三种登录方式共用用户创建、预置渠道与会话写入路径。
  // 加锁顺序（登录、关联、转移、解绑一致）：先身份锁，再按 id 升序锁用户行。
  async function loginWithIdentity(
    tx: Transaction,
    type: LoginMethodType,
    externalId: string,
    device: Device,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<{ userId: string }> {
    await lockIdentity(tx, type, externalId);
    // 身份锁内重新读取归属；持有者被并发转移删除（同一空用户的另一身份被关联走）时重读。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [method] = await tx
        .select({ userId: loginMethods.userId })
        .from(loginMethods)
        .where(and(eq(loginMethods.type, type), eq(loginMethods.externalId, externalId)))
        .limit(1);
      if (!method) break;
      const [owner] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, method.userId))
        .for('share');
      if (owner) {
        await tx.insert(sessions).values({ userId: owner.id, tokenHash, device, expiresAt });
        return { userId: owner.id };
      }
    }
    const [created] = await tx.insert(users).values({}).returning({ id: users.id });
    if (!created) throw new Error('创建用户失败');
    await tx.insert(loginMethods).values({ userId: created.id, type, externalId });
    await tx
      .insert(channels)
      .values(PRESET_CHANNELS.map((name, sortOrder) => ({ userId: created.id, name, sortOrder })));
    await tx.insert(sessions).values({ userId: created.id, tokenHash, device, expiresAt });
    return { userId: created.id };
  }

  /** 按 id 升序锁定用户行，返回仍存在的用户 id。 */
  async function lockUsers(tx: Transaction, userIds: string[]): Promise<Set<string>> {
    const rows = await tx
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, [...new Set(userIds)]))
      .orderBy(asc(users.id))
      .for('update');
    return new Set(rows.map((row) => row.id));
  }

  async function associateInTransaction(
    tx: Transaction,
    currentUserId: string,
    type: LoginMethodType,
    externalId: string,
    beforeAssociate?: () => Promise<void>,
  ) {
    await lockIdentity(tx, type, externalId);
    const [found] = await tx
      .select({ userId: loginMethods.userId })
      .from(loginMethods)
      .where(and(eq(loginMethods.type, type), eq(loginMethods.externalId, externalId)))
      .limit(1);
    const locked = await lockUsers(tx, found ? [currentUserId, found.userId] : [currentUserId]);
    if (!locked.has(currentUserId)) {
      // 当前用户已被并发转移删除，其会话随之失效。
      throw new AuthError('unauthorized', '关联登录方式需要当前会话仍然有效', 401);
    }

    // 绑定码调用方在用户锁后校验并消费码，所有路径均遵守身份 → 用户 → 码行。
    await beforeAssociate?.();

    const [existingForUser] = await tx
      .select({ id: loginMethods.id, externalId: loginMethods.externalId })
      .from(loginMethods)
      .where(and(eq(loginMethods.userId, currentUserId), eq(loginMethods.type, type)))
      .limit(1);
    if (existingForUser) {
      if (existingForUser.externalId === externalId) {
        return { userId: currentUserId, type, externalId };
      }
      throw new AuthError('login_method_type_conflict', '当前用户已关联该类型的登录方式', 409);
    }

    // 用户行锁内重读：持有者可能已被并发转移删除，登录方式随之级联消失。
    const [target] = await tx
      .select({ id: loginMethods.id, userId: loginMethods.userId })
      .from(loginMethods)
      .where(and(eq(loginMethods.type, type), eq(loginMethods.externalId, externalId)))
      .limit(1);
    if (!target) {
      await tx.insert(loginMethods).values({ userId: currentUserId, type, externalId });
      return { userId: currentUserId, type, externalId };
    }
    if (target.userId === currentUserId) {
      return { userId: currentUserId, type, externalId };
    }
    if (!locked.has(target.userId) || (await hasPositions(tx, target.userId))) {
      throw new AuthError('login_method_conflict', '该登录方式已属于有持仓的其他用户', 409);
    }
    await tx
      .update(loginMethods)
      .set({ userId: currentUserId })
      .where(eq(loginMethods.id, target.id));
    // 空用户的会话、渠道及其余登录方式随用户级联清理；整个转移仍在本事务内。
    await tx.delete(users).where(eq(users.id, target.userId));
    return { userId: currentUserId, type, externalId };
  }

  async function failureBudget(
    tx: Transaction,
    scope: string,
    key: string,
    now: Date,
    windowMs: number,
  ): Promise<number> {
    await tx
      .insert(bindCodeFailures)
      .values({ scope, key, windowStarted: now, failures: 0 })
      .onConflictDoNothing();
    const [row] = await tx
      .select({
        windowStarted: bindCodeFailures.windowStarted,
        failures: bindCodeFailures.failures,
      })
      .from(bindCodeFailures)
      .where(and(eq(bindCodeFailures.scope, scope), eq(bindCodeFailures.key, key)))
      .for('update');
    if (!row) throw new Error('绑定码失败预算行不存在');
    if (row.windowStarted.getTime() + windowMs <= now.getTime()) {
      await tx
        .update(bindCodeFailures)
        .set({ windowStarted: now, failures: 0 })
        .where(and(eq(bindCodeFailures.scope, scope), eq(bindCodeFailures.key, key)));
      return 0;
    }
    return row.failures;
  }

  async function recordBindCodeFailure(tx: Transaction, openid: string, globalFailures: number) {
    await tx
      .update(bindCodeFailures)
      .set({ failures: sql`${bindCodeFailures.failures} + 1` })
      .where(and(eq(bindCodeFailures.scope, 'global'), eq(bindCodeFailures.key, 'global')));
    await tx
      .update(bindCodeFailures)
      .set({ failures: sql`${bindCodeFailures.failures} + 1` })
      .where(and(eq(bindCodeFailures.scope, 'openid'), eq(bindCodeFailures.key, openid)));
    if (globalFailures + 1 === BIND_CODE_GLOBAL_FAILURE_LIMIT) {
      console.warn('[bafang-core] binding-code global failure budget reached (300/hour)');
    }
  }

  async function loginWithExternalIdentity(
    type: LoginMethodType,
    externalId: string,
    device: Device,
  ) {
    const token = generateSessionToken();
    const expiresAt = new Date(clock.now().getTime() + SESSION_TTL_MS);
    const result = await db.transaction((tx) =>
      loginWithIdentity(tx, type, externalId, device, sha256Hex(token), expiresAt),
    );
    return { userId: result.userId, token, device, expiresAt };
  }

  async function consumeVerificationCode(
    tx: Transaction,
    email: string,
    code: string,
    now: Date,
    purpose: VerificationPurpose,
  ): Promise<AuthError | null> {
    const [latest] = await tx
      .select()
      .from(emailVerificationCodes)
      .where(
        and(eq(emailVerificationCodes.email, email), eq(emailVerificationCodes.purpose, purpose)),
      )
      .orderBy(desc(emailVerificationCodes.createdAt))
      .limit(1);
    if (!latest) return new AuthError('verification_code_invalid', '验证码不正确', 400);
    if (latest.usedAt) return new AuthError('verification_code_used', '验证码已使用', 400);
    if (latest.expiresAt <= now)
      return new AuthError('verification_code_expired', '验证码已过期', 400);
    if (latest.attempts >= EMAIL_CODE_MAX_ATTEMPTS)
      return new AuthError('verification_code_max_attempts', '验证码已作废，请重新获取', 400);
    if (!hashMatches(latest.codeHash, sha256Hex(code.trim()))) {
      const [updated] = await tx
        .update(emailVerificationCodes)
        .set({ attempts: sql`${emailVerificationCodes.attempts} + 1` })
        .where(
          and(
            eq(emailVerificationCodes.id, latest.id),
            isNull(emailVerificationCodes.usedAt),
            gt(emailVerificationCodes.expiresAt, now),
            lt(emailVerificationCodes.attempts, EMAIL_CODE_MAX_ATTEMPTS),
          ),
        )
        .returning({ attempts: emailVerificationCodes.attempts });
      if (updated?.attempts && updated.attempts >= EMAIL_CODE_MAX_ATTEMPTS)
        return new AuthError('verification_code_max_attempts', '验证码错误次数过多，已作废', 400);
      return new AuthError('verification_code_invalid', '验证码不正确', 400);
    }
    const [consumed] = await tx
      .update(emailVerificationCodes)
      .set({ usedAt: now })
      .where(
        and(
          eq(emailVerificationCodes.id, latest.id),
          isNull(emailVerificationCodes.usedAt),
          gt(emailVerificationCodes.expiresAt, now),
          lt(emailVerificationCodes.attempts, EMAIL_CODE_MAX_ATTEMPTS),
        ),
      )
      .returning({ id: emailVerificationCodes.id });
    return consumed ? null : new AuthError('verification_code_used', '验证码已使用', 400);
  }

  return {
    async requestCode(email, purpose: VerificationPurpose = 'login') {
      const normalized = normalizeEmail(email);
      const now = clock.now();
      const code = generateVerificationCode();
      const codeHash = sha256Hex(code);
      const expiresAt = new Date(now.getTime() + EMAIL_CODE_TTL_MS);

      // 同一邮箱的并发请求用事务级 advisory lock 串行化，持锁完成冷却/每日上限检查与插入；
      // 发信放到事务提交之后，避免在事务里做网络调用。
      const insertedId = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${normalized}))`);

        const [latest] = await tx
          .select({ createdAt: emailVerificationCodes.createdAt })
          .from(emailVerificationCodes)
          .where(eq(emailVerificationCodes.email, normalized))
          .orderBy(desc(emailVerificationCodes.createdAt))
          .limit(1);
        if (latest && latest.createdAt.getTime() + EMAIL_CODE_COOLDOWN_MS > now.getTime()) {
          throw new AuthError('email_code_cooldown', '验证码请求过于频繁，请稍后再试', 429);
        }

        const dayStart = shanghaiDayStart(now);
        const [todayCount] = await tx
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

        // 新验证码作废该邮箱此前尚未使用的验证码，保证只有最新一个可用。
        await tx
          .update(emailVerificationCodes)
          .set({ usedAt: now })
          .where(
            and(
              eq(emailVerificationCodes.email, normalized),
              eq(emailVerificationCodes.purpose, purpose),
              isNull(emailVerificationCodes.usedAt),
            ),
          );

        const [inserted] = await tx
          .insert(emailVerificationCodes)
          .values({ email: normalized, purpose, codeHash, expiresAt, createdAt: now })
          .returning({ id: emailVerificationCodes.id });
        return inserted?.id;
      });

      try {
        await mailer.sendVerificationCode(normalized, code);
      } catch (error) {
        // 发信失败回滚这条验证码，不占用冷却和每日次数（E9）。
        if (insertedId) {
          await db.delete(emailVerificationCodes).where(eq(emailVerificationCodes.id, insertedId));
        }
        throw error;
      }
    },

    async loginWithEmail(email, code, device) {
      const normalized = normalizeEmail(email);
      const now = clock.now();
      const token = generateSessionToken();
      const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
      const result = await db.transaction(async (tx) => {
        // 身份锁先于用户锁；验证码校验、消费和归属读取在同一锁内完成。
        await lockIdentity(tx, 'email', normalized);
        const verificationError = await consumeVerificationCode(tx, normalized, code, now, 'login');
        if (verificationError) return { error: verificationError };
        return {
          value: await loginWithIdentity(
            tx,
            'email',
            normalized,
            device,
            sha256Hex(token),
            expiresAt,
          ),
        };
      });
      if ('error' in result) throw result.error;
      return { userId: result.value.userId, token, device, expiresAt };
    },

    async loginWithGitHubId(externalId) {
      return loginWithExternalIdentity('github', externalId, 'web');
    },

    async loginWithWeChatOpenId(openid) {
      return loginWithExternalIdentity('wechat', openid, 'miniprogram');
    },

    async associateLoginMethod(userId, type, externalId) {
      const normalized = type === 'email' ? normalizeEmail(externalId) : externalId;
      return db.transaction((tx) => associateInTransaction(tx, userId, type, normalized));
    },

    async associateEmail(userId, email, code) {
      const normalized = normalizeEmail(email);
      const now = clock.now();
      const result = await db.transaction(async (tx) => {
        await lockIdentity(tx, 'email', normalized);
        const verificationError = await consumeVerificationCode(tx, normalized, code, now, 'link');
        if (verificationError) return { error: verificationError };
        return { value: await associateInTransaction(tx, userId, 'email', normalized) };
      });
      if ('error' in result) throw result.error;
      return result.value;
    },

    async generateBindCode(userId) {
      if (!bindCodeSecret) throw new AuthError('bind_code_not_configured', '绑定码功能未配置', 503);
      const now = clock.now();
      const expiresAt = new Date(now.getTime() + BIND_CODE_TTL_MS);
      const retentionCutoff = new Date(now.getTime() - BIND_CODE_RETENTION_MS);
      for (let attempt = 0; attempt < BIND_CODE_GENERATION_ATTEMPTS; attempt += 1) {
        const code = bindCodeGenerator();
        const codeHash = hmacSha256Hex(code, bindCodeSecret);
        const inserted = await db.transaction(async (tx) => {
          // 生成与消费都先取得绑定码身份锁，再锁用户行，最后修改绑定码行。
          await lockIdentity(tx, 'bind_code', codeHash);
          // 清理历史与退役候选码前，按 id 升序锁住所有涉及的用户。
          const previousOwners = await tx
            .select({ id: bindCodes.id, userId: bindCodes.userId })
            .from(bindCodes)
            .where(or(eq(bindCodes.codeHash, codeHash), lt(bindCodes.createdAt, retentionCutoff)));
          const locked = await lockUsers(tx, [userId, ...previousOwners.map((row) => row.userId)]);
          if (!locked.has(userId))
            throw new AuthError('unauthorized', '生成绑定码需要当前用户仍然存在', 401);
          // 包括当前用户自己的有效码；作废旧码前先排除同值重发。
          const [collision] = await tx
            .select({ id: bindCodes.id })
            .from(bindCodes)
            .where(
              and(
                eq(bindCodes.codeHash, codeHash),
                eq(bindCodes.active, true),
                gt(bindCodes.expiresAt, now),
              ),
            )
            .limit(1);
          if (collision) return false;
          await tx.delete(bindCodes).where(
            and(
              inArray(
                bindCodes.id,
                previousOwners.map((row) => row.id),
              ),
              lt(bindCodes.createdAt, retentionCutoff),
            ),
          );
          await tx
            .update(bindCodes)
            .set({ active: false })
            .where(
              and(
                eq(bindCodes.codeHash, codeHash),
                eq(bindCodes.active, true),
                lte(bindCodes.expiresAt, now),
              ),
            );
          await tx
            .update(bindCodes)
            .set({ active: false, usedAt: now })
            .where(and(eq(bindCodes.userId, userId), eq(bindCodes.active, true)));
          await tx.insert(bindCodes).values({
            userId,
            codeHash,
            active: true,
            expiresAt,
            createdAt: now,
          });
          return true;
        });
        if (inserted) return { code, expiresAt };
      }
      throw new AuthError('bind_code_unavailable', '绑定码暂时无法生成，请稍后重试', 503);
    },

    async bindWeChatCode(code, openid) {
      if (!bindCodeSecret) throw new AuthError('bind_code_not_configured', '绑定码功能未配置', 503);
      const token = generateSessionToken();
      const now = clock.now();
      const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
      const codeHash = hmacSha256Hex(code, bindCodeSecret);
      const result = await db.transaction(async (tx) => {
        // 预算行始终按全局 → openid 加锁，先于任何身份/用户/码行锁；跨实例原子计数。
        const globalFailures = await failureBudget(
          tx,
          'global',
          'global',
          now,
          BIND_CODE_GLOBAL_FAILURE_WINDOW_MS,
        );
        const openidFailures = await failureBudget(
          tx,
          'openid',
          openid,
          now,
          BIND_CODE_OPENID_FAILURE_WINDOW_MS,
        );
        if (
          globalFailures >= BIND_CODE_GLOBAL_FAILURE_LIMIT ||
          openidFailures >= BIND_CODE_OPENID_FAILURE_LIMIT
        ) {
          return {
            error: new AuthError('rate_limited', '绑定码提交失败次数过多，请稍后再试', 429),
          };
        }
        try {
          // SAVEPOINT 保证并发作废时关联/消费回滚，外层仍能提交失败预算。
          const value = await tx.transaction(async (bindingTx) => {
            await lockIdentity(bindingTx, 'bind_code', codeHash);
            const [bindCode] = await bindingTx
              .select()
              .from(bindCodes)
              .where(
                and(
                  eq(bindCodes.codeHash, codeHash),
                  gte(bindCodes.createdAt, new Date(now.getTime() - BIND_CODE_RETENTION_MS)),
                ),
              )
              .orderBy(
                desc(sql`${bindCodes.active} AND ${bindCodes.expiresAt} > ${now}`),
                desc(bindCodes.createdAt),
                desc(bindCodes.id),
              )
              .limit(1);
            if (!bindCode) throw new AuthError('bind_code_invalid', '绑定码不存在', 400);
            if (bindCode.usedAt) throw new AuthError('bind_code_used', '绑定码已使用', 400);
            if (bindCode.expiresAt <= now)
              throw new AuthError('bind_code_expired', '绑定码已过期', 400);
            const linked = await associateInTransaction(
              bindingTx,
              bindCode.userId,
              'wechat',
              openid,
              async () => {
                const [lockedCode] = await bindingTx
                  .select()
                  .from(bindCodes)
                  .where(eq(bindCodes.id, bindCode.id))
                  .for('update');
                if (!lockedCode || lockedCode.usedAt || !lockedCode.active)
                  throw new AuthError('bind_code_used', '绑定码已使用', 400);
                if (lockedCode.expiresAt <= clock.now())
                  throw new AuthError('bind_code_expired', '绑定码已过期', 400);
                await bindingTx
                  .update(bindCodes)
                  .set({ usedAt: clock.now(), active: false })
                  .where(eq(bindCodes.id, lockedCode.id));
              },
            );
            await bindingTx.insert(sessions).values({
              userId: linked.userId,
              tokenHash: sha256Hex(token),
              device: 'miniprogram',
              expiresAt,
            });
            return { userId: linked.userId };
          });
          // 成功不清零任何预算；计数仅随窗口到期归零。
          return { value };
        } catch (error) {
          if (
            error instanceof AuthError &&
            ['bind_code_invalid', 'bind_code_expired', 'bind_code_used'].includes(error.code)
          ) {
            await recordBindCodeFailure(tx, openid, globalFailures);
            return { error };
          }
          throw error;
        }
      });
      if ('error' in result) throw result.error;
      return {
        userId: result.value.userId,
        token,
        device: 'miniprogram' as const,
        expiresAt,
      };
    },

    async unlinkLoginMethod(userId, type) {
      await db.transaction(async (tx) => {
        // 先身份锁再用户锁；加锁前读到的标识在锁内复核，变了就换锁重读。
        let locked: string | undefined;
        for (;;) {
          const [candidate] = await tx
            .select({ externalId: loginMethods.externalId })
            .from(loginMethods)
            .where(and(eq(loginMethods.userId, userId), eq(loginMethods.type, type)))
            .limit(1);
          if (!candidate || candidate.externalId === locked) break;
          await lockIdentity(tx, type, candidate.externalId);
          locked = candidate.externalId;
        }
        await lockUsers(tx, [userId]);
        const methods = await tx
          .select({ id: loginMethods.id })
          .from(loginMethods)
          .where(eq(loginMethods.userId, userId));
        if (methods.length <= 1) {
          throw new AuthError('login_method_last', '至少保留一种登录方式', 409);
        }
        const [deleted] = await tx
          .delete(loginMethods)
          .where(and(eq(loginMethods.userId, userId), eq(loginMethods.type, type)))
          .returning({ id: loginMethods.id });
        if (!deleted) throw new AuthError('login_method_not_found', '未关联该登录方式', 404);
      });
    },

    async listLoginMethods(userId) {
      const methods = await db
        .select({ type: loginMethods.type, externalId: loginMethods.externalId })
        .from(loginMethods)
        .where(eq(loginMethods.userId, userId));
      return methods.map((method) => ({
        type: method.type as LoginMethodType,
        display:
          method.type === 'email'
            ? method.externalId
            : method.type === 'github'
              ? `GitHub 用户 ${method.externalId}`
              : `微信用户 ${method.externalId}`,
      }));
    },

    async logout(sessionId) {
      await db.update(sessions).set({ revokedAt: clock.now() }).where(eq(sessions.id, sessionId));
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
