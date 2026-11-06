import { createRoute, z } from '@hono/zod-openapi';
import { ErrorResponseSchema } from '../errors';

export const MarketStatusSchema = z
  .object({
    status: z.enum(['trading', 'closed', 'holiday', 'pre_market']).openapi({
      description:
        '市场状态：trading 交易中、closed 已收盘、holiday 休市、pre_market 盘前。均为显式枚举，不以 0 表示',
    }),
    time: z.string().openapi({ format: 'date-time', description: '判定所依据的时间' }),
  })
  .openapi('MarketStatus');

export type MarketStatusResponse = z.infer<typeof MarketStatusSchema>;

export const marketStatusRoute = createRoute({
  method: 'get',
  path: '/v1/market/status',
  tags: ['market'],
  summary: '市场状态',
  description:
    '返回当前市场处于交易中、已收盘、休市或盘前。按注入的时钟与交易日历判定；匿名可用并限流。',
  responses: {
    200: {
      description: '市场状态',
      content: { 'application/json': { schema: MarketStatusSchema } },
    },
    429: {
      description:
        '匿名请求超过限流（每个客户端 IP 每分钟 60 次），响应头 Retry-After 给出等待秒数',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    500: {
      description: '内部错误',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});
