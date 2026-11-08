import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, MiddlewareHandler } from 'hono';
import type { Clock } from './clock';
import { errorBody } from './errors';

export interface RateLimitPolicy {
  /** 每个窗口内允许的请求数。 */
  limit: number;
  windowMs: number;
}

/** 行情只读接口对匿名用户的限流：每个客户端 IP 每分钟 60 次。 */
export const ANONYMOUS_MARKET_RATE_LIMIT: RateLimitPolicy = { limit: 60, windowMs: 60_000 };

/** 请求邮箱验证码接口对每个客户端 IP 的限流：每分钟 5 次。 */
export const EMAIL_CODE_REQUEST_RATE_LIMIT: RateLimitPolicy = { limit: 5, windowMs: 60_000 };

/** 邮箱验证码登录接口对每个客户端 IP 的限流：每分钟 10 次。 */
export const EMAIL_LOGIN_RATE_LIMIT: RateLimitPolicy = { limit: 10, windowMs: 60_000 };

/** GitHub 发起与回调接口各自按客户端 IP 每分钟最多 10 次。 */
export const GITHUB_LOGIN_RATE_LIMIT: RateLimitPolicy = { limit: 10, windowMs: 60_000 };

/** 微信小程序登录按客户端 IP 每分钟最多 10 次。 */
export const WECHAT_LOGIN_RATE_LIMIT: RateLimitPolicy = { limit: 10, windowMs: 60_000 };

/** 绑定码生成按 IP 限制，避免反复作废当前绑定码。 */
export const BIND_CODE_GENERATE_RATE_LIMIT: RateLimitPolicy = { limit: 5, windowMs: 60_000 };

/** 绑定码提交按 IP 限制；成功与失败都计数，连续失败最多每分钟 5 次。 */
export const BIND_CODE_SUBMIT_RATE_LIMIT: RateLimitPolicy = { limit: 5, windowMs: 60_000 };

interface Bucket {
  windowStart: number;
  count: number;
}

/** 进程内固定窗口限流，时间取自可注入的时钟。 */
export function rateLimit(policy: RateLimitPolicy, clock: Clock): MiddlewareHandler {
  const buckets = new Map<string, Bucket>();
  let lastSweep = 0;

  return async (c, next) => {
    const now = clock.now().getTime();
    if (now - lastSweep >= policy.windowMs) {
      for (const [key, bucket] of buckets) {
        if (now - bucket.windowStart >= policy.windowMs) buckets.delete(key);
      }
      lastSweep = now;
    }

    const key = clientKey(c);
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.windowStart >= policy.windowMs) {
      bucket = { windowStart: now, count: 0 };
      buckets.set(key, bucket);
    }
    bucket.count++;

    const remaining = Math.max(0, policy.limit - bucket.count);
    c.header('RateLimit-Limit', String(policy.limit));
    c.header('RateLimit-Remaining', String(remaining));
    if (bucket.count > policy.limit) {
      const retryAfter = Math.max(
        1,
        Math.ceil((bucket.windowStart + policy.windowMs - now) / 1000),
      );
      c.header('Retry-After', String(retryAfter));
      return c.json(errorBody('rate_limited', '请求过于频繁，请稍后再试'), 429);
    }
    await next();
  };
}

/**
 * 客户端标识：部署时 core 位于 Caddy 之后，Caddy 会把它看到的对端地址追加到
 * X-Forwarded-For 末尾，因此取最右一项（客户端可伪造的是左侧各项）；
 * 没有该请求头时退回到连接的对端地址。
 */
function clientKey(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) {
    const last = forwarded.split(',').at(-1)?.trim();
    if (last) return last;
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
