import { createRoute, z } from '@hono/zod-openapi';
import { ErrorResponseSchema } from '../errors';
import { ChannelSchema } from './channels';

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

const BindCodeSchema = z
  .string()
  .regex(/^\d{6}$/, '绑定码为 6 位数字')
  .openapi({ example: '123456', description: '6 位数字绑定码' });

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

const LoginMethodDisplaySchema = z
  .object({
    type: z.enum(['email', 'github', 'wechat']),
    display: z.string().openapi({ description: '展示信息，不包含密钥或令牌' }),
  })
  .openapi('LoginMethodDisplay');

const WeChatLoginResponseSchema = z
  .object({
    user: UserSummarySchema,
    session: SessionSchema.extend({ device: z.literal('miniprogram') }),
    token: z
      .string()
      .openapi({ description: '会话令牌；后续请求使用 Authorization: Bearer <token>' }),
  })
  .openapi('WeChatLoginResult');

export type WeChatLoginResponse = z.infer<typeof WeChatLoginResponseSchema>;

const MeResponseSchema = z
  .object({
    user: UserSummarySchema,
    loginMethods: z.array(LoginMethodSchema),
    channels: z.array(ChannelSchema),
  })
  .openapi('Me');

export type EmailLoginResponse = z.infer<typeof EmailLoginResponseSchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;

const errorContent = { 'application/json': { schema: ErrorResponseSchema } };

const BindCodeResultSchema = z
  .object({
    code: BindCodeSchema,
    expiresAt: z.string().openapi({ format: 'date-time', description: '绑定码过期时间' }),
  })
  .openapi('BindCodeResult');

export const bindCodeGenerateRoute = createRoute({
  method: 'post',
  path: '/v1/auth/bind-code',
  tags: ['auth'],
  summary: '生成绑定码',
  description:
    '仅已登录的网页会话可生成 6 位数字绑定码。绑定码有效 10 分钟，同一用户再次生成时作废旧码；服务端只存带密钥 HMAC，不保存可直接使用的明文。',
  security: [{ SessionCookie: [] }, { SessionBearer: [] }],
  responses: {
    201: {
      description: '绑定码已生成',
      content: { 'application/json': { schema: BindCodeResultSchema } },
    },
    400: { description: '参数不合法', content: errorContent },
    401: { description: 'unauthorized：未登录或会话已失效', content: errorContent },
    403: { description: 'bind_code_web_required：需要网页会话', content: errorContent },
    429: { description: 'rate_limited：请求过于频繁', content: errorContent },
    500: { description: '内部错误', content: errorContent },
    503: {
      description:
        'database_unavailable：数据库不可用；bind_code_not_configured：绑定码功能未配置；bind_code_unavailable：绑定码暂时无法生成',
      content: errorContent,
    },
  },
});

const WeChatBindBodySchema = z
  .object({
    code: z.string().min(1).max(512).regex(/^\S+$/).optional(),
    wechatCode: z.string().min(1).max(512).regex(/^\S+$/).optional(),
    bindCode: BindCodeSchema,
  })
  .refine((value) => Boolean(value.code) !== Boolean(value.wechatCode), {
    message: '微信登录凭据必须填写 code 或 wechatCode 其中一个',
  });

export const wechatBindCodeRoute = createRoute({
  method: 'post',
  path: '/v1/auth/wechat/bind',
  tags: ['auth'],
  summary: '用微信登录凭据消费绑定码',
  description:
    '提交 wx.login 凭据与绑定码。网络 code2session 交换完成后，绑定码消费、登录方式关联和小程序会话创建在同一数据库事务边界内完成；成功返回与微信登录一致的小程序会话。IP 每分钟最多 5 次，并有按 openid 每 24 小时 10 次、全站每小时 300 次的持久化失败预算。',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: WeChatBindBodySchema } },
    },
  },
  responses: {
    200: {
      description: '绑定成功，返回小程序会话',
      content: { 'application/json': { schema: WeChatLoginResponseSchema } },
    },
    400: {
      description:
        'validation_error：参数不合法；wechat_code_invalid：微信凭据无效；bind_code_invalid：绑定码不存在；bind_code_expired：绑定码过期；bind_code_used：绑定码已使用',
      content: errorContent,
    },
    409: {
      description:
        'login_method_conflict：微信已属于有持仓用户；login_method_type_conflict：绑定码所属用户已有其他微信登录方式',
      content: errorContent,
    },
    429: { description: 'rate_limited：提交过于频繁', content: errorContent },
    500: { description: '内部错误', content: errorContent },
    502: { description: 'wechat_unavailable：微信暂不可用', content: errorContent },
    503: {
      description:
        'wechat_not_configured：微信登录未配置；database_unavailable：数据库不可用；bind_code_not_configured：绑定码功能未配置',
      content: errorContent,
    },
  },
});

