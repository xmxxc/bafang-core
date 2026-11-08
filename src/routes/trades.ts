import { createRoute, z } from '@hono/zod-openapi';
import { ErrorResponseSchema } from '../errors';

const errorContent = { 'application/json': { schema: ErrorResponseSchema } };
const security: Record<string, string[]>[] = [{ SessionCookie: [] }, { SessionBearer: [] }];
const PositionParam = z.object({ id: z.uuid().toLowerCase().openapi({ description: '持仓 id' }) });
const timingFields = {
  feeRate: z
    .string()
    .regex(/^(0(\.\d{1,6})?|1(\.0{1,6})?)$/)
    .openapi({
      example: '0.0015',
      description: '买入或卖出费率比值，0–1，最多 6 位小数',
    }),
  submittedDate: z.iso
    .date()
    .refine((date) => !date.startsWith('0000-'), { message: '提交日年份必须大于 0' })
    .optional()
    .openapi({ description: '提交日 YYYY-MM-DD；省略为上海今天，填写时必须同时提供 beforeCutoff' }),
  beforeCutoff: z
    .boolean()
    .optional()
    .openapi({ description: '是否在 15:00 前；false 含 15:00 整。省略时按当前上海时间判断' }),
};
const TradeBody = z
  .discriminatedUnion('type', [
    z
      .object({
        ...timingFields,
        type: z.literal('buy'),
        amount: z
          .string()
          .regex(/^\d{1,16}(\.\d{1,2})?$/)
          .openapi({ description: '加仓金额，必须大于 0，最多 2 位小数' }),
      })
      .strict()
      .openapi('BuyTradeCreate'),
    z
      .object({
        ...timingFields,
        type: z.literal('sell'),
        shares: z
          .string()
          .regex(/^\d{1,16}(\.\d{1,4})?$/)
          .openapi({ description: '减仓份额，必须大于 0 且不超过可用份额，最多 4 位小数' }),
      })
      .strict()
      .openapi('SellTradeCreate'),
  ])
  .refine((value) => value.submittedDate === undefined || value.beforeCutoff !== undefined, {
    message: '填写提交日时必须同时填写 beforeCutoff',
  })
  .openapi('TradeCreate');

export const TradeSchema = z
  .object({
    id: z.uuid(),
    positionId: z.uuid(),
    type: z
      .enum(['buy', 'sell', 'switch_out', 'switch_in'])
      .openapi({ description: '加仓、减仓、调仓转出、调仓转入' }),
    status: z.enum(['pending', 'confirmed']).openapi({ description: '在途、已确认' }),
    submittedDate: z.string().openapi({ description: '提交日 YYYY-MM-DD' }),
    beforeCutoff: z.boolean(),
    applicationDate: z.string().openapi({ description: '申请所属交易日 YYYY-MM-DD' }),
    settlementDate: z.string().openapi({ description: '预计确认日 YYYY-MM-DD' }),
    amount: z.string().nullable().openapi({ description: '金额，2 位小数；未有金额时为 null' }),
    shares: z
      .string()
      .nullable()
      .openapi({ description: '申请份额，4 位小数；按金额加仓时为 null' }),
    feeRate: z.string().openapi({ description: '费率比值，6 位小数' }),
    confirmedNav: z.string().nullable().openapi({ description: '确认净值，4 位小数；在途为 null' }),
    confirmedShares: z
      .string()
      .nullable()
      .openapi({ description: '确认份额，4 位小数；在途为 null' }),
    switchId: z.uuid().nullable().openapi({ description: '调仓关联 id；非调仓为 null' }),
    source: z.string().openapi({ description: '来源；P1 为 web，后续可保存访问令牌名' }),
  })
  .openapi('Trade');
const commonErrors = {
  400: { description: 'validation_error：参数不合法', content: errorContent },
  401: { description: 'unauthorized：未登录或会话失效', content: errorContent },
  404: { description: 'not_found：持仓或交易不存在（含别人的）', content: errorContent },
  500: { description: '内部错误', content: errorContent },
  503: { description: '数据库不可用', content: errorContent },
};
export const tradeCreateRoute = createRoute({
  security,
  method: 'post',
  path: '/v1/positions/{id}/trades',
  tags: ['trades'],
  summary: '提交加仓或减仓交易',
  description:
    '按提交日期、15:00 截止点与基金 T+N/交易日历返回预计确认日。在途不改变持仓份额或成本；减仓预留可用份额（已确认份额减去在途减仓/调仓转出），超额返回 409 insufficient_shares。此接口每次调用创建一笔交易，重试可能重复记录。',
  request: {
    params: PositionParam,
    body: { required: true, content: { 'application/json': { schema: TradeBody } } },
  },
  responses: {
    ...commonErrors,
    201: { description: '已提交，在途', content: { 'application/json': { schema: TradeSchema } } },
    404: {
      description: 'not_found：持仓不存在（含别人的）；fund_not_found：基金不存在',
      content: errorContent,
    },
    409: { description: 'insufficient_shares：减仓超过可用份额', content: errorContent },
    502: { description: 'upstream_unavailable：基金规则上游不可用', content: errorContent },
  },
});
export const tradeListRoute = createRoute({
  security,
  method: 'get',
  path: '/v1/positions/{id}/trades',
  tags: ['trades'],
  summary: '查看持仓交易记录',
  description: '仅能查看自己的持仓；按创建先后排序，同一时刻按交易 id 排序。',
  request: { params: PositionParam },
  responses: {
    ...commonErrors,
    200: {
      description: '交易列表',
      content: {
        'application/json': {
          schema: z.object({ items: z.array(TradeSchema) }).openapi('TradeList'),
        },
      },
    },
  },
});
export const tradeCancelRoute = createRoute({
  security,
  method: 'delete',
  path: '/v1/positions/{id}/trades/{tradeId}',
  tags: ['trades'],
  summary: '撤销在途交易',
  description: '按上海日期判断：仅确认日前且仍为在途的交易可撤销；撤销即删除。',
  request: { params: PositionParam.extend({ tradeId: z.uuid().toLowerCase() }) },
  responses: {
    ...commonErrors,
    204: { description: '已撤销并删除' },
    409: {
      description: 'trade_not_cancellable：已到确认日或已确认，不能撤销',
      content: errorContent,
    },
  },
});
