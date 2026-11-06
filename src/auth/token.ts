import { createHash, randomBytes, randomInt } from 'node:crypto';

/** 生成不透明会话令牌（数据库只存其哈希）。 */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** 生成 6 位十进制验证码（含前导零）。 */
export function generateVerificationCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
