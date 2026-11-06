import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createApp } from '../../src/app';
import { loadConfig, toDbConfig } from '../../src/config';
import { createHealthProbe, createPool, migrateSchema, MIGRATIONS_FOLDER } from '../../src/db';
import type { HealthResponse } from '../../src/routes/health';
import type { ErrorResponse } from '../../src/errors';

describe('GET /health over in-process HTTP against a real PostgreSQL test database', () => {
  let pool: Pool;
  let schema: string;

  beforeEach(async () => {
    schema = `test_${randomUUID().replaceAll('-', '')}`;
    pool = createPool(toDbConfig(loadConfig()));
    await migrateSchema(pool, MIGRATIONS_FOLDER, schema);
  });

  afterEach(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it('reports ok with database connectivity and the injected clock time', async () => {
    const fixed = new Date('2024-01-02T03:04:05.000Z');
    const app = createApp({
      db: createHealthProbe(pool),
      clock: { now: () => fixed },
      tradingCalendar: { isTradingDay: () => false },
    });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    expect(body.status).toBe('ok');
    expect(body.database.connected).toBe(true);
    expect(body.time).toBe(fixed.toISOString());
  });

  it('uses the default system clock when none is injected', async () => {
    const before = Date.now();
    const app = createApp({ db: createHealthProbe(pool) });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    const time = new Date(body.time).getTime();
    expect(time).toBeGreaterThanOrEqual(before);
    expect(time).toBeLessThanOrEqual(Date.now());
  });

  it('returns the unified 503 error when the database is unavailable', async () => {
    const app = createApp({ db: { ping: async () => false } });
    const res = await app.request('/health');
    expect(res.status).toBe(503);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error.code).toBe('database_unavailable');
    expect(typeof body.error.message).toBe('string');
  });

  it('returns the unified 500 error when the probe throws', async () => {
    const app = createApp({
      db: {
        ping: async () => {
          throw new Error('boom');
        },
      },
    });
    const res = await app.request('/health');
    expect(res.status).toBe(500);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error.code).toBe('internal_error');
    expect(typeof body.error.message).toBe('string');
  });
});
