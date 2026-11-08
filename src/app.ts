import { OpenAPIHono } from '@hono/zod-openapi';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { shanghaiDate, SystemClock, type Clock } from './clock';
import {
  ChineseTradingCalendar,
  HongKongTradingCalendar,
  type SessionCalendar,
  type TradingCalendar,
} from './trading-calendar';
import { type Db, type HealthProbe } from './db';
import { errorBody } from './errors';
import { healthRoute } from './routes/health';
import { fundDetailRoute, fundSearchRoute } from './routes/funds';
import { estimateBatchRoute } from './routes/estimates';
import { latestNavRoute, navHistoryRoute } from './routes/nav';
import { marketStatusRoute } from './routes/market-status';
import { marketIndicesRoute } from './routes/market-indices';
import {
  emailCodeRequestRoute,
  emailLoginRoute,
  logoutRoute,
  meRoute,
  githubStartRoute,
  githubCallbackRoute,
  wechatLoginRoute,
  loginMethodsRoute,
  emailLinkRequestRoute,
  emailLinkRoute,
  loginMethodDeleteRoute,
  bindCodeGenerateRoute,
  wechatBindCodeRoute,
} from './routes/auth';
import { createFundService } from './market/funds';
import { createNavService } from './market/nav';
import { createEstimateService } from './market/estimates';
import { marketStatus } from './market/status';
import { createIndexService } from './market/indices';
import { HttpUpstreamFetcher, UpstreamError, type UpstreamFetcher } from './market/upstream';
import {
  ANONYMOUS_MARKET_RATE_LIMIT,
  EMAIL_CODE_REQUEST_RATE_LIMIT,
  EMAIL_LOGIN_RATE_LIMIT,
  GITHUB_LOGIN_RATE_LIMIT,
  WECHAT_LOGIN_RATE_LIMIT,
  BIND_CODE_GENERATE_RATE_LIMIT,
  BIND_CODE_SUBMIT_RATE_LIMIT,
  rateLimit,
} from './rate-limit';
import { setSessionCookie } from './auth/cookie';
import type { GitHubLogin } from './auth/github';
import { WeChatCodeInvalidError, type WeChatCode2Session } from './auth/wechat';
import {
  createGitHubLoginService,
  GITHUB_BROWSER_COOKIE,
  GITHUB_STATE_TTL_MS,
} from './auth/github-login';
import { MissingMailer, type Mailer } from './auth/mailer';
import {
  AuthError,
  createAuthService,
  EMAIL_CODE_COOLDOWN_MS,
  type AuthService,
  type SessionInfo,
  type UserPositionsChecker,
} from './auth/service';
import { extractSessionToken, getAuth, requireAuth, SESSION_COOKIE } from './auth/middleware';
import { ChannelError, createChannelService } from './channels/service';
import {
  channelCreateRoute,
  channelDeleteRoute,
  channelListRoute,
  channelOrderRoute,
  channelRenameRoute,
} from './routes/channels';
import {
  positionCalibrateRoute,
  positionCreateRoute,
  positionDeleteRoute,
  positionDetailRoute,
  positionListRoute,
  positionSummaryRoute,
  positionByFundRoute,
} from './routes/positions';
import { PositionError, createPositionService } from './positions/service';
import { summarizePositions, summarizeByFund } from './positions/summary';

import { createTradeService } from './positions/trades';
import { tradeCreateRoute, tradeListRoute, tradeCancelRoute } from './routes/trades';
import {
  createSettlementJob,
  type SettlementJob,
  type SettlementSummary,
} from './positions/settlement';

export interface AppDeps {
  db?: HealthProbe;
  /** 身份与登录模块使用的数据库；测试连接真实 PostgreSQL 测试库时传入。 */
  database?: Db;
  /** 持仓判断入口；#16 接入真实持仓表前默认返回 false，测试可替换。 */
  hasUserPositions?: UserPositionsChecker;
  /** 发信适配器；测试时替换为假发信。 */
  mailer?: Mailer;
  /** GitHub OAuth 适配器与固定的登录后跳转配置。 */
  github?: GitHubLogin;
  /** 微信 code2session 适配器；测试时替换为假实现。 */
  wechat?: WeChatCode2Session;
  /** 绑定码 HMAC 密钥；生产环境应显式配置。 */
  bindCodeSecret?: string;
  clock?: Clock;
  tradingCalendar?: TradingCalendar;
  /** 港股交易日历（含半日市）；省略时只按周末判定。 */
  hkTradingCalendar?: SessionCalendar;
  /** 统一上游抓取适配器；测试时整体替换为录制样本。 */
  upstream?: UpstreamFetcher;
}

