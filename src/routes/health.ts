import { createRoute, z } from '@hono/zod-openapi';
import { ErrorResponseSchema } from '../errors';

const UpstreamStatusSchema = z
  .object({
    lastSuccessAt: z.string().nullable().openapi({
      format: 'date-time',
      description:
        '本进程最近一次从该上游取到、通过全部校验并被采用的数据的时间；坏数据、合法空结果与缓存命中都不刷新。启动以来从未成功为 null。',
    }),
  })
  .openapi('UpstreamStatus');

export const HealthResponseSchema = z
  .object({
    status: z.literal('ok'),
    database: z.object({
      connected: z.boolean(),
    }),
    upstreams: z
      .object({
        eastmoney: UpstreamStatusSchema,
        tiantian: UpstreamStatusSchema,
        sina: UpstreamStatusSchema,
        tencent: UpstreamStatusSchema,
        ths: UpstreamStatusSchema,
      })
      .openapi({
        description:
          '各行情上游的最近成功时间（进程内记录，重启清空）：eastmoney 东方财富（搜索、基础信息、净值、重仓股名单、联接基金的相关 ETF），tiantian 天天基金估值，sina 新浪（估值、备用重仓股名单），tencent 腾讯行情（指数、重仓股、母 ETF），ths 同花顺行情（备用报价、分时）。交易所 ETF 名录（上交所、深交所）不在此列。',
      }),
    time: z.string().openapi({ format: 'date-time' }),
  })
  .openapi('Health');

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const healthRoute = createRoute({
  method: 'get',
  path: '/v1/health',
  tags: ['health'],
  summary: '健康检查',
  description: '返回服务存活状态、数据库连通性与各行情上游最近一次成功的时间。',
  responses: {
    200: {
      description: '服务存活，数据库可达',
      content: { 'application/json': { schema: HealthResponseSchema } },
    },
    500: {
      description: '内部错误',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    503: {
      description: '数据库不可达',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});
