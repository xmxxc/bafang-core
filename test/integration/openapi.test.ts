import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { createHealthProbe } from '../../src/db';
import type { ErrorResponse } from '../../src/errors';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';

interface OpenApiDoc {
  openapi: string;
  paths: Record<
    string,
    Partial<
      Record<
        'get' | 'post' | 'patch' | 'put' | 'delete',
        {
          responses: Record<string, unknown>;
          security?: Record<string, string[]>[];
        }
      >
    >
  >;
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
      'wechat_not_configured',
      'wechat_code_invalid',
      'wechat_unavailable',
      'github_not_configured',
      'github_state_invalid',
      'github_authorization_failed',
      'github_unavailable',
      'verification_code_expired',
      'verification_code_invalid',
      'verification_code_used',
      'verification_code_max_attempts',
      'email_code_cooldown',
      'email_code_daily_limit',
      'channel_name_conflict',
      'channel_protected',
      'channel_has_positions',
      'login_method_conflict',
      'login_method_type_conflict',
      'login_method_last',
      'login_method_not_found',
      'position_exists',
      'trade_not_cancellable',
    ]);
  });

  it('documents the position routes with their status codes', async () => {
    const app = createApp({ db: createHealthProbe(db.pool) });
    const doc = (await (await app.request('/v1/openapi')).json()) as OpenApiDoc;
    const list = doc.paths['/v1/positions'];
    const item = doc.paths['/v1/positions/{id}'];
    const expected: [Record<string, unknown> | undefined, string[]][] = [
      [list?.get?.responses, ['200', '400', '401', '404', '500', '503']],
      [list?.post?.responses, ['201', '400', '401', '404', '409', '500', '502', '503']],
      [item?.get?.responses, ['200', '400', '401', '404', '500', '503']],
      [item?.patch?.responses, ['200', '400', '401', '404', '500', '503']],
      [item?.delete?.responses, ['204', '400', '401', '404', '500', '503']],
    ];
    for (const [responses, statuses] of expected) {
      expect(Object.keys(responses ?? {}).sort()).toEqual([...statuses].sort());
    }
    expect(JSON.stringify(list?.post?.responses?.['409'])).toContain('position_exists');
    expect(JSON.stringify(list?.post?.responses?.['404'])).toContain('fund_not_found');
    for (const name of ['Position', 'PositionList', 'PositionCreate', 'PositionCalibrate']) {
      expect(doc.components.schemas[name]).toBeDefined();
    }
  });

  it('documents trade operations, status codes, session requirements and schemas', async () => {
    const app = createApp({ db: createHealthProbe(db.pool) });
    const doc = (await (await app.request('/v1/openapi')).json()) as OpenApiDoc;
    const list = doc.paths['/v1/positions/{id}/trades'];
    const item = doc.paths['/v1/positions/{id}/trades/{tradeId}'];
    const expected = [
      [list?.get, ['200', '400', '401', '404', '500', '503']],
      [list?.post, ['201', '400', '401', '404', '500', '502', '503']],
      [item?.delete, ['204', '400', '401', '404', '409', '500', '503']],
    ] as const;
    for (const [operation, statuses] of expected) {
      expect(Object.keys(operation?.responses ?? {}).sort()).toEqual([...statuses].sort());
      expect(operation?.security).toEqual([{ SessionCookie: [] }, { SessionBearer: [] }]);
    }
    expect(JSON.stringify(item?.delete?.responses['409'])).toContain('trade_not_cancellable');
    for (const name of ['BuyTradeCreate', 'Trade', 'TradeList']) {
      expect(doc.components.schemas[name]).toBeDefined();
    }
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

  it('documents every channel operation, session requirement and business errors', async () => {
    const app = createApp({ db: createHealthProbe(db.pool) });
    const res = await app.request('/v1/openapi');
    const doc = (await res.json()) as OpenApiDoc;
    const operations = [
      doc.paths['/v1/channels']?.get,
      doc.paths['/v1/channels']?.post,
      doc.paths['/v1/channels/{id}']?.patch,
      doc.paths['/v1/channels/{id}']?.delete,
      doc.paths['/v1/channels/order']?.put,
    ];
    for (const operation of operations) {
      expect(operation).toBeDefined();
      for (const status of ['401', '500', '503']) {
        expect(operation?.responses[status]).toBeDefined();
      }
      expect(operation?.security).toEqual([{ SessionCookie: [] }, { SessionBearer: [] }]);
    }
    expect(doc.paths['/v1/channels']?.post?.responses['409']).toBeDefined();
    expect(doc.paths['/v1/channels/{id}']?.patch?.responses['409']).toBeDefined();
    expect(doc.paths['/v1/channels/{id}']?.delete?.responses['409']).toBeDefined();
    expect(doc.components.schemas.Channel).toBeDefined();
    expect(doc.components.schemas.ChannelList).toBeDefined();
  });

  it('returns a unified 404 for unknown routes', async () => {
    const app = createApp({ db: createHealthProbe(db.pool) });
    const res = await app.request('/nope');
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error.code).toBe('not_found');
  });
});
