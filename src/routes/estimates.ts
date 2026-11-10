import { createRoute, z } from '@hono/zod-openapi';
import { ErrorResponseSchema } from '../errors';
import { MarketStatusSchema } from './market-status';
import { FundCodeSchema } from './funds';

/** 一次批量估值最多的基金数。 */
export const MAX_ESTIMATE_CODES = 50;

const CalculationSchema = z
  .object({
    method: z.enum(['top_holdings', 'parent_etf']),
    reportDate: z.string().nullable(),
    disclosedWeightPercent: z.number().min(0).max(100),
    parentEtfCode: FundCodeSchema.nullable(),
    quoteTimeEnd: z.string().datetime().nullable(),
  })
  .describe(
    '参考模型：重仓股报告期与披露占净值比例，或已核实母ETF。未披露资产贡献按0建模，不代表真实收益为0；估值时间为最早参与报价，quoteTimeEnd为最晚参与报价。',
  );

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
    source: z.enum(['tiantian', 'sina', 'calculated']).openapi({
      description: '估值来源：tiantian 天天基金、sina 新浪财经、calculated 基于季报重仓股自算',
    }),
    sourceName: z.string().openapi({ example: '天天基金', description: '来源的展示名' }),
    fallback: z.boolean().openapi({
      description: '是否发生了回退：一级来源（天天基金）失败或没有估值，改用了后面的来源',
    }),
    calculation: CalculationSchema.optional(),
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
        'estimated 有已核实基准的估值；unavailable 来源、基准日期或交易日历覆盖无法核实（估值暂不可用）；pre_market 覆盖已知时的盘前；holiday 覆盖已知时的休市。均为显式枚举，不以 0 表示',
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
export const estimateIntradayRoute = createRoute({
  method: 'get',
  path: '/v1/funds/{code}/estimates/intraday',
  tags: ['market'],
  summary: '当日估值分时',
  description:
    '仅返回同日真实分时点推算的参考估值；盘前、休市、跨日或缺少成分点时为空，不插值补零。',
  request: { params: z.object({ code: FundCodeSchema }) },
  responses: {
    200: {
      description: '当日分时序列',
      content: {
        'application/json': {
          schema: z.object({
            code: FundCodeSchema,
            tradeDate: z.string(),
            status: z.enum(['estimated', 'unavailable', 'pre_market', 'holiday']),
            source: z.literal('calculated'),
            referenceOnly: z.literal(true),
            fallback: z.literal(true),
            calculation: CalculationSchema.nullable(),
            points: z.array(
              z.object({
                time: z.string().datetime(),
                changePercent: z.number(),
                value: z.string(),
              }),
            ),
            coverage: z
              .object({
                returnedPoints: z.number().int().min(0),
                omittedPoints: z.number().int().min(0),
              })
              .describe(
                '返回点数与因成分缺点而跳过的同日时间标签数；不是全天预期点数，不保证覆盖完整交易日',
              ),
          }),
        },
      },
    },
    400: {
      description: '参数不合法',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    429: { description: '限流', content: { 'application/json': { schema: ErrorResponseSchema } } },
    502: {
      description: '行情上游故障或协议损坏',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    500: {
      description: '内部错误',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

const errorContent = { 'application/json': { schema: ErrorResponseSchema } };

export const estimateBatchRoute = createRoute({
  method: 'get',
  path: '/v1/funds/estimates',
  tags: ['market'],
  summary: '批量估值',
  description: [
    '一次返回多只基金的估值涨跌、估值时间、来源与是否回退。',
    '来源按天天基金 → 新浪财经 → 自算的顺序回退；全部失败时该基金为 unavailable，不返回 0%。自算普通基金使用有效季报前十重仓股的可信当日行情，权重不归一化，属于部分持仓参考模型；ETF联接使用已核实母ETF的实时涨跌。',
    '估值基准的日期与单位净值必须匹配估值日期之前最近一期已公布净值，且日期必须是适用日历的上一个交易日。估值日或向前检索经过的年度覆盖未知、基金适用日历无法确定、基准日期缺失或净值无法核对时均为 unavailable。新浪当前没有基准日期，不采纳；QDII 尚无可靠境外日历映射，不采纳。',
    '估值日覆盖已知时，盘前与休市逐只返回 pre_market / holiday；交易日收盘后返回当天的收盘估值。',
    '交易时段结果缓存 30 秒；收盘估值缓存到下一个已覆盖交易日开盘，缓存命中仍重新核对基准。marketStatus 保持市场状态接口的兼容判断，覆盖未知时可能为 trading 而基金为 unavailable。匿名可用并限流。',
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
