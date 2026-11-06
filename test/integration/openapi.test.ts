import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createApp } from '../../src/app';
import { loadConfig, toDbConfig } from '../../src/config';
import { createHealthProbe, createPool, migrateSchema, MIGRATIONS_FOLDER } from '../../src/db';
import type { ErrorResponse } from '../../src/errors';

interface OpenApiDoc {
  openapi: string;
  paths: Record<string, { get?: { responses: Record<string, unknown> } }>;
  components: {
    schemas: Record<
      string,
      { properties?: { error?: { properties?: { code?: { enum?: string[] } } } } }
    >;
  };
}

describe('GET /openapi over in-process HTTP against a real PostgreSQL test database', () => {
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

  it('serves a generated OpenAPI document exposing health and the error schema', async () => {
    const app = createApp({ db: createHealthProbe(pool) });
    const res = await app.request('/openapi');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as OpenApiDoc;
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.paths['/health']).toBeDefined();
    expect(doc.components.schemas.Error).toBeDefined();
    expect(doc.components.schemas.Health).toBeDefined();
  });

  it('lists the shared error codes in the Error schema', async () => {
    const app = createApp({ db: createHealthProbe(pool) });
    const res = await app.request('/openapi');
    const doc = (await res.json()) as OpenApiDoc;
    const codes = doc.components.schemas.Error?.properties?.error?.properties?.code?.enum;
    expect(codes).toEqual([
      'database_unavailable',
      'not_found',
      'internal_error',
      'validation_error',
    ]);
  });

  it('declares error responses on the health route', async () => {
    const app = createApp({ db: createHealthProbe(pool) });
    const res = await app.request('/openapi');
    const doc = (await res.json()) as OpenApiDoc;
    const responses = doc.paths['/health']?.get?.responses;
    expect(responses?.['500']).toBeDefined();
    expect(responses?.['503']).toBeDefined();
  });

  it('returns a unified 404 for unknown routes', async () => {
    const app = createApp({ db: createHealthProbe(pool) });
    const res = await app.request('/nope');
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error.code).toBe('not_found');
  });
});
