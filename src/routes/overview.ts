import { createRoute, z } from '@hono/zod-openapi';
import { ErrorResponseSchema } from '../errors';
import { MarketIndicesSchema } from './market-indices';
import { PositionSchema, SummarySchema } from './positions';

export const OverviewQuoteSchema = z
  .object({
    type: z.enum(['estimate', 'nav', 'unavailable']).openapi({
      description: '今日收益所用行情：估值 / 当日净值 / 不可用；不沿用上一交易日涨跌',
    }),
    direction: z.enum(['up', 'down', 'flat']).nullable().openapi({
      description: '按未舍入的行情判断上涨 / 下跌 / 平盘，不受展示百分数舍入影响；不可用为 null',
    }),
    value: z
      .string()
      .nullable()
      .openapi({ description: '估值或单位净值，4 位小数；不可用为 null' }),
    changePercent: z.number().nullable().openapi({
      description: '涨跌幅（百分比）；净值按当日与上一净值计算，保留 2 位小数；不可用为 null',
    }),
    date: z.string().nullable().openapi({ description: '行情所属日期 YYYY-MM-DD；不可用为 null' }),
    time: z.string().nullable().openapi({
      description:
        '估值为来源给出的 ISO 时间；净值只提供日期 YYYY-MM-DD，不虚构发布时间；不可用为 null',
    }),
    source: z.enum(['tiantian', 'sina', 'calculated', 'eastmoney']).nullable().openapi({
      description: '行情来源：天天基金 / 新浪财经 / 自算估值 / 东方财富净值；不可用为 null',
    }),
    sourceName: z.string().nullable().openapi({ description: '来源展示名；不可用为 null' }),
    fallback: z.boolean().openapi({ description: '估值是否使用备用来源；净值与不可用时为 false' }),
  })
  .openapi('OverviewQuote');

export const OverviewSchema = z
  .object({
    summary: SummarySchema.extend({
      risingCount: z.number().int().nonnegative().openapi({
        description: '有已确认份额且今日行情涨幅大于 0 的基金只数，同基金跨渠道只计一次',
      }),
      fallingCount: z.number().int().nonnegative().openapi({
        description: '有已确认份额且今日行情涨幅小于 0 的基金只数；平盘及不可用不计入涨跌只数',
      }),
    }).openapi('OverviewSummary'),
    positions: z
      .array(
        PositionSchema.extend({
          fundName: z
            .string()
            .nullable()
            .openapi({ description: '基金名称；基础信息暂不可用为 null，仍保留基金代码' }),
          channelName: z
            .string()
            .nullable()
            .openapi({ description: '渠道名称；读取期间渠道已删除时为 null' }),
          quote: OverviewQuoteSchema,
        }).openapi('OverviewPosition'),
      )
      .openapi({ description: '按持仓创建顺序返回，隐藏已清仓；同基金跨渠道逐笔展示' }),
    indices: MarketIndicesSchema,
    time: z.string().openapi({ format: 'date-time', description: '概览生成时间' }),
    referenceOnly: z.literal(true).openapi({ description: '行情和估值仅供参考，供前端展示提示' }),
  })
  .openapi('Overview');

export type OverviewQuote = z.infer<typeof OverviewQuoteSchema>;
export type OverviewResponse = z.infer<typeof OverviewSchema>;

const errorContent = { 'application/json': { schema: ErrorResponseSchema } };
const security: Record<string, string[]>[] = [{ SessionCookie: [] }, { SessionBearer: [] }];

export const overviewRoute = createRoute({
  method: 'get',
  path: '/v1/overview',
  tags: ['overview'],
  security,
  summary: '今日概览',
  description: [
    '需要网页或小程序会话，一次返回自己的持仓汇总、涨跌只数、持仓行情及四个大盘指数。',
    'channelId 仅筛选持仓及汇总，不影响大盘指数；渠道不存在或属于别人时返回 404 not_found。',
    '汇总沿用持仓汇总口径（包含已清仓的已实现收益）；列表隐藏已清仓，待确认交易不改变份额或成本。',
    '净值公布前使用当天估值，公布后使用当日净值；盘前、休市或行情缺失时明确不可用。',
    '不可用持仓的今日收益及其分母不计入合计，todayGainComplete=false；缺净值时 valuationComplete=false，isComplete 为两者合取。',
    '指数行情失败时逐项 available=false，概览仍返回 200；行情仅供参考。',
  ].join(''),
  request: {
    query: z.object({
      channelId: z.uuid().toLowerCase().optional().openapi({ description: '仅查看自己的此渠道' }),
    }),
  },
  responses: {
    200: { description: '今日概览', content: { 'application/json': { schema: OverviewSchema } } },
    400: { description: '参数不合法', content: errorContent },
    401: { description: '未登录或会话已失效', content: errorContent },
    404: { description: 'not_found：渠道不存在（包含别人的渠道）', content: errorContent },
    500: { description: '内部错误', content: errorContent },
    503: { description: '数据库不可用', content: errorContent },
  },
});
