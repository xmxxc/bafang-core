import { createRoute, z } from '@hono/zod-openapi';
import { ErrorResponseSchema } from '../errors';
import { FundCodeSchema } from './funds';

const NavDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '净值日期为 YYYY-MM-DD')
  .openapi({ example: '2026-11-05', description: '净值日期（YYYY-MM-DD）' });

const NavAmountSchema = z
  .string()
  .regex(/^\d+(\.\d{1,4})?$/, '净值保留最多 4 位小数')
  .openapi({
    example: '1.0000',
    description: '净值，保留最多 4 位小数；用字符串表示以规避二进制浮点误差',
  });

const NavDailyChangeSchema = z.number().nullable().openapi({
  example: 1.83,
  description: '当日涨跌幅（百分比）；上游缺失或不可解析时为 null，表示无涨跌幅',
});

export const LatestNavSchema = z
  .object({
    navDate: NavDateSchema,
    unitNav: NavAmountSchema,
    cumulativeNav: NavAmountSchema.nullable().openapi({ description: '累计净值，缺失时为 null' }),
    dailyChange: NavDailyChangeSchema,
  })
  .openapi('LatestNav');

export const NavPointSchema = z
  .object({
    date: NavDateSchema,
    unitNav: NavAmountSchema,
    cumulativeNav: NavAmountSchema.nullable(),
    dailyChange: NavDailyChangeSchema,
  })
  .openapi('NavPoint');

export const NavHistoryResponseSchema = z
  .object({
    points: z.array(NavPointSchema),
  })
  .openapi('NavHistory');

export type LatestNavResponse = z.infer<typeof LatestNavSchema>;
export type NavHistoryResponse = z.infer<typeof NavHistoryResponseSchema>;

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

export const latestNavRoute = createRoute({
  method: 'get',
  path: '/v1/funds/{code}/nav',
  tags: ['market'],
  summary: '基金最新净值',
  description:
    '返回最新已公布的单位净值、净值日期与当日涨跌幅（含累计净值）。匿名可用并限流；结果缓存到当天净值公布窗口，窗口内当天净值尚未公布时按短间隔重新抓取。',
  request: {
    params: z.object({ code: FundCodeSchema }),
  },
  responses: {
    200: {
      description: '最新一期净值',
      content: { 'application/json': { schema: LatestNavSchema } },
    },
    404: { description: '没有这只基金的净值数据', content: errorContent },
    ...commonErrors,
  },
});

export const navHistoryRoute = createRoute({
  method: 'get',
  path: '/v1/funds/{code}/nav/history',
  tags: ['market'],
  summary: '基金历史净值走势',
  description: '按区间返回历史净值序列（最新在前）。匿名可用并限流；结果缓存到当天净值公布窗口。',
  request: {
    params: z.object({ code: FundCodeSchema }),
    query: z.object({
      range: z
        .enum(['1m', '3m', '1y'])
        .openapi({ example: '1m', description: '回看区间：1m 近 1 月、3m 近 3 月、1y 近 1 年' }),
    }),
  },
  responses: {
    200: {
      description: '历史净值序列，可能为空',
      content: { 'application/json': { schema: NavHistoryResponseSchema } },
    },
    404: { description: '没有这只基金的净值数据', content: errorContent },
    ...commonErrors,
  },
});
