import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, lte } from 'drizzle-orm';
import type { Clock } from '../clock';
import type { Db } from '../db';
import { qrLoginTickets, users, sessions } from '../db/schema';
import { AuthError, SESSION_TTL_MS, type SessionInfo } from './service';
import { generateSessionToken, sha256Hex } from './token';
import type { WeChatQrCode } from './wechat-qr';

export const QR_BROWSER_COOKIE = '__Host-bafang_qr';
export const QR_TICKET_TTL_MS = 5 * 60 * 1000;
/** 保留浏览器绑定以便在票据过期后短时轮询到 expired 状态。 */
export const QR_BROWSER_GRACE_MS = 5 * 60 * 1000;

export function createQrLoginService(deps: {
  db: Db;
  clock: Clock;
  qr: WeChatQrCode;
  ttlMs: number;
}) {
  const { db, clock, qr, ttlMs } = deps;
  return {
    async start() {
      // 192 位随机值编码为 32 个可见字符，满足微信 scene 上限；库里仍只存哈希。
      const ticketId = randomBytes(24).toString('base64url');
      const browser = generateSessionToken();
      let image: Awaited<ReturnType<WeChatQrCode['generate']>>;
      try {
        image = await qr.generate(ticketId);
      } catch {
        throw new AuthError('wechat_unavailable', '小程序码暂不可用，请稍后重试', 502);
      }
      const now = clock.now();
      const expiresAt = new Date(now.getTime() + ttlMs);
      await db
        .delete(qrLoginTickets)
        .where(lte(qrLoginTickets.expiresAt, new Date(now.getTime() - 24 * 60 * 60 * 1000)));
      await db
        .insert(qrLoginTickets)
        .values({ ticketHash: sha256Hex(ticketId), browserHash: sha256Hex(browser), expiresAt });
      return { ticketId, browser, expiresAt, image };
    },
    async poll(ticketId: string, browser: string | undefined) {
      if (!browser) throw new AuthError('qr_browser_invalid', '请使用申请票据的浏览器', 403);
      const ticketHash = sha256Hex(ticketId);
      const browserHash = sha256Hex(browser);
      return db.transaction(async (tx) => {
        const [preview] = await tx
          .select()
          .from(qrLoginTickets)
          .where(
            and(
              eq(qrLoginTickets.ticketHash, ticketHash),
              eq(qrLoginTickets.browserHash, browserHash),
            ),
          );
        if (!preview) throw new AuthError('qr_browser_invalid', '票据或浏览器凭据无效', 403);
        // 与身份关联/删除保持用户行在票据行之前的锁顺序。
        if (preview.userId) {
          const [owner] = await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, preview.userId))
            .for('share');
          if (!owner) return { status: 'expired' as const };
        }
        const [ticket] = await tx
          .select()
          .from(qrLoginTickets)
          .where(
            and(
              eq(qrLoginTickets.ticketHash, ticketHash),
              eq(qrLoginTickets.browserHash, browserHash),
            ),
          )
          .for('update');
        if (!ticket || ticket.expiresAt <= clock.now()) return { status: 'expired' as const };
        if (ticket.consumedAt) return { status: 'consumed' as const };
        if (!ticket.userId || ticket.userId !== preview.userId)
          return { status: 'pending' as const };
        const token = generateSessionToken();
        const now = clock.now();
        const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
        await tx
          .insert(sessions)
          .values({ userId: ticket.userId, tokenHash: sha256Hex(token), device: 'web', expiresAt });
        await tx
          .update(qrLoginTickets)
          .set({ consumedAt: now })
          .where(eq(qrLoginTickets.ticketHash, ticketHash));
        return { status: 'confirmed' as const, userId: ticket.userId, token, expiresAt };
      });
    },
    async confirm(ticketId: string, session: SessionInfo) {
      await db.transaction(async (tx) => {
        const [owner] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, session.userId))
          .for('share');
        const [active] = await tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(
            and(
              eq(sessions.id, session.sessionId),
              eq(sessions.userId, session.userId),
              eq(sessions.device, 'miniprogram'),
              isNull(sessions.revokedAt),
              gt(sessions.expiresAt, clock.now()),
            ),
          );
        if (!owner || !active) throw new AuthError('unauthorized', '需要有效的小程序会话', 401);
        const [ticket] = await tx
          .select()
          .from(qrLoginTickets)
          .where(eq(qrLoginTickets.ticketHash, sha256Hex(ticketId)))
          .for('update');
        if (!ticket) throw new AuthError('qr_ticket_invalid', '登录票据不存在', 404);
        const now = clock.now();
        if (ticket.expiresAt <= now)
          throw new AuthError('qr_ticket_expired', '登录票据已过期', 400);
        if (ticket.consumedAt) throw new AuthError('qr_ticket_used', '登录票据已消费', 409);
        if (ticket.confirmedAt) throw new AuthError('qr_ticket_confirmed', '登录票据已确认', 409);
        await tx
          .update(qrLoginTickets)
          .set({ userId: session.userId, confirmedAt: now })
          .where(eq(qrLoginTickets.ticketHash, ticket.ticketHash));
      });
      return { status: 'confirmed' as const };
    },
  };
}
