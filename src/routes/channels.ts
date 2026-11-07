import { createRoute, z } from '@hono/zod-openapi';
import { ErrorResponseSchema } from '../errors';

export const ChannelSchema = z
  .object({
    id: z.uuid().openapi({ description: '渠道 id' }),
    name: z.string().openapi({ example: '支付宝', description: '渠道名' }),
  })
  .openapi('Channel');

const errorContent = { 'application/json': { schema: ErrorResponseSchema } };
const commonErrors = {
  401: { description: '未登录或会话已失效', content: errorContent },
  500: { description: '内部错误', content: errorContent },
  503: { description: '数据库不可用', content: errorContent },
};
const NameBody = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .openapi({ description: '渠道名，去除首尾空白，1–100 字符' }),
});
const ChannelParam = z.object({ id: z.uuid().openapi({ description: '渠道 id' }) });
const ChannelListSchema = z.object({ items: z.array(ChannelSchema) }).openapi('ChannelList');
const security: Record<string, string[]>[] = [{ SessionCookie: [] }, { SessionBearer: [] }];

export const channelListRoute = createRoute({
  security,
  method: 'get',
  path: '/v1/channels',
  tags: ['channels'],
  summary: '查看自己的渠道',
  description: '需要登录，按用户自定义顺序返回渠道列表。',
  responses: {
    200: {
      description: '渠道列表',
      content: {
        'application/json': { schema: ChannelListSchema },
      },
    },
    ...commonErrors,
  },
});

export const channelCreateRoute = createRoute({
  security,
  method: 'post',
  path: '/v1/channels',
  tags: ['channels'],
  summary: '新增自己的渠道',
  description: '需要登录，新增渠道排在末尾；同一用户下名称不能重复。',
  request: { body: { required: true, content: { 'application/json': { schema: NameBody } } } },
  responses: {
    201: { description: '已新增', content: { 'application/json': { schema: ChannelSchema } } },
    400: { description: '参数不合法', content: errorContent },
    409: { description: 'channel_name_conflict：已有同名渠道', content: errorContent },
    ...commonErrors,
  },
});

export const channelRenameRoute = createRoute({
  security,
  method: 'patch',
  path: '/v1/channels/{id}',
  tags: ['channels'],
  summary: '修改自己的渠道名',
  description: '需要登录，“未指定”不能改名；同一用户下渠道名不能重复。',
  request: {
    params: ChannelParam,
    body: { required: true, content: { 'application/json': { schema: NameBody } } },
  },
  responses: {
    200: { description: '已改名', content: { 'application/json': { schema: ChannelSchema } } },
    400: { description: '参数不合法', content: errorContent },
    404: { description: '渠道不存在（包含别人的渠道）', content: errorContent },
    409: {
      description: 'channel_name_conflict：已有同名渠道；channel_protected：“未指定”不能改名',
      content: errorContent,
    },
    ...commonErrors,
  },
});

export const channelOrderRoute = createRoute({
  security,
  method: 'put',
  path: '/v1/channels/order',
  tags: ['channels'],
  summary: '调整自己的渠道顺序',
  description: '需要登录，以完整渠道 id 列表替换顺序，包含“未指定”；每个渠道必须恰好出现一次。',
  request: {
    body: {
      required: true,
      content: {
        'application/json': { schema: z.object({ channelIds: z.array(z.uuid()).min(1) }) },
      },
    },
  },
  responses: {
    200: { description: '已排序', content: { 'application/json': { schema: ChannelListSchema } } },
    400: { description: '参数不合法，或渠道列表有重复、缺漏', content: errorContent },
    404: { description: '渠道不存在（包含别人的渠道）', content: errorContent },
    ...commonErrors,
  },
});

export const channelDeleteRoute = createRoute({
  security,
  method: 'delete',
  path: '/v1/channels/{id}',
  tags: ['channels'],
  summary: '删除自己的无持仓渠道',
  description: '需要登录，“未指定”不能删除；仅允许删除没有任何持仓的渠道。',
  request: { params: ChannelParam },
  responses: {
    204: { description: '已删除' },
    400: { description: '参数不合法', content: errorContent },
    404: { description: '渠道不存在（包含别人的渠道）', content: errorContent },
    409: {
      description: 'channel_protected：“未指定”不能删除；channel_has_positions：渠道下仍有持仓',
      content: errorContent,
    },
    ...commonErrors,
  },
});
