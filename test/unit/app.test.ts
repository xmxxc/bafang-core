import { describe, expect, it } from 'vitest';
import { ChineseTradingCalendar } from '../../src/trading-calendar';
import { SystemClock } from '../../src/clock';
import { createApp, resolveDeps } from '../../src/app';
import type { HealthResponse } from '../../src/routes/health';
import type { ErrorResponse } from '../../src/errors';

const okDb = { ping: async () => true };
const downDb = { ping: async () => false };

interface OpenApiDoc {
  openapi: string;
  paths: Record<string, unknown>;
  components: { schemas: Record<string, unknown> };
}

describe('resolveDeps', () => {
  it('uses injected clock and trading calendar over defaults', () => {
    const clock = { now: () => new Date(0) };
    const tradingCalendar = { isTradingDay: () => true };
    const resolved = resolveDeps({ clock, tradingCalendar });
    expect(resolved.clock).toBe(clock);
    expect(resolved.tradingCalendar).toBe(tradingCalendar);
  });

  it('falls back to system clock and Chinese trading calendar', () => {
    const resolved = resolveDeps();
    expect(resolved.clock).toBeInstanceOf(SystemClock);
    expect(resolved.tradingCalendar).toBeInstanceOf(ChineseTradingCalendar);
    expect(resolved.db).toBeUndefined();
  });
});

describe('GET /health', () => {
  it('returns ok with the injected clock time when the database is up', async () => {
    const fixed = new Date('2024-01-02T03:04:05.000Z');
    const app = createApp({ db: okDb, clock: { now: () => fixed } });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    expect(body.status).toBe('ok');
    expect(body.database.connected).toBe(true);
    expect(body.time).toBe(fixed.toISOString());
  });

  it('returns 503 with the unified error structure when the database is down', async () => {
    const app = createApp({ db: downDb });
    const res = await app.request('/health');
    expect(res.status).toBe(503);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error.code).toBe('database_unavailable');
    expect(typeof body.error.message).toBe('string');
  });
});

describe('GET /openapi', () => {
  it('serves a generated OpenAPI document exposing health and the error schema', async () => {
    const app = createApp({ db: okDb });
    const res = await app.request('/openapi');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as OpenApiDoc;
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.paths['/health']).toBeDefined();
    expect(doc.components.schemas.Error).toBeDefined();
    expect(doc.components.schemas.Health).toBeDefined();
  });
});

describe('unified errors', () => {
  it('returns a unified 404 for unknown routes', async () => {
    const app = createApp({ db: okDb });
    const res = await app.request('/nope');
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error.code).toBe('not_found');
  });
});
