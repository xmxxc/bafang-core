import { OpenAPIHono } from '@hono/zod-openapi';
import { setCookie, deleteCookie } from 'hono/cookie';
import { SystemClock, type Clock } from './clock';
import { ChineseTradingCalendar, type TradingCalendar } from './trading-calendar';
import { type Db, type HealthProbe } from './db';
import { errorBody } from './errors';
import { healthRoute } from './routes/health';
import { fundDetailRoute, fundSearchRoute } from './routes/funds';
import { estimateBatchRoute } from './routes/estimates';
import { latestNavRoute, navHistoryRoute } from './routes/nav';
import { marketStatusRoute } from './routes/market-status';
import { emailCodeRequestRoute, emailLoginRoute, logoutRoute, meRoute } from './routes/auth';
import { createFundService } from './market/funds';
import { createNavService } from './market/nav';
import { createEstimateService } from './market/estimates';
import { marketStatus } from './market/status';
import { HttpUpstreamFetcher, UpstreamError, type UpstreamFetcher } from './market/upstream';
import {
  ANONYMOUS_MARKET_RATE_LIMIT,
  EMAIL_CODE_REQUEST_RATE_LIMIT,
  EMAIL_LOGIN_RATE_LIMIT,
  rateLimit,
} from './rate-limit';
import { MissingMailer, type Mailer } from './auth/mailer';
import {
  AuthError,
  createAuthService,
  EMAIL_CODE_COOLDOWN_MS,
  SESSION_TTL_MS,
  type AuthService,
} from './auth/service';
import { getAuth, requireAuth, SESSION_COOKIE } from './auth/middleware';

export interface AppDeps {
  db?: HealthProbe;
  /** 身份与登录模块使用的数据库；测试连接真实 PostgreSQL 测试库时传入。 */
  database?: Db;
  /** 发信适配器；测试时替换为假发信。 */
  mailer?: Mailer;
  clock?: Clock;
  tradingCalendar?: TradingCalendar;
  /** 统一上游抓取适配器；测试时整体替换为录制样本。 */
  upstream?: UpstreamFetcher;
}

export interface ResolvedDeps {
  db: HealthProbe | undefined;
  database: Db | undefined;
  mailer: Mailer;
  clock: Clock;
  tradingCalendar: TradingCalendar;
  upstream: UpstreamFetcher;
}

export function resolveDeps(deps: AppDeps = {}): ResolvedDeps {
  return {
    db: deps.db,
    database: deps.database,
    mailer: deps.mailer ?? new MissingMailer(),
    clock: deps.clock ?? new SystemClock(),
    tradingCalendar: deps.tradingCalendar ?? new ChineseTradingCalendar(),
    upstream: deps.upstream ?? new HttpUpstreamFetcher(),
  };
}

export type App = OpenAPIHono;

