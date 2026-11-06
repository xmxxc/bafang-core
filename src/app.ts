import { OpenAPIHono } from '@hono/zod-openapi';
import { SystemClock, type Clock } from './clock';
import { ChineseTradingCalendar, type TradingCalendar } from './trading-calendar';
import type { HealthProbe } from './db';
import { errorBody } from './errors';
import { healthRoute } from './routes/health';
import { fundDetailRoute, fundSearchRoute } from './routes/funds';
import { latestNavRoute, navHistoryRoute } from './routes/nav';
import { marketStatusRoute } from './routes/market-status';
import { createFundService } from './market/funds';
import { createNavService } from './market/nav';
import { marketStatus } from './market/status';
import { HttpUpstreamFetcher, UpstreamError, type UpstreamFetcher } from './market/upstream';
import { ANONYMOUS_MARKET_RATE_LIMIT, rateLimit } from './rate-limit';

export interface AppDeps {
  db?: HealthProbe;
  clock?: Clock;
  tradingCalendar?: TradingCalendar;
  /** 统一上游抓取适配器；测试时整体替换为录制样本。 */
  upstream?: UpstreamFetcher;
}

export interface ResolvedDeps {
  db: HealthProbe | undefined;
  clock: Clock;
  tradingCalendar: TradingCalendar;
  upstream: UpstreamFetcher;
}

export function resolveDeps(deps: AppDeps = {}): ResolvedDeps {
  return {
    db: deps.db,
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
  const nav = createNavService({ upstream: resolved.upstream, clock: resolved.clock });
  const marketRateLimit = rateLimit(ANONYMOUS_MARKET_RATE_LIMIT, resolved.clock);
  app.use('/v1/funds/*', marketRateLimit);
  app.use('/v1/market/*', marketRateLimit);

  app.openapi(fundSearchRoute, async (c) => {
    const { q } = c.req.valid('query');
    return c.json({ items: await funds.search(q) }, 200);
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

  app.notFound((c) => c.json(errorBody('not_found', `未找到 ${c.req.path}`), 404));

  app.onError((err, c) => {
    if (err instanceof UpstreamError) {
      console.warn('[bafang-core] upstream failure', err.kind, err.status ?? '', err.message);
      return c.json(errorBody('upstream_unavailable', '行情上游暂不可用，请稍后再试'), 502);
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
