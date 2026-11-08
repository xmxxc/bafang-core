import 'dotenv/config';
import { z } from 'zod';
import type { DbConfig } from './db';

const EnvSchema = z.object({
  PGHOST: z.string().default('localhost'),
  PGPORT: z.coerce.number().int().default(5432),
  PGUSER: z.string().default('test_bafang'),
  PGPASSWORD: z.string(),
  PGDATABASE: z.string().default('test_bafang'),
  PGSCHEMA: z.string().optional(),
  PORT: z.coerce.number().int().default(3000),
  /** 运行环境。不设默认值：只有明确等于 development/test 时才允许用开发发信。 */
  NODE_ENV: z.string().optional(),
  /** 发信方式：`dev-log` 表示开发模式假发信（显式开启，只打印到日志）。 */
  MAIL_TRANSPORT: z.string().optional(),
  /** Resend 发信的 API key；空字符串在 `createMailer` 里视为缺失。 */
  RESEND_API_KEY: z.string().optional(),
  /** Resend 发信人地址；配置 RESEND_API_KEY 时必须同时配置。 */
  RESEND_FROM: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GITHUB_CALLBACK_URL: z.string().optional(),
  GITHUB_LOGIN_REDIRECT_URL: z.string().optional(),
  WECHAT_APP_ID: z.string().optional(),
  WECHAT_APP_SECRET: z.string().optional(),
  /** 扫码登录票据有效秒数，默认 5 分钟。 */
  WECHAT_QR_TTL_SECONDS: z.coerce.number().int().min(60).max(600).default(300),
  /** 用于绑定码 HMAC；未配置时由应用提供开发环境默认值。 */
  BIND_CODE_SECRET: z.string().optional(),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return EnvSchema.parse(env);
}

export function toDbConfig(config: Config): DbConfig {
  return {
    host: config.PGHOST,
    port: config.PGPORT,
    user: config.PGUSER,
    password: config.PGPASSWORD,
    database: config.PGDATABASE,
    schema: config.PGSCHEMA,
  };
}
