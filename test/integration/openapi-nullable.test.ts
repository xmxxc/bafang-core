import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp } from '../../src/app';
import { createHealthProbe } from '../../src/db';
import { RecordedUpstream } from '../support/recorded-upstream';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';

type JsonSchema = z.core.JSONSchema.JSONSchema;
interface OpenApiDoc {
  openapi: string;
  components: { schemas: Record<string, JsonSchema> };
  paths: Record<
    string,
    { get: { responses: Record<string, { content: Record<string, { schema: JsonSchema }> }> } }
  >;
}

// Consume only the HTTP document, without importing the server's Zod schemas.
function consumer(doc: OpenApiDoc, schema: JsonSchema) {
  // Resolve the entry pointer, including pointers into properties/allOf.
  const entry = schema.$ref
    ? (schema.$ref
        .slice(2)
        .split('/')
        .reduce<unknown>(
          (value, key) => (value as Record<string, unknown>)[key],
          doc,
        ) as JsonSchema)
    : schema;
  // Move OpenAPI components to JSON Schema's standard definition container.
  const jsonSchema = JSON.parse(
    JSON.stringify({ ...entry, $defs: doc.components.schemas }).replaceAll(
      '#/components/schemas/',
      '#/$defs/',
    ),
  ) as JsonSchema;
  return z.fromJSONSchema(jsonSchema);
}

