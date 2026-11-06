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
