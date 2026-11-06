import { createRoute, z } from '@hono/zod-openapi';
import { ErrorResponseSchema } from '../errors';
import { MarketStatusSchema } from './market-status';

const PointSchema = z
  .string()
  .regex(/^-?\d+\.\d{2}$/, '保留 2 位小数')
  .openapi({ example: '3649.18' });

export const MarketIndexSchema = z
  .object({
    code: z.enum(['000001.SH', '399001.SZ', '399006.SZ', 'HSI.HK']).openapi({
      description:
        '指数代码：000001.SH 上证指数、399001.SZ 深证成指、399006.SZ 创业板指、HSI.HK 恒生指数',
    }),
    name: z.string().openapi({ example: '上证指数' }),
    market: z.enum(['cn', 'hk']).openapi({
      description: '所属市场：cn A 股、hk 港股；两者的交易时段与休市日不同',
    }),
    marketStatus: MarketStatusSchema.shape.status.openapi({
      description:
        '该指数所属市场的状态：trading 交易中、closed 已收盘、holiday 休市、pre_market 盘前。A 股按交易日历判定；港股按交易时段与报价的交易日推断（工作日开市后仍无当日行情即为休市）',
    }),
    available: z.boolean().openapi({
      description: '是否取到了可信行情；为 false 时点位与涨跌均为 null（不以 0 表示）',
    }),
    point: PointSchema.nullable().openapi({
      description: '最新点位（非交易时段为收盘点位）；不可用时为 null',
    }),
    prevClose: PointSchema.nullable().openapi({ description: '昨收点位；不可用时为 null' }),
    change: PointSchema.nullable().openapi({
      example: '-40.73',
      description: '涨跌额 = 点位 − 昨收；不可用时为 null',
    }),
    changePercent: z.number().nullable().openapi({
      example: -1.1,
      description: '涨跌幅（百分比），保留 2 位小数；不可用时为 null',
    }),
    tradeDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .openapi({
        example: '2026-11-06',
        description: '行情所属交易日（YYYY-MM-DD）；不可用时为 null',
      }),
    quoteTime: z
      .string()
      .nullable()
      .openapi({ format: 'date-time', description: '行情时间；不可用时为 null' }),
    source: z.enum(['tencent', 'ths']).nullable().openapi({
      description: '行情来源：tencent 腾讯（主来源）、ths 同花顺（备用）；不可用时为 null',
    }),
    fallback: z.boolean().openapi({
      description: '是否发生了回退：主来源取不到或不可信时为 true（含两个来源都失败的情况）',
    }),
  })
  .openapi('MarketIndex');

export const MarketIndicesSchema = z
  .object({
    items: z.array(MarketIndexSchema).openapi({
      description: '固定四个指数，依次为上证指数、深证成指、创业板指、恒生指数',
    }),
    time: z.string().openapi({ format: 'date-time', description: '响应所依据的时间' }),
  })
  .openapi('MarketIndices');

export type MarketIndexResponse = z.infer<typeof MarketIndexSchema>;
export type MarketIndicesResponse = z.infer<typeof MarketIndicesSchema>;

const errorContent = { 'application/json': { schema: ErrorResponseSchema } };

export const marketIndicesRoute = createRoute({
  method: 'get',
  path: '/v1/market/indices',
  tags: ['market'],
  summary: '大盘指数',
  description:
    '返回上证指数、深证成指、创业板指、恒生指数的点位、涨跌额与涨跌幅，以及各自市场的状态。腾讯为主来源，单个指数取不到或不可信时回退到同花顺，都失败时该指数标为不可用（available=false，数值为 null），整体仍返回 200。非交易时段返回最近一个交易日的收盘数据。匿名可用并限流；交易时段缓存 10 秒，其余时段缓存数分钟。',
  responses: {
    200: {
      description: '四个指数的行情',
      content: { 'application/json': { schema: MarketIndicesSchema } },
    },
    429: {
      description:
        '匿名请求超过限流（每个客户端 IP 每分钟 60 次），响应头 Retry-After 给出等待秒数',
      content: errorContent,
    },
    500: { description: '内部错误', content: errorContent },
  },
});
