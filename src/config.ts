import 'dotenv/config';
import { z } from 'zod';
import type { DbConfig } from './db';

export const DEFAULT_SETTLEMENT_ROUNDS = '21:30,22:30,23:30';

const EnvSchema = z.object({
  PGHOST: z.string().default('localhost'),
  PGPORT: z.coerce.number().int().default(5432),
  PGUSER: z.string().default('test_bafang'),
  PGPASSWORD: z.string(),
  PGDATABASE: z.string().default('test_bafang'),
  PGSCHEMA: z.string().optional(),
  PORT: z.coerce.number().int().default(3000),
  /** 上海时间的交易确认轮次，逗号分隔，例如 21:30,22:30,23:30。 */
  SETTLEMENT_ROUNDS: z.string().default(DEFAULT_SETTLEMENT_ROUNDS),
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
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return EnvSchema.parse(env);
}

/** 把配置中的上海时间轮次解析成从午夜起算的分钟数，并拒绝重复/非法时间。 */
export function parseSettlementRunMinutes(value: string): number[] {
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(part))) {
    throw new Error('SETTLEMENT_ROUNDS 必须是逗号分隔的 HH:MM 时间（00:00–23:59）');
  }
  const minutes = parts.map((part) => {
    const [hour, minute] = part.split(':').map(Number);
    return hour! * 60 + minute!;
  });
  const unique = [...new Set(minutes)].sort((a, b) => a - b);
  if (unique.length !== minutes.length) {
    throw new Error('SETTLEMENT_ROUNDS 不能包含重复时间');
  }
  return unique;
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
