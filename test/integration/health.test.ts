import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { loadConfig, toDbConfig } from '../../src/config';
import { createHealthProbe, createPool } from '../../src/db';
import type { HealthResponse } from '../../src/routes/health';
import type { ErrorResponse } from '../../src/errors';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';

describe('GET /v1/health over in-process HTTP against a real PostgreSQL test database', () => {
  let db: TestSchema;

  beforeEach(async () => {
    db = await createTestSchema();
  });

  afterEach(async () => {
    await dropTestSchema(db);
  });

  it('reports ok with database connectivity and the injected clock time', async () => {
    const fixed = new Date('2024-01-02T03:04:05.000Z');
    const app = createApp({
      db: createHealthProbe(db.pool),
      clock: { now: () => fixed },
      tradingCalendar: { isTradingDay: () => false },
    });
    const res = await app.request('/v1/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    expect(body.status).toBe('ok');
    expect(body.database.connected).toBe(true);
    expect(body.time).toBe(fixed.toISOString());
  });

  it('uses the default system clock when none is injected', async () => {
    const before = Date.now();
    const app = createApp({ db: createHealthProbe(db.pool) });
    const res = await app.request('/v1/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    const time = new Date(body.time).getTime();
    expect(time).toBeGreaterThanOrEqual(before);
    expect(time).toBeLessThanOrEqual(Date.now());
  });

  it('returns the unified 503 error when the database is unavailable', async () => {
    const closedPool = createPool(toDbConfig(loadConfig()));
    await closedPool.end();
    const app = createApp({ db: createHealthProbe(closedPool) });
    const res = await app.request('/v1/health');
    expect(res.status).toBe(503);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error.code).toBe('database_unavailable');
    expect(typeof body.error.message).toBe('string');
  });

  it('returns the unified 500 error when the injected clock throws', async () => {
    const app = createApp({
      db: createHealthProbe(db.pool),
      clock: {
        now: () => {
          throw new Error('boom');
        },
      },
    });
    const res = await app.request('/v1/health');
    expect(res.status).toBe(500);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error.code).toBe('internal_error');
    expect(typeof body.error.message).toBe('string');
  });
});
