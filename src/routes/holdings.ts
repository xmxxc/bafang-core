import { createRoute, z } from '@hono/zod-openapi';
import { ErrorResponseSchema } from '../errors';
import { FundCodeSchema } from './funds';
const Point = z
  .string()
  .regex(/^-?\d+\.\d{2}$/)
  .nullable();
const Holding = z
  .object({
    name: z.string(),
    code: z
      .string()
      .regex(/^(?!0+$)[A-Za-z0-9][A-Za-z0-9.-]*$/)
      .describe('上游股票标识；格式不代表市场真实性，无法可靠映射时 quote 为 null'),
    weight: z.number().min(0).max(100),
    reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    quote: z
      .object({
        price: Point,
        prevClose: Point,
        change: Point,
        changePercent: z.number().nullable(),
        tradeDate: z.string().nullable(),
        quoteTime: z.string().nullable(),
      })
      .nullable(),
    quoteSource: z.enum(['tencent', 'ths']).nullable(),
    quoteFallback: z.boolean(),
  })
  .openapi('FundTopHolding');
export const fundHoldingsRoute = createRoute({
  method: 'get',
  path: '/v1/funds/{code}/holdings',
  tags: ['market'],
  summary: '基金前十大重仓股',
  request: { params: z.object({ code: FundCodeSchema }) },
  responses: {
    400: {
      description: '参数不合法',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    200: {
      description: '最新季报前十大重仓股',
      content: {
        'application/json': {
          schema: z
            .object({ reportDate: z.string(), items: z.array(Holding) })
            .openapi('FundHoldings'),
        },
      },
    },
    404: {
      description: '上游成功确认无股票季报（空内容及空报告年份列表）',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    429: { description: '限流', content: { 'application/json': { schema: ErrorResponseSchema } } },
    502: {
      description: '上游不可用',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});
