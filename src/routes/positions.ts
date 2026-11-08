import { createRoute, z } from '@hono/zod-openapi';
import { ErrorResponseSchema } from '../errors';

const errorContent = { 'application/json': { schema: ErrorResponseSchema } };
const security: Record<string, string[]>[] = [{ SessionCookie: [] }, { SessionBearer: [] }];
const PositionParam = z.object({ id: z.uuid().toLowerCase().openapi({ description: '持仓 id' }) });

// 数值一律用十进制字符串传输，避免 JSON 数字经过二进制浮点。整数位上限保证换算后仍落在列精度内。
const Shares = z
  .string()
  .regex(/^\d{1,16}(\.\d{1,4})?$/, '份额为非负十进制字符串，最多 4 位小数')
  .openapi({ example: '1000.0000', description: '份额，最多 4 位小数' });
const Amount = z
  .string()
  .regex(/^\d{1,16}(\.\d{1,2})?$/, '总成本为非负十进制字符串，最多 2 位小数')
  .openapi({ example: '1234.56', description: '总成本（元），最多 2 位小数；与 unitPrice 二选一' });
const UnitPrice = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,4})?$/, '单价为非负十进制字符串，最多 4 位小数')
  .openapi({
    example: '1.2346',
    description:
      '单价（元/份），最多 4 位小数；与 totalCost 二选一，总成本 = 份额 × 单价，四舍五入到 2 位',
  });
const onlyOneCost = (value: { totalCost?: string; unitPrice?: string }) =>
  (value.totalCost === undefined) !== (value.unitPrice === undefined);
const ONE_COST_MESSAGE = '总成本与单价必须且只能填写一个';

const CreateBody = z
  .object({
    fundCode: z
      .string()
      .regex(/^\d{6}$/, '基金代码为 6 位数字')
      .openapi({ example: '000001', description: '基金代码，必须是存在的基金' }),
    channelId: z.uuid().toLowerCase().openapi({ description: '自己的渠道 id' }),
    shares: Shares,
    totalCost: Amount.optional(),
    unitPrice: UnitPrice.optional(),
    snapshotDate: z.iso.date().optional().openapi({
      example: '2026-11-06',
      description: '快照日期 YYYY-MM-DD，缺省为今天（上海时间）',
    }),
  })
  .refine(onlyOneCost, { message: ONE_COST_MESSAGE })
  .openapi('PositionCreate');
const CalibrateBody = z
  .object({ shares: Shares, totalCost: Amount.optional(), unitPrice: UnitPrice.optional() })
  .refine(onlyOneCost, { message: ONE_COST_MESSAGE })
  .openapi('PositionCalibrate');

export const PositionSchema = z
  .object({
    id: z.uuid(),
    fundCode: z.string(),
    channelId: z.uuid(),
    shares: z.string().openapi({ example: '1000.0000', description: '份额，4 位小数' }),
    totalCost: z.string().openapi({ example: '1234.56', description: '总成本，2 位小数' }),
    unitPrice: z.string().nullable().openapi({
      description: '成本单价 = 总成本 ÷ 份额，四舍五入到 4 位；份额为 0 时为 null',
    }),
    snapshotDate: z.string().openapi({ description: '建仓快照日期 YYYY-MM-DD' }),
    nav: z
      .string()
      .nullable()
      .openapi({ description: '最新单位净值，4 位小数；暂无净值时为 null' }),
    navDate: z.string().nullable().openapi({ description: '最新净值日期；暂无净值时为 null' }),
    marketValue: z.string().nullable().openapi({
      description: '市值 = 份额 × 最新净值，四舍五入到 2 位；暂无净值时为 null（不是 0）',
    }),
    holdingGain: z.string().nullable().openapi({
      description: '持有收益 = 市值 − 总成本，2 位小数；暂无净值时为 null',
    }),
    holdingGainRate: z.string().nullable().openapi({
      example: '0.0123',
      description:
        '持有收益率 = 持有收益 ÷ 总成本（比值，不是百分数），四舍五入到 4 位；暂无净值或总成本为 0 时为 null',
    }),
  })
  .openapi('Position');