export interface ResolvedDeps {
  db: HealthProbe | undefined;
  database: Db | undefined;
  mailer: Mailer;
  github: GitHubLogin | undefined;
  wechat: WeChatCode2Session | undefined;
  bindCodeSecret: string;
  clock: Clock;
  tradingCalendar: TradingCalendar;
  hkTradingCalendar: SessionCalendar;
  upstream: UpstreamFetcher;
}

export function resolveDeps(deps: AppDeps = {}): ResolvedDeps {
  return {
    db: deps.db,
    database: deps.database,
    github: deps.github,
    wechat: deps.wechat,
    bindCodeSecret:
      deps.bindCodeSecret?.trim() ||
      process.env.BIND_CODE_SECRET?.trim() ||
      'bafang-core-development-bind-code-key',
    mailer: deps.mailer ?? new MissingMailer(),
    clock: deps.clock ?? new SystemClock(),
    tradingCalendar: deps.tradingCalendar ?? new ChineseTradingCalendar(),
    hkTradingCalendar: deps.hkTradingCalendar ?? new HongKongTradingCalendar(),
    upstream: deps.upstream ?? new HttpUpstreamFetcher(),
  };
}

export type App = OpenAPIHono & {
  /** 进程内手动补跑交易确认；测试和 CLI 复用同一入口。 */
  settlementJob: SettlementJob | null;
  runSettlement(): Promise<SettlementSummary>;
};

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
  app.openAPIRegistry.registerComponent('securitySchemes', 'SessionCookie', {
    type: 'apiKey',
    in: 'cookie',
    name: SESSION_COOKIE,
  });
  app.openAPIRegistry.registerComponent('securitySchemes', 'SessionBearer', {
    type: 'http',
    scheme: 'bearer',
    description: '小程序会话令牌',
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
  const positions = resolved.database
    ? createPositionService({
        db: resolved.database,
        funds,
        nav,
        estimates,
        clock: resolved.clock,
        calendar: resolved.tradingCalendar,
      })
    : null;
  const trades = resolved.database
    ? createTradeService({
        db: resolved.database,
        funds,
        clock: resolved.clock,
        calendar: resolved.tradingCalendar,
      })
    : null;
  const settlementJob = resolved.database
    ? createSettlementJob({ db: resolved.database, nav, clock: resolved.clock })
    : null;
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

  const indices = createIndexService({
    upstream: resolved.upstream,
    clock: resolved.clock,
    calendar: resolved.tradingCalendar,
    hkCalendar: resolved.hkTradingCalendar,
  });
  app.openapi(marketIndicesRoute, async (c) => {
    const items = await indices.list();
    return c.json({ items, time: resolved.clock.now().toISOString() }, 200);
  });

  const auth: AuthService | null = resolved.database
    ? createAuthService({
        db: resolved.database,
        mailer: resolved.mailer,
        clock: resolved.clock,
        hasPositions: deps.hasUserPositions,
        bindCodeSecret: resolved.bindCodeSecret,
      })
    : null;
  const requireLogin = auth ? requireAuth(auth) : null;

  const channels = resolved.database ? createChannelService(resolved.database) : null;
  app.use('/v1/channels/*', async (c, next) => {
    if (!requireLogin) return c.json(errorBody('database_unavailable', '数据库不可用'), 503);
    return requireLogin(c, next);
  });
  app.openapi(channelListRoute, async (c) => {
    if (!channels) return c.json(errorBody('database_unavailable', '数据库不可用'), 503);
    return c.json({ items: await channels.list(getAuth(c).userId) }, 200);
  });
  app.openapi(channelCreateRoute, async (c) => {
    if (!channels) return c.json(errorBody('database_unavailable', '数据库不可用'), 503);
    return c.json(await channels.create(getAuth(c).userId, c.req.valid('json').name), 201);
  });
  app.openapi(channelOrderRoute, async (c) => {
    if (!channels) return c.json(errorBody('database_unavailable', '数据库不可用'), 503);
    return c.json(
      { items: await channels.reorder(getAuth(c).userId, c.req.valid('json').channelIds) },
      200,
    );
  });
  app.openapi(channelRenameRoute, async (c) => {
    if (!channels) return c.json(errorBody('database_unavailable', '数据库不可用'), 503);
    return c.json(
      await channels.rename(getAuth(c).userId, c.req.valid('param').id, c.req.valid('json').name),
      200,
    );
  });
  app.openapi(channelDeleteRoute, async (c) => {
    if (!channels) return c.json(errorBody('database_unavailable', '数据库不可用'), 503);
    await channels.delete(getAuth(c).userId, c.req.valid('param').id);
    return c.body(null, 204);
  });

  app.use('/v1/positions/*', async (c, next) => {
    if (!requireLogin) return c.json(errorBody('database_unavailable', '数据库不可用'), 503);
    return requireLogin(c, next);
  });
  app.openapi(positionListRoute, async (c) => {
    if (!positions) return c.json(errorBody('database_unavailable', '数据库不可用'), 503);
    const { channelId, includeCleared } = c.req.valid('query');
    return c.json(
      { items: await positions.list(getAuth(c).userId, channelId, includeCleared === 'true') },
      200,
    );
  });
  // 固定路径先于 /{id} 注册，避免被当成持仓 UUID。
  app.openapi(positionSummaryRoute, async (c) => {
    if (!positions) return c.json(errorBody('database_unavailable', '数据库不可用'), 503);
    const items = await positions.list(getAuth(c).userId, c.req.valid('query').channelId, true);
    return c.json(summarizePositions(items, shanghaiDate(resolved.clock.now())), 200);
  });
  app.openapi(positionByFundRoute, async (c) => {
    if (!positions) return c.json(errorBody('database_unavailable', '数据库不可用'), 503);
    const items = await positions.list(getAuth(c).userId, c.req.valid('query').channelId, true);
    return c.json({ items: summarizeByFund(items, shanghaiDate(resolved.clock.now())) }, 200);
  });
  app.openapi(positionDetailRoute, async (c) => {
    if (!positions) return c.json(errorBody('database_unavailable', '数据库不可用'), 503);
    return c.json(await positions.get(getAuth(c).userId, c.req.valid('param').id), 200);
  });
  app.openapi(positionCreateRoute, async (c) => {
    if (!positions) return c.json(errorBody('database_unavailable', '数据库不可用'), 503);
    return c.json(await positions.create(getAuth(c).userId, c.req.valid('json')), 201);
  });
  app.openapi(positionCalibrateRoute, async (c) => {
    if (!positions) return c.json(errorBody('database_unavailable', '数据库不可用'), 503);
    return c.json(
      await positions.calibrate(getAuth(c).userId, c.req.valid('param').id, c.req.valid('json')),
      200,
    );
  });
  app.openapi(positionDeleteRoute, async (c) => {
    if (!positions) return c.json(errorBody('database_unavailable', '数据库不可用'), 503);
    await positions.delete(getAuth(c).userId, c.req.valid('param').id);
    return c.body(null, 204);
  });

  app.openapi(tradeCreateRoute, async (c) => {
    if (!trades) return c.json(errorBody('database_unavailable', '数据库不可用'), 503);
    return c.json(
      await trades.create(getAuth(c).userId, c.req.valid('param').id, c.req.valid('json')),
      201,
    );
  });
  app.openapi(tradeListRoute, async (c) => {
    if (!trades) return c.json(errorBody('database_unavailable', '数据库不可用'), 503);
    return c.json({ items: await trades.list(getAuth(c).userId, c.req.valid('param').id) }, 200);
  });
  app.openapi(tradeCancelRoute, async (c) => {
    if (!trades) return c.json(errorBody('database_unavailable', '数据库不可用'), 503);
    const { id, tradeId } = c.req.valid('param');
    await trades.cancel(getAuth(c).userId, id, tradeId);
    return c.body(null, 204);
  });

  app.use('/v1/auth/email/request', rateLimit(EMAIL_CODE_REQUEST_RATE_LIMIT, resolved.clock));
  app.use('/v1/auth/email/login', rateLimit(EMAIL_LOGIN_RATE_LIMIT, resolved.clock));
  app.use('/v1/auth/email/link/request', rateLimit(EMAIL_CODE_REQUEST_RATE_LIMIT, resolved.clock));
  app.use('/v1/auth/email/link', rateLimit(EMAIL_LOGIN_RATE_LIMIT, resolved.clock));

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
      setSessionCookie(c, result.token, result.expiresAt);
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
    app.use('/v1/auth/email/link/request', requireLogin);
    app.use('/v1/auth/email/link', requireLogin);
  }
  app.openapi(emailLinkRequestRoute, async (c) => {
    if (!auth) return c.json(errorBody('database_unavailable', '数据库不可用'), 503);
    const { email } = (await c.req.json()) as { email: string };
    await auth.requestCode(email, 'link');
    return c.json({ retryAfterSeconds: EMAIL_CODE_COOLDOWN_MS / 1000 }, 200);
  });
  app.openapi(emailLinkRoute, async (c) => {
    if (!auth) return c.json(errorBody('database_unavailable', '数据库不可用'), 503);
    const { email, code } = (await c.req.json()) as { email: string; code: string };
    const linked = await auth.associateEmail(getAuth(c).userId, email, code);
    return c.json({ type: linked.type, externalId: linked.externalId }, 200);
  });

  app.use('/v1/auth/wechat/login', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.use('/v1/auth/wechat/bind', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.use('/v1/auth/bind-code', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.use('/v1/auth/wechat/login', rateLimit(WECHAT_LOGIN_RATE_LIMIT, resolved.clock));
  app.use('/v1/auth/bind-code', rateLimit(BIND_CODE_GENERATE_RATE_LIMIT, resolved.clock));
  app.use('/v1/auth/wechat/bind', rateLimit(BIND_CODE_SUBMIT_RATE_LIMIT, resolved.clock));
  app.openapi(wechatLoginRoute, async (c) => {
    if (!resolved.wechat) return c.json(errorBody('wechat_not_configured', '微信登录未配置'), 503);
    if (!auth) return c.json(errorBody('database_unavailable', '数据库不可用'), 503);
    const { code } = c.req.valid('json');
    let openid: string;
    try {
      openid = await resolved.wechat.openid(code);
    } catch (error) {
      // 不传播微信响应、请求 URL、code、AppSecret 或 session_key。
      if (error instanceof WeChatCodeInvalidError)
        throw new AuthError('wechat_code_invalid', '微信登录凭据无效，请重新登录', 400);
      throw new AuthError('wechat_unavailable', '微信登录暂不可用，请稍后重试', 502);
    }
    const result = await auth.loginWithWeChatOpenId(openid);
    return c.json(
      {
        user: { id: result.userId },
        session: { device: 'miniprogram' as const, expiresAt: result.expiresAt.toISOString() },
        token: result.token,
      },
      200,
    );
  });

  if (requireLogin) app.use('/v1/auth/bind-code', requireLogin);
  app.openapi(bindCodeGenerateRoute, async (c) => {
    if (!auth) return c.json(errorBody('database_unavailable', '数据库不可用'), 503);
    if (getAuth(c).device !== 'web') {
      return c.json(errorBody('bind_code_web_required', '生成绑定码需要网页会话'), 403);
    }
    const result = await auth.generateBindCode(getAuth(c).userId);
    return c.json({ code: result.code, expiresAt: result.expiresAt.toISOString() }, 201);
  });

  app.openapi(wechatBindCodeRoute, async (c) => {
    if (!resolved.wechat) return c.json(errorBody('wechat_not_configured', '微信登录未配置'), 503);
    if (!auth) return c.json(errorBody('database_unavailable', '数据库不可用'), 503);
    const body = c.req.valid('json');
    let openid: string;
    try {
      openid = await resolved.wechat.openid(body.code ?? body.wechatCode!);
    } catch (error) {
      if (error instanceof WeChatCodeInvalidError)
        throw new AuthError('wechat_code_invalid', '微信登录凭据无效，请重新登录', 400);
      throw new AuthError('wechat_unavailable', '微信登录暂不可用，请稍后重试', 502);
    }
    const result = await auth.bindWeChatCode(body.bindCode, openid);
    return c.json(
      {
        user: { id: result.userId },
        session: { device: 'miniprogram' as const, expiresAt: result.expiresAt.toISOString() },
        token: result.token,
      },
      200,
    );
  });

  const github =
    resolved.github && resolved.database && auth
      ? createGitHubLoginService({
          db: resolved.database,
          clock: resolved.clock,
          oauth: resolved.github.oauth,
          auth,
        })
      : null;
  app.use('/v1/auth/github*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    await next();
  });
  app.use('/v1/auth/github', rateLimit(GITHUB_LOGIN_RATE_LIMIT, resolved.clock));
  app.use('/v1/auth/github/callback', rateLimit(GITHUB_LOGIN_RATE_LIMIT, resolved.clock));
  app.openapi(githubStartRoute, async (c) => {
    if (!resolved.github)
      return c.json(errorBody('github_not_configured', 'GitHub 登录未配置'), 503);
    if (!github || !auth) return c.json(errorBody('database_unavailable', '数据库不可用'), 503);
    const { intent } = c.req.valid('query');
    let session: SessionInfo | null = null;
    if (intent === 'link') {
      const token = extractSessionToken(c);
      session = token ? await auth.authenticate(token) : null;
      if (!session) return c.json(errorBody('unauthorized', '关联登录方式需要先登录'), 401);
    }
    const result = await github.start(intent, session ?? undefined);
    setCookie(c, GITHUB_BROWSER_COOKIE, result.browser, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: GITHUB_STATE_TTL_MS / 1000,
    });
    return c.redirect(result.url, 302);
  });
  app.openapi(githubCallbackRoute, async (c) => {
    if (!resolved.github)
      return c.json(errorBody('github_not_configured', 'GitHub 登录未配置'), 503);
    if (!github || !auth) return c.json(errorBody('database_unavailable', '数据库不可用'), 503);
    const { state, code, error } = c.req.valid('query');
    const browser = getCookie(c, GITHUB_BROWSER_COOKIE);
    deleteCookie(c, GITHUB_BROWSER_COOKIE, { path: '/', secure: true });
    const token = extractSessionToken(c);
    const session = token ? await auth.authenticate(token) : null;
    const result = await github.callback(state, browser, code, error, session);
    if (result.kind === 'login') setSessionCookie(c, result.token, result.expiresAt);
    return c.redirect(resolved.github.redirectUrl, 302);
  });

  if (requireLogin) {
    app.use('/v1/auth/logout', requireLogin);
    app.use('/v1/me', requireLogin);
    app.use('/v1/me/login-methods', requireLogin);
    app.use('/v1/me/login-methods/*', requireLogin);
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

  app.openapi(loginMethodsRoute, async (c) => {
    if (!auth) return c.json(errorBody('database_unavailable', '数据库不可用'), 503);
    return c.json({ items: await auth.listLoginMethods(getAuth(c).userId) }, 200);
  });

  app.openapi(loginMethodDeleteRoute, async (c) => {
    if (!auth) return c.json(errorBody('database_unavailable', '数据库不可用'), 503);
    const type = c.req.param('type') as 'email' | 'github' | 'wechat';
    await auth.unlinkLoginMethod(getAuth(c).userId, type);
    return c.body(null, 204);
  });

  app.notFound((c) => c.json(errorBody('not_found', `未找到 ${c.req.path}`), 404));

  app.onError((err, c) => {
    if (err instanceof HTTPException && (err.status === 400 || err.status === 415)) {
      return c.json(errorBody('validation_error', '请求格式不合法'), 400);
    }
    if (err instanceof UpstreamError) {
      console.warn('[bafang-core] upstream failure', err.kind, err.status ?? '', err.message);
      return c.json(errorBody('upstream_unavailable', '行情上游暂不可用，请稍后再试'), 502);
    }
    if (err instanceof AuthError || err instanceof ChannelError || err instanceof PositionError) {
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

  const runtime = app as App;
  runtime.settlementJob = settlementJob;
  runtime.runSettlement = () =>
    settlementJob?.run() ?? Promise.resolve({ confirmed: 0, pending: 0, failed: 0, failures: [] });
  return runtime;
}
