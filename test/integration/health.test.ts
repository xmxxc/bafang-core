import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createApp } from '../../src/app';
import { loadConfig, toDbConfig } from '../../src/config';
import { createHealthProbe, createPool, migrateSchema, MIGRATIONS_FOLDER } from '../../src/db';
import type { HealthResponse } from '../../src/routes/health';

describe('health (integration, real PostgreSQL)', () => {
  let pool: Pool;
  let schema: string;

  beforeEach(async () => {
    schema = `test_${randomUUID().replaceAll('-', '')}`;
    pool = createPool(toDbConfig(loadConfig()));
    await migrateSchema(pool, MIGRATIONS_FOLDER, schema);
    await migrateSchema(pool, MIGRATIONS_FOLDER, schema);
  });

  afterEach(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it('migration builds the initial structure in an empty schema', async () => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'app_meta'`,
      [schema],
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('migration is idempotent: re-running records exactly one applied migration', async () => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM "${schema}"."__drizzle_migrations"`,
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('serves /health with ok and database connectivity through in-process HTTP', async () => {
    const app = createApp({ db: createHealthProbe(pool) });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    expect(body.status).toBe('ok');
    expect(body.database.connected).toBe(true);
    expect(body.time).toBeTruthy();
  });
});