export const wechatLoginRoute = createRoute({
  method: 'post',
  path: '/v1/auth/wechat/login',
  tags: ['auth'],
  summary: '微信小程序登录',
  description:
    '提交 wx.login 的一次性 code，使用 openid 识别用户。首次登录自动创建用户并预置三个渠道。返回小程序会话令牌，通过 Authorization: Bearer 请求头携带，不设置 Cookie。失败后应重新调用 wx.login 获取 code。',
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({ code: z.string().min(1).max(512).regex(/^\S+$/) }),
        },
      },
    },
  },
  responses: {
    200: {
      description: '登录成功，建立独立的小程序会话',
      content: { 'application/json': { schema: WeChatLoginResponseSchema } },
    },
    400: {
      description: 'validation_error：参数不合法；wechat_code_invalid：code 无效或已使用',
      content: errorContent,
    },
    429: { description: 'rate_limited：请求过于频繁', content: errorContent },
    500: { description: '内部错误', content: errorContent },
    502: { description: 'wechat_unavailable：微信暂不可用或返回格式异常', content: errorContent },
    503: {
      description: 'wechat_not_configured：微信登录未配置；database_unavailable：数据库不可用',
      content: errorContent,
    },
  },
});

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
    400: {
      description:
        'validation_error：参数不合法；verification_code_invalid / verification_code_expired / verification_code_used / verification_code_max_attempts：登录验证码错误、过期、已使用或作废（关联邮箱的验证码不能用于登录）',
      content: errorContent,
    },
    429: { description: 'rate_limited：同一 IP 请求过于频繁', content: errorContent },
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
  request: { query: z.object({ intent: z.enum(['login', 'link']).default('login') }) },
  responses: {
    302: {
      description: '前往 GitHub 授权；设置 httpOnly + Secure + SameSite=Lax 的临时 Cookie',
      headers: { Location: { schema: { type: 'string' } } },
    },
    ...githubErrors,
    401: {
      description: 'unauthorized：intent=link 时未登录或会话已失效（关联 state 绑定发起会话）',
      content: errorContent,
    },
  },
});

export const githubCallbackRoute = createRoute({
  method: 'get',
  path: '/v1/auth/github/callback',
  tags: ['auth'],
  summary: 'GitHub 授权回调',
  description:
    '登录意图建立网页会话；关联意图要求回调携带发起关联的同一网页会话且该会话仍有效（未退出、未过期），并将 GitHub 登录方式关联到该用户。',
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
    401: {
      description:
        'unauthorized：关联回调未携带发起关联的会话，或该会话已退出/过期，或换成了同一用户的其他会话',
      content: errorContent,
    },
    409: {
      description:
        'login_method_conflict：该 GitHub 登录方式已属于有持仓的其他用户；login_method_type_conflict：当前用户已关联其他 GitHub 登录方式',
      content: errorContent,
    },
  },
});

export const loginMethodsRoute = createRoute({
  method: 'get',
  path: '/v1/me/login-methods',
  tags: ['auth'],
  summary: '列出已关联的登录方式',
  security: [{ SessionCookie: [] }, { SessionBearer: [] }],
  responses: {
    200: {
      description: '登录方式类型与展示信息',
      content: {
        'application/json': { schema: z.object({ items: z.array(LoginMethodDisplaySchema) }) },
      },
    },
    401: { description: '未登录或会话已失效', content: errorContent },
    500: { description: '内部错误', content: errorContent },
    503: { description: '数据库不可用', content: errorContent },
  },
});

export const emailLinkRequestRoute = createRoute({
  method: 'post',
  path: '/v1/auth/email/link/request',
  tags: ['auth'],
  summary: '请求关联邮箱验证码',
  security: [{ SessionCookie: [] }, { SessionBearer: [] }],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: z.object({ email: EmailSchema }) } },
    },
  },
  responses: {
    200: {
      description: '验证码已发出',
      content: { 'application/json': { schema: EmailCodeRequestResponseSchema } },
    },
    400: { description: 'validation_error：参数不合法', content: errorContent },
    401: { description: 'unauthorized：未登录或会话已失效', content: errorContent },
    429: {
      description:
        'email_code_cooldown：同一邮箱 60 秒内已请求过验证码（与登录验证码共享冷却）；email_code_daily_limit：同一邮箱今日验证码次数已达上限（登录与关联合计）；rate_limited：同一 IP 请求过于频繁',
      content: errorContent,
    },
    500: { description: '内部错误', content: errorContent },
    503: { description: '数据库不可用', content: errorContent },
  },
});

export const emailLinkRoute = createRoute({
  method: 'post',
  path: '/v1/auth/email/link',
  tags: ['auth'],
  summary: '用验证码关联邮箱',
  security: [{ SessionCookie: [] }, { SessionBearer: [] }],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({ email: EmailSchema, code: VerificationCodeSchema }),
        },
      },
    },
  },
  responses: {
    200: {
      description: '邮箱已关联',
      content: { 'application/json': { schema: LoginMethodSchema } },
    },
    400: {
      description:
        'validation_error：参数不合法；verification_code_invalid / verification_code_expired / verification_code_used / verification_code_max_attempts：关联验证码错误、过期、已使用或作废（登录验证码不能用于关联）',
      content: errorContent,
    },
    401: { description: 'unauthorized：未登录或会话已失效', content: errorContent },
    409: {
      description:
        'login_method_conflict：该邮箱已属于有持仓的其他用户；login_method_type_conflict：当前用户已关联其他邮箱',
      content: errorContent,
    },
    429: { description: 'rate_limited：同一 IP 请求过于频繁', content: errorContent },
    500: { description: '内部错误', content: errorContent },
    503: { description: '数据库不可用', content: errorContent },
  },
});

export const loginMethodDeleteRoute = createRoute({
  method: 'delete',
  path: '/v1/me/login-methods/{type}',
  tags: ['auth'],
  summary: '解绑登录方式',
  security: [{ SessionCookie: [] }, { SessionBearer: [] }],
  request: {
    params: z.object({
      type: z.enum(['email', 'github', 'wechat']).openapi({ description: '登录方式类型' }),
    }),
  },
  responses: {
    204: { description: '已解绑' },
    400: { description: 'validation_error：登录方式类型不合法', content: errorContent },
    401: { description: 'unauthorized：未登录或会话已失效', content: errorContent },
    404: {
      description: 'login_method_not_found：当前用户未关联该类型的登录方式',
      content: errorContent,
    },
    409: { description: 'login_method_last：仅剩一种登录方式时不能解绑', content: errorContent },
    500: { description: '内部错误', content: errorContent },
    503: { description: '数据库不可用', content: errorContent },
  },
});
