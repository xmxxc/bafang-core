import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { loadConfig, toDbConfig } from '../../src/config';
import { createPool, migrateSchema, MIGRATIONS_FOLDER } from '../../src/db';

export interface TestSchema {
  pool: Pool;
  schema: string;
}

export async function createTestSchema(): Promise<TestSchema> {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const pool = createPool({ ...toDbConfig(loadConfig()), schema });
  await migrateSchema(pool, MIGRATIONS_FOLDER, schema);
  return { pool, schema };
}

export async function dropTestSchema(testSchema: TestSchema): Promise<void> {
  await testSchema.pool.query(`DROP SCHEMA IF EXISTS "${testSchema.schema}" CASCADE`);
  await testSchema.pool.end();
}
