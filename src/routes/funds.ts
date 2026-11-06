import { createRoute, z } from '@hono/zod-openapi';
import { ErrorResponseSchema } from '../errors';

const FundCodeSchema = z
  .string()
  .regex(/^\d{6}$/, '基金代码为 6 位数字')
  .openapi({ example: '000001', description: '6 位基金代码' });

const FundCategorySchema = z.enum(['domestic', 'qdii', 'etf_feeder']).openapi({
  description:
    '基金类别：domestic 境内、qdii QDII、etf_feeder ETF 联接（QDII 的 ETF 联接归为 qdii）',
});

export const FundSummarySchema = z
  .object({
    code: FundCodeSchema,
    name: z.string().openapi({ example: '华夏成长混合' }),
    category: FundCategorySchema,
    type: z
      .string()
      .nullable()
      .openapi({ description: '上游给出的基金类型，例如"混合型-灵活"', example: '混合型-灵活' }),
  })
  .openapi('FundSummary');

export const FundSearchResponseSchema = z
  .object({
    items: z.array(FundSummarySchema),
  })
  .openapi('FundSearchResult');

export const FundDetailSchema = FundSummarySchema.extend({
  settlement: z
    .object({
      tPlusN: z
        .number()
        .int()
        .nonnegative()
        .openapi({ description: '买入确认 T+N 的 N', example: 1 }),
      source: z.enum(['upstream', 'category_default']).openapi({
        description:
          'upstream：取自上游；category_default：上游缺失，按类别默认（境内与 ETF 联接 T+1，QDII T+2）',
      }),
    })
    .openapi({ description: 'T+N 确认规则' }),
}).openapi('FundDetail');

export type FundSearchResponse = z.infer<typeof FundSearchResponseSchema>;
export type FundDetailResponse = z.infer<typeof FundDetailSchema>;

const errorContent = { 'application/json': { schema: ErrorResponseSchema } };

const commonErrors = {
  400: { description: '参数不合法', content: errorContent },
  429: {
    description: '匿名请求超过限流（每个客户端 IP 每分钟 60 次），响应头 Retry-After 给出等待秒数',
    content: errorContent,
  },
  500: { description: '内部错误', content: errorContent },
  502: { description: '行情上游暂不可用', content: errorContent },
} as const;

export const fundSearchRoute = createRoute({
  method: 'get',
  path: '/v1/funds/search',
  tags: ['market'],
  summary: '基金搜索',
  description:
    '按基金代码、名称或拼音首字母搜索基金。匿名可用并限流；结果按 Asia/Shanghai 日期缓存一天。',
  request: {
    query: z.object({
      q: z
        .string()
        .trim()
        .min(1, '搜索词不能为空')
        .max(50, '搜索词最长 50 个字符')
        .openapi({ description: '基金代码、名称或拼音首字母', example: 'hxcz' }),
    }),
  },
  responses: {
    200: {
      description: '匹配的基金列表，可能为空',
      content: { 'application/json': { schema: FundSearchResponseSchema } },
    },
    ...commonErrors,
  },
});

export const fundDetailRoute = createRoute({
  method: 'get',
  path: '/v1/funds/{code}',
  tags: ['market'],
  summary: '基金基础信息',
  description: '返回名称、代码、类别与 T+N 确认规则。匿名可用并限流。',
  request: {
    params: z.object({ code: FundCodeSchema }),
  },
  responses: {
    200: {
      description: '基金基础信息',
      content: { 'application/json': { schema: FundDetailSchema } },
    },
    404: { description: '没有这只基金', content: errorContent },
    ...commonErrors,
  },
});
