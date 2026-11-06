import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
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

export function createPool(config: DbConfig): Pool {
  return new Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    options: config.schema ? `-c search_path=${config.schema}` : undefined,
  });
}

export function createDb(pool: Pool) {
  return drizzle(pool, { schema });
}

export interface HealthProbe {
  ping(): Promise<boolean>;
}

export function createHealthProbe(pool: Pool): HealthProbe {
  return {
    async ping() {
      try {
        await pool.query('SELECT 1');
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