describe('OpenAPI 3.1 nullable contracts over HTTP with real PostgreSQL', () => {
  let db: TestSchema;
  beforeEach(async () => {
    db = await createTestSchema();
  });
  afterEach(async () => {
    await dropTestSchema(db);
  });

  it('exposes every nullable schema to JSON Schema consumers, including references and inline schemas', async () => {
    const app = createApp({ db: createHealthProbe(db.pool) });
    const res = await app.request('/v1/openapi');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as OpenApiDoc;
    expect(doc.openapi).toBe('3.1.0');
    expect(JSON.stringify(doc)).not.toContain('"nullable":');

    const fields: Record<string, string[]> = {
      FundSummary: ['type'],
      LatestNav: ['cumulativeNav', 'dailyChange'],
      NavPoint: ['cumulativeNav', 'dailyChange'],
      MarketIndex: [
        'point',
        'prevClose',
        'change',
        'changePercent',
        'tradeDate',
        'quoteTime',
        'source',
      ],
      Position: [
        'todayGain',
        'todayGainRate',
        'previousMarketValue',
        'totalGain',
        'unitPrice',
        'nav',
        'navDate',
        'marketValue',
        'holdingGain',
        'holdingGainRate',
      ],
      PositionSummary: [
        'todayGain',
        'todayGainRate',
        'previousMarketValue',
        'totalGain',
        'totalAssets',
        'holdingGain',
        'holdingGainRate',
      ],
      OverviewQuote: [
        'direction',
        'value',
        'changePercent',
        'date',
        'time',
        'source',
        'sourceName',
      ],
      Trade: ['positionId', 'amount', 'shares', 'confirmedNav', 'confirmedShares', 'switchId'],
      EmailLoginResult: ['token'],
      UpstreamStatus: ['lastSuccessAt'],
    };
    const refs = Object.entries(fields).flatMap(([name, names]) =>
      names.map((field) => `#/components/schemas/${name}/properties/${field}`),
    );
    refs.push(
      '#/components/schemas/EstimateItem/properties/estimate',
      '#/components/schemas/FundPositionSummary/allOf/1/properties/unitPrice',
      '#/components/schemas/OverviewPosition/allOf/1/properties/fundName',
      '#/components/schemas/OverviewPosition/allOf/1/properties/channelName',
    );
    for (const ref of refs) {
      const parsed = consumer(doc, { $ref: ref }).safeParse(null);
      expect(parsed.success, ref).toBe(true);
      if (parsed.success) expect(parsed.data).toBeNull();
      expect(consumer(doc, { $ref: ref }).safeParse(false).success, ref).toBe(false);
    }

    const poll =
      doc.paths['/v1/auth/wechat/qr/{ticketId}']!.get.responses['200']!.content['application/json']!
        .schema;
    const qrConsumer = consumer(doc, poll);
    const confirmed = {
      status: 'confirmed',
      user: { id: 'user-id' },
      session: { device: 'web', expiresAt: '2026-11-07T00:00:00Z' },
      token: null,
    };
    expect(qrConsumer.parse(confirmed)).toEqual(confirmed);
    expect(qrConsumer.safeParse({ ...confirmed, token: 'unexpected' }).success).toBe(false);
  });

  it('accepts actual null NAV responses while retaining numeric, pattern and required constraints', async () => {
    const app = createApp({
      db: createHealthProbe(db.pool),
      clock: { now: () => new Date('2026-11-06T02:00:00Z') },
      upstream: new RecordedUpstream(() =>
        JSON.stringify({
          ErrCode: 0,
          Data: { LSJZList: [{ FSRQ: '2026-11-05', DWJZ: '1.0000' }] },
        }),
      ),
    });
    const doc = (await (await app.request('/v1/openapi')).json()) as OpenApiDoc;
    const navConsumer = consumer(doc, { $ref: '#/components/schemas/LatestNav' });
    const latest = await app.request('/v1/funds/000001/nav');
    expect(latest.status).toBe(200);
    const body = (await latest.json()) as Record<string, unknown>;
    expect(body).toEqual({
      navDate: '2026-11-05',
      unitNav: '1.0000',
      cumulativeNav: null,
      dailyChange: null,
    });
    expect(navConsumer.parse(body)).toEqual(body);
    expect(
      navConsumer.safeParse({ ...body, cumulativeNav: '3.5730', dailyChange: 0 }).success,
    ).toBe(true);
    for (const invalid of [
      { ...body, cumulativeNav: '1.00001' },
      { ...body, cumulativeNav: 1 },
      { ...body, dailyChange: '0' },
      { ...body, unitNav: null },
      { ...body, navDate: 'invalid' },
      { navDate: body.navDate, unitNav: body.unitNav, cumulativeNav: null },
    ])
      expect(navConsumer.safeParse(invalid).success).toBe(false);

    const history = await app.request('/v1/funds/000001/nav/history?range=1m');
    expect(history.status).toBe(200);
    const historyBody = await history.json();
    expect(historyBody).toEqual({
      points: [{ date: '2026-11-05', unitNav: '1.0000', cumulativeNav: null, dailyChange: null }],
    });
    expect(consumer(doc, { $ref: '#/components/schemas/NavHistory' }).parse(historyBody)).toEqual(
      historyBody,
    );
    expect(doc.components.schemas.NavPoint!.properties!.cumulativeNav).toMatchObject({
      description: '累计净值，缺失时为 null',
    });
  });

  it('retains nullable enum, date-time, UUID and referenced object constraints', async () => {
    const app = createApp({ db: createHealthProbe(db.pool) });
    const doc = (await (await app.request('/v1/openapi')).json()) as OpenApiDoc;
    const cases: [string, unknown, unknown][] = [
      ['MarketIndex/properties/source', 'tencent', 'other'],
      ['MarketIndex/properties/point', '3649.18', '3649.123'],
      ['OverviewQuote/properties/direction', 'up', 'sideways'],
      ['OverviewQuote/properties/source', 'eastmoney', 'tencent'],
      ['MarketIndex/properties/quoteTime', '2026-11-06T02:00:00Z', 'invalid'],
      ['UpstreamStatus/properties/lastSuccessAt', '2026-11-06T02:00:00Z', 'invalid'],
      ['Trade/properties/positionId', '550e8400-e29b-41d4-a716-446655440000', 'invalid'],
      [
        'EstimateItem/properties/estimate',
        {
          changePercent: -1.44,
          value: '1.6785',
          time: '2026-11-06T02:00:00Z',
          source: 'tiantian',
          sourceName: '天天基金',
          fallback: false,
          referenceOnly: true,
        },
        {},
      ],
    ];
    for (const [path, valid, invalid] of cases) {
      const schema = consumer(doc, { $ref: `#/components/schemas/${path}` });
      expect(schema.safeParse(valid).success, path).toBe(true);
      expect(schema.safeParse(invalid).success, path).toBe(false);
    }
  });
});
