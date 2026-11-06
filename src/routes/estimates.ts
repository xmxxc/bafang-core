import { createRoute, z } from '@hono/zod-openapi';
import { ErrorResponseSchema } from '../errors';
import { MarketStatusSchema } from './market-status';
import { FundCodeSchema } from './funds';

/** 一次批量估值最多的基金数。 */
export const MAX_ESTIMATE_CODES = 50;

const EstimateSchema = z
  .object({
    changePercent: z.number().openapi({
      example: -1.44,
      description:
        '估值涨跌幅（百分比）。只有确实取到估值时才出现；取不到时整条估值为 null，不以 0 表示',
    }),
    value: z
      .string()
      .regex(/^\d+(\.\d{1,4})?$/)
      .openapi({
        example: '1.6785',
        description:
          '按估值推算的单位水平，保留 4 位小数；非官方净值，用字符串表示以规避二进制浮点误差',
      }),
    time: z.string().openapi({ format: 'date-time', description: '来源给出的估值时间' }),
    source: z.enum(['tiantian', 'sina']).openapi({
      description: '估值来源：tiantian 天天基金（一级）、sina 新浪财经（二级）',
    }),
    sourceName: z.string().openapi({ example: '天天基金', description: '来源的展示名' }),
    fallback: z.boolean().openapi({
      description: '是否发生了回退：一级来源（天天基金）失败或没有估值，改用了后面的来源',
    }),
    referenceOnly: z.literal(true).openapi({
      description: '估值非官方数据，仅供参考；前端应据此展示提示',
    }),
  })
  .openapi('Estimate');

const EstimateItemSchema = z
  .object({
    code: FundCodeSchema,
    status: z.enum(['estimated', 'unavailable', 'pre_market', 'holiday']).openapi({
      description:
        'estimated 有估值；unavailable 所有来源都失败或没有当天估值（估值暂不可用）；pre_market 盘前；holiday 休市。均为显式枚举，不以 0 表示',
    }),
    estimate: EstimateSchema.nullable().openapi({
      description: '状态为 estimated 时给出；unavailable、pre_market、holiday 时为 null',
    }),
  })
  .openapi('EstimateItem');

export const EstimateBatchSchema = z
  .object({
    marketStatus: MarketStatusSchema.shape.status,
    time: z.string().openapi({ format: 'date-time', description: '判定所依据的时间' }),
    items: z.array(EstimateItemSchema).openapi({ description: '按请求顺序（去重后）逐只给出' }),
  })
  .openapi('EstimateBatch');

export type EstimateBatchResponse = z.infer<typeof EstimateBatchSchema>;

const errorContent = { 'application/json': { schema: ErrorResponseSchema } };

export const estimateBatchRoute = createRoute({
  method: 'get',
  path: '/v1/funds/estimates',
  tags: ['market'],
  summary: '批量估值',
  description: [
    '一次返回多只基金的估值涨跌、估值时间、来源与是否回退。',
    '来源按天天基金 → 新浪财经的顺序回退；全部失败时该基金为 unavailable，不返回 0%。',
    '估值的基准净值必须是最近一期已公布净值，否则视为过期估值、按无估值处理（例如 QDII 净值晚到时）；净值暂时取不到时照常返回估值并只短缓存。',
    '盘前与休市不提供估值，逐只返回 pre_market / holiday；交易日收盘后返回当天的收盘估值。',
    '交易时段结果缓存 30 秒；收盘估值缓存到下一个交易日开盘。匿名可用并限流。',
  ].join(''),
  request: {
    query: z.object({
      codes: z
        .string()
        .regex(
          new RegExp(`^\\d{6}(,\\d{6}){0,${MAX_ESTIMATE_CODES - 1}}$`),
          `codes 为逗号分隔的 6 位基金代码，1–${MAX_ESTIMATE_CODES} 个`,
        )
        .openapi({
          example: '000001,110020',
          description: `逗号分隔的 6 位基金代码，1–${MAX_ESTIMATE_CODES} 个；重复的代码只返回一次`,
        }),
    }),
  },
  responses: {
    200: {
      description: '逐只基金的估值或显式状态',
      content: { 'application/json': { schema: EstimateBatchSchema } },
    },
    400: { description: '参数不合法', content: errorContent },
    429: {
      description:
        '匿名请求超过限流（每个客户端 IP 每分钟 60 次），响应头 Retry-After 给出等待秒数',
      content: errorContent,
    },
    500: { description: '内部错误', content: errorContent },
  },
});
