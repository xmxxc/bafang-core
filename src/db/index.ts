import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool, type QueryConfig } from 'pg';
import * as schema from './schema';

export type DbConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** 可选的 PostgreSQL schema；设置后连接使用该 search_path。 */
  schema?: string;
};

export const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle',
);

/**
 * 建立数据库连接的期限。core 与 PostgreSQL 同在 Compose 内网，正常连接远低于该值；
 * 数据库停止或网络黑洞时，请求在此期限后失败，而不是无限等待。
 */
export const DB_CONNECT_TIMEOUT_MS = 2_000;
/** 健康检查探针 `SELECT 1` 的期限：连接已建立但数据库不再应答时，健康检查据此返回 503。 */
export const HEALTH_PROBE_TIMEOUT_MS = 2_000;

export function createPool(config: DbConfig): Pool {
  const pool = new Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    options: config.schema ? `-c search_path=${config.schema}` : undefined,
    connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
  });
  // 数据库重启或断网时，空闲连接会在连接池上触发 'error'；没有监听器会让整个进程崩溃。
  // 记录后丢弃该连接，后续查询按需重连，健康检查据此如实返回 503。
  pool.on('error', (error) => {
    console.error('[bafang-core] idle database connection error', error.message);
  });
  return pool;
}

export function createDb(pool: Pool) {
  return drizzle(pool, { schema });
}

export type Db = ReturnType<typeof createDb>;

export interface HealthProbe {
  ping(): Promise<boolean>;
}

/**
 * pg 支持逐条查询的 query_timeout（@types/pg 未声明）。超时后 pg-pool 销毁这条连接，
 * 下次检查重新建立。
 */
const HEALTH_PROBE_QUERY: QueryConfig & { query_timeout: number } = {
  text: 'SELECT 1',
  query_timeout: HEALTH_PROBE_TIMEOUT_MS,
};

export function createHealthProbe(pool: Pool): HealthProbe {
  return {
    async ping() {
      try {
        await pool.query(HEALTH_PROBE_QUERY);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export async function migrateSchema(
  pool: Pool,
  migrationsFolder: string,
  schemaName: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await client.query(`SET search_path TO "${schemaName}"`);
    await migrate(drizzle(client), {
      migrationsFolder,
      migrationsSchema: schemaName,
    });
  } finally {
    client.release();
  }
}
