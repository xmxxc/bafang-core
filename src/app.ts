import { OpenAPIHono } from '@hono/zod-openapi';
import { SystemClock, type Clock } from './clock';
import { ChineseTradingCalendar, type TradingCalendar } from './trading-calendar';
import type { HealthProbe } from './db';
import { errorBody } from './errors';
import { healthRoute } from './routes/health';

export interface AppDeps {
  db?: HealthProbe;
  clock?: Clock;
  tradingCalendar?: TradingCalendar;
}

export interface ResolvedDeps {
  db: HealthProbe | undefined;
  clock: Clock;
  tradingCalendar: TradingCalendar;
}

export function resolveDeps(deps: AppDeps = {}): ResolvedDeps {
  return {
    db: deps.db,
    clock: deps.clock ?? new SystemClock(),
    tradingCalendar: deps.tradingCalendar ?? new ChineseTradingCalendar(),
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

  app.notFound((c) => c.json(errorBody('not_found', `未找到 ${c.req.path}`), 404));

  app.doc('/openapi', {
    openapi: '3.1.0',
    info: {
      title: 'bafang-core',
      version: '0.1.0',
      description:
        '八方来财后端：行情聚合、账号与同步、Agent、MCP。本 OpenAPI 文档由请求/响应 schema 自动生成。',
    },
  });

  return app;
}
