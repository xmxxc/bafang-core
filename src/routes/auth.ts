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

const githubErrors = {
  400: {
    description:
      'github_state_invalid：state 缺失、不匹配、过期、已使用；github_authorization_failed：授权被拒绝或缺少 code；validation_error：参数不合法',
    content: errorContent,
  },
  429: { description: 'rate_limited：请求过于频繁', content: errorContent },
  500: { description: '内部错误', content: errorContent },
  502: { description: 'github_unavailable：GitHub 暂不可用或返回无效身份', content: errorContent },
  503: {
    description: 'github_not_configured：GitHub 登录未配置；database_unavailable：数据库不可用',
    content: errorContent,
  },
};

export const githubStartRoute = createRoute({
  method: 'get',
  path: '/v1/auth/github',
  tags: ['auth'],
  summary: '发起 GitHub 网页登录',
  description:
    '生成有效期 10 分钟、与浏览器 Cookie 绑定的一次性 state，并重定向到 GitHub（S256 PKCE）。不接受请求指定回调或登录后跳转地址。',
  responses: {
    302: {
      description: '前往 GitHub 授权；设置 httpOnly + Secure + SameSite=Lax 的临时 Cookie',
      headers: { Location: { schema: { type: 'string' } } },
    },
    ...githubErrors,
  },
});

export const githubCallbackRoute = createRoute({
  method: 'get',
  path: '/v1/auth/github/callback',
  tags: ['auth'],
  summary: 'GitHub 授权回调',
  description:
    '先原子消费 state，再换取 GitHub 数字用户 ID；首次创建用户与三个渠道，建立与邮箱网页登录相同的会话 Cookie，跳回配置的网页地址。失败后需重新发起登录。',
  request: {
    query: z.object({
      state: z.string().max(128).optional(),
      code: z.string().max(2048).optional(),
      error: z.string().max(256).optional(),
    }),
  },
  responses: {
    302: {
      description: '登录成功；设置网页会话 Cookie，跳转到配置地址',
      headers: { Location: { schema: { type: 'string' } } },
    },
    ...githubErrors,
  },
});