const PositionListSchema = z.object({ items: z.array(PositionSchema) }).openapi('PositionList');

const commonErrors = {
  401: { description: '未登录或会话已失效', content: errorContent },
  500: { description: '内部错误', content: errorContent },
  503: { description: '数据库不可用', content: errorContent },
};
const notOwned = { description: '持仓不存在（包含别人的持仓）', content: errorContent };

export const positionListRoute = createRoute({
  security,
  method: 'get',
  path: '/v1/positions',
  tags: ['positions'],
  summary: '查看自己的持仓',
  description:
    '需要登录，按创建先后返回；传 channelId 只返回该渠道的持仓；渠道不存在或属于别人时返回 404 `not_found`。',
  request: {
    query: z.object({
      channelId: z.uuid().toLowerCase().optional().openapi({ description: '按渠道筛选' }),
    }),
  },
  responses: {
    200: {
      description: '持仓列表',
      content: { 'application/json': { schema: PositionListSchema } },
    },
    400: { description: '参数不合法', content: errorContent },
    404: { description: 'not_found：渠道不存在（包含别人的渠道）', content: errorContent },
    ...commonErrors,
  },
});

export const positionDetailRoute = createRoute({
  security,
  method: 'get',
  path: '/v1/positions/{id}',
  tags: ['positions'],
  summary: '查看一笔持仓',
  description: '需要登录，返回份额、总成本、市值、持有收益与收益率。',
  request: { params: PositionParam },
  responses: {
    200: { description: '持仓详情', content: { 'application/json': { schema: PositionSchema } } },
    400: { description: '参数不合法', content: errorContent },
    404: notOwned,
    ...commonErrors,
  },
});

export const positionCreateRoute = createRoute({
  security,
  method: 'post',
  path: '/v1/positions',
  tags: ['positions'],
  summary: '以建仓快照新建持仓',
  description:
    '需要登录。总成本与单价二选一，另一个由 core 换算；份额必须大于 0。同一用户、基金、渠道只能有一笔持仓。',
  request: { body: { required: true, content: { 'application/json': { schema: CreateBody } } } },
  responses: {
    201: { description: '已新建', content: { 'application/json': { schema: PositionSchema } } },
    400: { description: 'validation_error：参数不合法', content: errorContent },
    404: {
      description: 'fund_not_found：基金不存在；not_found：渠道不存在（包含别人的渠道）',
      content: errorContent,
    },
    409: { description: 'position_exists：该渠道已有这只基金的持仓', content: errorContent },
    502: { description: 'upstream_unavailable：校验基金时行情上游不可用', content: errorContent },
    ...commonErrors,
  },
});

export const positionCalibrateRoute = createRoute({
  security,
  method: 'patch',
  path: '/v1/positions/{id}',
  tags: ['positions'],
  summary: '校准持仓',
  description:
    '需要登录。用新的份额与成本（总成本或单价二选一）覆盖当前值，不生成交易记录；份额可为 0（已清仓）。',
  request: {
    params: PositionParam,
    body: { required: true, content: { 'application/json': { schema: CalibrateBody } } },
  },
  responses: {
    200: { description: '已校准', content: { 'application/json': { schema: PositionSchema } } },
    400: { description: 'validation_error：参数不合法', content: errorContent },
    404: notOwned,
    ...commonErrors,
  },
});

export const positionDeleteRoute = createRoute({
  security,
  method: 'delete',
  path: '/v1/positions/{id}',
  tags: ['positions'],
  summary: '彻底删除一笔持仓',
  description: '需要登录，删除持仓连同它的交易（交易由 #17 起以外键级联删除）。',
  request: { params: PositionParam },
  responses: {
    204: { description: '已删除' },
    400: { description: '参数不合法', content: errorContent },
    404: notOwned,
    ...commonErrors,
  },
});