export function createApp(deps: AppDeps = {}): App {
  const resolved = resolveDeps(deps);
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(errorBody('validation_error', result.error.message), 400);
      }
      return undefined;
    },
  });

  app.openapi(healthRoute, async (c) => {
    const connected = resolved.db ? await resolved.db.ping() : false;
    if (!connected) {
      return c.json(errorBody('database_unavailable', '数据库不可用'), 503);
    }
    return c.json(
      {
        status: 'ok',
        database: { connected: true },
        time: resolved.clock.now().toISOString(),
      },
      200,
    );
  });

  const funds = createFundService({ upstream: resolved.upstream, clock: resolved.clock });
  const nav = createNavService({
    upstream: resolved.upstream,
    clock: resolved.clock,
    calendar: resolved.tradingCalendar,
  });
  const estimates = createEstimateService({
    upstream: resolved.upstream,
    clock: resolved.clock,
    calendar: resolved.tradingCalendar,
    nav,
  });
  const marketRateLimit = rateLimit(ANONYMOUS_MARKET_RATE_LIMIT, resolved.clock);
  app.use('/v1/funds/*', marketRateLimit);
  app.use('/v1/market/*', marketRateLimit);

  app.openapi(fundSearchRoute, async (c) => {
    const { q } = c.req.valid('query');
    return c.json({ items: await funds.search(q) }, 200);
  });

  // 先于 /v1/funds/{code} 注册，避免 "estimates" 被当成基金代码。
  app.openapi(estimateBatchRoute, async (c) => {
    const { codes } = c.req.valid('query');
    return c.json(await estimates.batch([...new Set(codes.split(','))]), 200);
  });

  app.openapi(fundDetailRoute, async (c) => {
    const { code } = c.req.valid('param');
    const fund = await funds.get(code);
    if (!fund) {
      return c.json(errorBody('fund_not_found', `没有代码为 ${code} 的基金`), 404);
    }
    return c.json(fund, 200);
  });

  app.openapi(latestNavRoute, async (c) => {
    const { code } = c.req.valid('param');
    const latest = await nav.latest(code);
    if (!latest) {
      return c.json(errorBody('fund_not_found', `没有代码为 ${code} 的基金净值数据`), 404);
    }
    return c.json(latest, 200);
  });

  app.openapi(navHistoryRoute, async (c) => {
    const { code } = c.req.valid('param');
    const { range } = c.req.valid('query');
    const points = await nav.history(code, range);
    if (points === null) {
      return c.json(errorBody('fund_not_found', `没有代码为 ${code} 的基金净值数据`), 404);
    }
    return c.json({ points }, 200);
  });

  app.openapi(marketStatusRoute, async (c) => {
    const now = resolved.clock.now();
    return c.json(
      { status: marketStatus(now, resolved.tradingCalendar), time: now.toISOString() },
      200,
    );
  });

  const auth: AuthService | null = resolved.database
    ? createAuthService({
        db: resolved.database,
        mailer: resolved.mailer,
        clock: resolved.clock,
      })
    : null;
  const requireLogin = auth ? requireAuth(auth) : null;

  app.use('/v1/auth/email/request', rateLimit(EMAIL_CODE_REQUEST_RATE_LIMIT, resolved.clock));
  app.use('/v1/auth/email/login', rateLimit(EMAIL_LOGIN_RATE_LIMIT, resolved.clock));

  app.openapi(emailCodeRequestRoute, async (c) => {
    if (!auth) return c.json(errorBody('database_unavailable', '数据库不可用'), 503);
    const { email } = c.req.valid('json');
    await auth.requestCode(email);
    return c.json({ retryAfterSeconds: EMAIL_CODE_COOLDOWN_MS / 1000 }, 200);
  });

  app.openapi(emailLoginRoute, async (c) => {
    if (!auth) return c.json(errorBody('database_unavailable', '数据库不可用'), 503);
    const { email, code, device } = c.req.valid('json');
    const result = await auth.loginWithEmail(email, code, device);
    if (device === 'web') {
      setCookie(c, SESSION_COOKIE, result.token, {
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        path: '/',
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
        expires: result.expiresAt,
      });
    }
    return c.json(
      {
        user: { id: result.userId },
        session: { device: result.device, expiresAt: result.expiresAt.toISOString() },
        token: device === 'miniprogram' ? result.token : null,
      },
      200,
    );
  });

  if (requireLogin) {
    app.use('/v1/auth/logout', requireLogin);
    app.use('/v1/me', requireLogin);
  }

  app.openapi(logoutRoute, async (c) => {
    if (!auth) return c.json(errorBody('database_unavailable', '数据库不可用'), 503);
    const { sessionId } = getAuth(c);
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
    await auth.logout(sessionId);
    return c.body(null, 204);
  });

  app.openapi(meRoute, async (c) => {
    if (!auth) return c.json(errorBody('database_unavailable', '数据库不可用'), 503);
    const { userId } = getAuth(c);
    const current = await auth.me(userId);
    return c.json(
      {
        user: { id: current.id },
        loginMethods: current.loginMethods,
        channels: current.channels,
      },
      200,
    );
  });

  app.notFound((c) => c.json(errorBody('not_found', `未找到 ${c.req.path}`), 404));

  app.onError((err, c) => {
    if (err instanceof UpstreamError) {
      console.warn('[bafang-core] upstream failure', err.kind, err.status ?? '', err.message);
      return c.json(errorBody('upstream_unavailable', '行情上游暂不可用，请稍后再试'), 502);
    }
    if (err instanceof AuthError) {
      return c.json(errorBody(err.code, err.message), err.status);
    }
    console.error('[bafang-core] unhandled error', err);
    return c.json(errorBody('internal_error', '内部错误'), 500);
  });

  app.doc('/v1/openapi', {
    openapi: '3.1.0',
    info: {
      title: 'bafang-core',
      version: '0.1.0',
      description:
        '八方来财后端：行情聚合、用户与登录方式、Agent、MCP。本 OpenAPI 文档由请求/响应 schema 自动生成。',
    },
  });

  return app;
}
