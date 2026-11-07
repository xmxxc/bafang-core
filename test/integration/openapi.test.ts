import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { createHealthProbe } from '../../src/db';
import type { ErrorResponse } from '../../src/errors';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';

interface OpenApiDoc {
  openapi: string;
  paths: Record<string, { get?: { responses: Record<string, unknown> }; post?: unknown }>;
  components: {
    schemas: Record<
      string,
      { properties?: { error?: { properties?: { code?: { enum?: string[] } } } } }
    >;
  };
}

describe('GET /v1/openapi over in-process HTTP against a real PostgreSQL test database', () => {
  let db: TestSchema;

  beforeEach(async () => {
    db = await createTestSchema();
  });

  afterEach(async () => {
    await dropTestSchema(db);
  });

  it('serves a generated OpenAPI document exposing health and the error schema', async () => {
    const app = createApp({ db: createHealthProbe(db.pool) });
    const res = await app.request('/v1/openapi');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as OpenApiDoc;
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.paths['/v1/health']).toBeDefined();
    expect(doc.components.schemas.Error).toBeDefined();
    expect(doc.components.schemas.Health).toBeDefined();
  });

  it('lists the shared error codes in the Error schema', async () => {
    const app = createApp({ db: createHealthProbe(db.pool) });
    const res = await app.request('/v1/openapi');
    const doc = (await res.json()) as OpenApiDoc;
    const codes = doc.components.schemas.Error?.properties?.error?.properties?.code?.enum;
    expect(codes).toEqual([
      'database_unavailable',
      'not_found',
      'internal_error',
      'validation_error',
      'fund_not_found',
      'upstream_unavailable',
      'rate_limited',
      'unauthorized',
      'verification_code_expired',
      'verification_code_invalid',
      'verification_code_used',
      'verification_code_max_attempts',
      'email_code_cooldown',
      'email_code_daily_limit',
    ]);
  });

  it('documents the fund search and basic info routes with their error responses', async () => {
    const app = createApp({ db: createHealthProbe(db.pool) });
    const res = await app.request('/v1/openapi');
    const doc = (await res.json()) as OpenApiDoc;
    const search = doc.paths['/v1/funds/search']?.get?.responses;
    const detail = doc.paths['/v1/funds/{code}']?.get?.responses;
    for (const status of ['200', '400', '429', '500', '502']) {
      expect(search?.[status]).toBeDefined();
      expect(detail?.[status]).toBeDefined();
    }
    expect(detail?.['404']).toBeDefined();
    for (const name of ['FundSummary', 'FundSearchResult', 'FundDetail']) {
      expect(doc.components.schemas[name]).toBeDefined();
    }
  });

  it('documents the batch estimate route with its explicit statuses', async () => {
    const app = createApp({ db: createHealthProbe(db.pool) });
    const res = await app.request('/v1/openapi');
    const doc = (await res.json()) as OpenApiDoc;
    const responses = doc.paths['/v1/funds/estimates']?.get?.responses;
    for (const status of ['200', '400', '429', '500']) {
      expect(responses?.[status]).toBeDefined();
    }
    for (const name of ['EstimateBatch', 'EstimateItem', 'Estimate']) {
      expect(doc.components.schemas[name]).toBeDefined();
    }
    const item = doc.components.schemas.EstimateItem as {
      properties: { status: { enum: string[] } };
    };
    expect(item.properties.status.enum).toEqual([
      'estimated',
      'unavailable',
      'pre_market',
      'holiday',
    ]);
  });

  it('declares error responses on the health route', async () => {
    const app = createApp({ db: createHealthProbe(db.pool) });
    const res = await app.request('/v1/openapi');
    const doc = (await res.json()) as OpenApiDoc;
    const responses = doc.paths['/v1/health']?.get?.responses;
    expect(responses?.['500']).toBeDefined();
    expect(responses?.['503']).toBeDefined();
  });

  it('documents the auth routes with their error responses', async () => {
    const app = createApp({ db: createHealthProbe(db.pool) });
    const res = await app.request('/v1/openapi');
    const doc = (await res.json()) as OpenApiDoc;
    expect(doc.paths['/v1/auth/email/request']?.post).toBeDefined();
    expect(doc.paths['/v1/auth/email/login']?.post).toBeDefined();
    expect(doc.paths['/v1/auth/logout']?.post).toBeDefined();
    expect(doc.paths['/v1/me']?.get).toBeDefined();
    for (const name of ['EmailCodeRequestResult', 'EmailLoginResult', 'LoginMethod', 'Me']) {
      expect(doc.components.schemas[name]).toBeDefined();
    }
  });

  it('returns a unified 404 for unknown routes', async () => {
    const app = createApp({ db: createHealthProbe(db.pool) });
    const res = await app.request('/nope');
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error.code).toBe('not_found');
  });
});
