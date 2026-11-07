import { createRoute, z } from '@hono/zod-openapi';
import { ErrorResponseSchema } from '../errors';

const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email())
  .openapi({ example: 'user@example.com', description: '邮箱地址' });

const DeviceSchema = z.enum(['web', 'miniprogram']).openapi({
  description: '会话设备：web 网页（httpOnly Cookie）、miniprogram 小程序（请求头携带令牌）',
});

const VerificationCodeSchema = z
  .string()
  .regex(/^\d{6}$/, '验证码为 6 位数字')
  .openapi({ example: '123456', description: '6 位数字验证码' });

const UserSummarySchema = z
  .object({
    id: z.string().openapi({ example: '0199c4d0-...', description: '用户 id' }),
  })
  .openapi('UserSummary');

const EmailCodeRequestResponseSchema = z
  .object({
    retryAfterSeconds: z
      .number()
      .int()
      .openapi({ example: 60, description: '同一邮箱再次请求验证码前需等待的秒数' }),
  })
  .openapi('EmailCodeRequestResult');

const SessionSchema = z
  .object({
    device: DeviceSchema,
    expiresAt: z.string().openapi({ format: 'date-time', description: '会话过期时间' }),
  })
  .openapi('Session');

const EmailLoginResponseSchema = z
  .object({
    user: UserSummarySchema,
    session: SessionSchema,
    token: z.string().nullable().openapi({
      description:
        '会话令牌：小程序端通过请求头携带；网页端为 null（令牌只在 httpOnly + Secure Cookie 里）',
    }),
  })
  .openapi('EmailLoginResult');

const LoginMethodSchema = z
  .object({
    type: z.enum(['email', 'github', 'wechat']).openapi({ description: '登录方式类型' }),
    externalId: z.string().openapi({ example: 'user@example.com', description: '外部标识' }),
  })
  .openapi('LoginMethod');

const ChannelSummarySchema = z
  .object({
    id: z.string().openapi({ description: '渠道 id' }),
    name: z.string().openapi({ example: '支付宝', description: '渠道名' }),
  })
  .openapi('Channel');

const MeResponseSchema = z
  .object({
    user: UserSummarySchema,
    loginMethods: z.array(LoginMethodSchema),
    channels: z.array(ChannelSummarySchema),
  })
  .openapi('Me');

export type EmailLoginResponse = z.infer<typeof EmailLoginResponseSchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;

const errorContent = { 'application/json': { schema: ErrorResponseSchema } };

export const emailCodeRequestRoute = createRoute({
  method: 'post',
  path: '/v1/auth/email/request',
  tags: ['auth'],
  summary: '请求邮箱验证码',
  description:
    '生成 6 位验证码并通过 Resend 适配器发信（开发模式用假发信）。同一邮箱 60 秒内只能请求一次，每天有上限，同一 IP 有限流。',
  request: {
    body: {
      content: { 'application/json': { schema: z.object({ email: EmailSchema }) } },
    },
  },
  responses: {
    200: {
      description: '验证码已发出',
      content: { 'application/json': { schema: EmailCodeRequestResponseSchema } },
    },
    400: { description: '参数不合法', content: errorContent },
    429: {
      description: '请求过于频繁（同一邮箱冷却、每日上限或同一 IP 限流）',
      content: errorContent,
    },
    500: { description: '内部错误', content: errorContent },
    503: { description: '数据库不可用', content: errorContent },
  },
});

export const emailLoginRoute = createRoute({
  method: 'post',
  path: '/v1/auth/email/login',
  tags: ['auth'],
  summary: '邮箱验证码登录',
  description:
    '用邮箱和 6 位验证码登录；首次登录自动创建用户、邮箱登录方式，并预置三个渠道。网页端返回 httpOnly + Secure Cookie，小程序端返回令牌由请求头携带。',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            email: EmailSchema,
            code: VerificationCodeSchema,
            device: DeviceSchema,
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: '登录成功，建立会话',
      content: { 'application/json': { schema: EmailLoginResponseSchema } },
    },
    400: { description: '参数不合法，或验证码过期/错误/已使用/作废', content: errorContent },
    500: { description: '内部错误', content: errorContent },
    503: { description: '数据库不可用', content: errorContent },
  },
});

export const logoutRoute = createRoute({
  method: 'post',
  path: '/v1/auth/logout',
  tags: ['auth'],
  summary: '退出登录',
  description: '作废当前会话；其他设备上的会话不受影响。',
  responses: {
    204: { description: '已退出当前会话' },
    401: { description: '未登录或会话已失效', content: errorContent },
    500: { description: '内部错误', content: errorContent },
    503: { description: '数据库不可用', content: errorContent },
  },
});

export const meRoute = createRoute({
  method: 'get',
  path: '/v1/me',
  tags: ['auth'],
  summary: '当前用户',
  description: '返回当前登录用户、已关联的登录方式与渠道列表。',
  responses: {
    200: {
      description: '当前用户信息',
      content: { 'application/json': { schema: MeResponseSchema } },
    },
    401: { description: '未登录或会话已失效', content: errorContent },
    500: { description: '内部错误', content: errorContent },
    503: { description: '数据库不可用', content: errorContent },
  },
});
