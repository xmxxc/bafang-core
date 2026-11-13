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

// Resolve a local JSON Pointer (RFC 6901), including pointers into paths, properties and allOf.
function resolve(doc: OpenApiDoc, ref: string): JsonSchema {
  const entry = ref
    .slice(2)
    .split('/')
    .map((key) => key.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], doc);
  if (entry === undefined) throw new Error(`unresolved pointer ${ref}`);
  return entry as JsonSchema;
}

// Consume only the HTTP document, without importing the server's Zod schemas.
function consumer(doc: OpenApiDoc, schema: JsonSchema) {
  const entry = schema.$ref ? resolve(doc, schema.$ref) : schema;
  // Move OpenAPI components to JSON Schema's standard definition container.
  const jsonSchema = JSON.parse(
    JSON.stringify({ ...entry, $defs: doc.components.schemas }).replaceAll(
      '#/components/schemas/',
      '#/$defs/',
    ),
  ) as JsonSchema;
  return z.fromJSONSchema(jsonSchema);
}

const escape = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');
const typesOf = (schema: Record<string, unknown>) =>
  [schema.type].flat().filter((type): type is string => typeof type === 'string');

/**
 * Every schema that admits null, wherever it sits: component properties, allOf branches, nested
 * inline objects and inline response schemas under paths. Example payloads are not schemas.
 */
function nullablePointers(doc: OpenApiDoc): string[] {
  const found: string[] = [];
  const walk = (node: unknown, pointer: string) => {
    if (Array.isArray(node)) return node.forEach((item, i) => walk(item, `${pointer}/${i}`));
    if (!node || typeof node !== 'object') return;
    const schema = node as Record<string, unknown>;
    const branches = [schema.anyOf, schema.oneOf].flat() as (Record<string, unknown> | undefined)[];
    if (typesOf(schema).includes('null') || branches.some((b) => b && typesOf(b).includes('null')))
      found.push(pointer);
    for (const [key, value] of Object.entries(schema))
      if (key !== 'example' && key !== 'examples') walk(value, `${pointer}/${escape(key)}`);
  };
  walk(doc.components.schemas, '#/components/schemas');
  walk(doc.paths, '#/paths');
  return found;
}

// A JSON value whose type the nullable schema does not admit.
function wrongType(doc: OpenApiDoc, schema: JsonSchema): unknown {
  const s = schema as Record<string, unknown>;
  const branches = ([s.anyOf, s.oneOf].flat().filter(Boolean) as JsonSchema[]).map((b) =>
    b.$ref ? resolve(doc, b.$ref) : b,
  ) as Record<string, unknown>[];
  const types = new Set([s, ...branches].flatMap(typesOf));
  if (types.has('integer')) types.add('number');
  const candidates: [string, unknown][] = [
    ['boolean', false],
    ['number', 0],
    ['string', '0'],
    ['object', {}],
    ['array', []],
  ];
  return candidates.find(([type]) => !types.has(type))![1];
}

const INTRADAY =
  '#/paths/~1v1~1funds~1{code}~1estimates~1intraday/get/responses/200/content/application~1json/schema';

describe('OpenAPI 3.1 nullable contracts over HTTP with real PostgreSQL', () => {
  let db: TestSchema;
  beforeEach(async () => {
    db = await createTestSchema();
  });
  afterEach(async () => {
    await dropTestSchema(db);
  });

  it('discovers every nullable schema in the document, including references, allOf and inline path schemas, and each accepts null and rejects a wrong type', async () => {
    const app = createApp({ db: createHealthProbe(db.pool) });
    const res = await app.request('/v1/openapi');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as OpenApiDoc;
    expect(doc.openapi).toBe('3.1.0');
    expect(JSON.stringify(doc)).not.toContain('"nullable":');

    // Auto-discovered, so a nullable field added later is covered without editing this test.
    const discovered = nullablePointers(doc);
    // Floor list guarding the discovery itself: every nullable field on main when #78 landed.
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
      FundTopHolding: [
        'quote',
        'quote/properties/price',
        'quote/properties/prevClose',
        'quote/properties/change',
        'quote/properties/changePercent',
        'quote/properties/tradeDate',
        'quote/properties/quoteTime',
        'quoteSource',
      ],
      Estimate: [
        'calculation/properties/reportDate',
        'calculation/properties/parentEtfCode',
        'calculation/properties/quoteTimeEnd',
      ],
    };
    const expected = Object.entries(fields).flatMap(([name, names]) =>
      names.map((field) => `#/components/schemas/${name}/properties/${field}`),
    );
    expected.push(
      '#/components/schemas/Estimate',
      '#/components/schemas/FundPositionSummary/allOf/1/properties/unitPrice',
      '#/components/schemas/OverviewPosition/allOf/1/properties/fundName',
      '#/components/schemas/OverviewPosition/allOf/1/properties/channelName',
      `${INTRADAY}/properties/calculation`,
      `${INTRADAY}/properties/calculation/properties/reportDate`,
      `${INTRADAY}/properties/calculation/properties/parentEtfCode`,
      `${INTRADAY}/properties/calculation/properties/quoteTimeEnd`,
      '#/paths/~1v1~1auth~1wechat~1qr~1{ticketId}/get/responses/200/content/application~1json/schema/anyOf/1/allOf/1/properties/token',
    );
    expect(discovered).toEqual(expect.arrayContaining(expected));
    // Referencing pointers reach the nullable component through the consumer's $ref resolution.
    const refs = [...discovered, '#/components/schemas/EstimateItem/properties/estimate'];
    for (const ref of refs) {
      const schema = consumer(doc, { $ref: ref });
      const parsed = schema.safeParse(null);
      expect(parsed.success, ref).toBe(true);
      if (parsed.success) expect(parsed.data).toBeNull();
      const target = resolve(doc, ref);
      const wrong = wrongType(doc, target.$ref ? resolve(doc, target.$ref) : target);
      expect(schema.safeParse(wrong).success, `${ref} rejects ${JSON.stringify(wrong)}`).toBe(
        false,
      );
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

  it('retains nullable enum, pattern, date-time, UUID and referenced object constraints', async () => {
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
      ['FundTopHolding/properties/quoteSource', 'ths', 'sina'],
      ['FundTopHolding/properties/quote/properties/price', '12.30', '12.3'],
      ['FundTopHolding/properties/quote/properties/prevClose', '-0.50', '0.5'],
      ['FundTopHolding/properties/quote/properties/change', '1.20', '1.205'],
      ['FundTopHolding/properties/quote/properties/changePercent', -1.1, '-1.1'],
      ['FundTopHolding/properties/quote/properties/tradeDate', '2026-11-06', 20261106],
      ['FundTopHolding/properties/quote/properties/quoteTime', '2026-11-06T02:00:00Z', 0],
      ['Estimate/properties/calculation/properties/parentEtfCode', '510300', '51030'],
      [
        'Estimate/properties/calculation/properties/quoteTimeEnd',
        '2026-11-06T02:00:00Z',
        'invalid',
      ],
      ['Estimate/properties/calculation/properties/reportDate', '2026-09-30', 20260930],
    ];
    for (const [path, valid, invalid] of cases) {
      const schema = consumer(doc, { $ref: `#/components/schemas/${path}` });
      expect(schema.safeParse(valid).success, path).toBe(true);
      expect(schema.safeParse(invalid).success, path).toBe(false);
    }

    // Whole objects that carry nullable fields keep their required keys, patterns and enums.
    const quote = {
      price: '12.30',
      prevClose: '12.00',
      change: '0.30',
      changePercent: 2.5,
      tradeDate: '2026-11-06',
      quoteTime: '2026-11-06T02:00:00Z',
    };
    const nullQuote = Object.fromEntries(Object.keys(quote).map((key) => [key, null]));
    const holding = {
      name: '贵州茅台',
      code: '600519',
      weight: 9.5,
      reportDate: '2026-09-30',
      quote,
      quoteSource: 'tencent',
      quoteFallback: false,
    };
    const calculation = {
      method: 'top_holdings',
      reportDate: '2026-09-30',
      disclosedWeightPercent: 55.2,
      parentEtfCode: null,
      quoteTimeEnd: '2026-11-06T02:00:00Z',
      quoteSource: 'tencent',
    };
    const parentEtf = {
      ...calculation,
      method: 'parent_etf',
      reportDate: null,
      parentEtfCode: '510300',
      quoteTimeEnd: null,
    };
    const without = (value: Record<string, unknown>, key: string) =>
      Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
    const objects: [string, unknown[], unknown[]][] = [
      [
        '#/components/schemas/FundTopHolding',
        [holding, { ...holding, quote: null, quoteSource: null }, { ...holding, quote: nullQuote }],
        [
          ...['quote', 'quoteSource', 'quoteFallback'].map((key) => without(holding, key)),
          { ...holding, quoteSource: 'sina' },
          { ...holding, quote: without(quote, 'quoteTime') },
          { ...holding, quote: { ...quote, price: '12.3' } },
          { ...holding, reportDate: '2026/09/30' },
        ],
      ],
      ...[
        '#/components/schemas/Estimate/properties/calculation',
        `${INTRADAY}/properties/calculation`,
      ].map((ref): [string, unknown[], unknown[]] => [
        ref,
        [calculation, parentEtf, without(calculation, 'quoteSource')],
        [
          ...[
            'method',
            'reportDate',
            'disclosedWeightPercent',
            'parentEtfCode',
            'quoteTimeEnd',
          ].map((key) => without(calculation, key)),
          { ...calculation, method: 'other' },
          { ...calculation, quoteSource: null },
          { ...parentEtf, parentEtfCode: '51030' },
          { ...calculation, quoteTimeEnd: 'invalid' },
        ],
      ]),
      [
        '#/components/schemas/UpstreamStatus',
        [{ lastSuccessAt: null }, { lastSuccessAt: '2026-11-06T02:00:00Z' }],
        [{}, { lastSuccessAt: 'invalid' }],
      ],
    ];
    for (const [ref, valid, invalid] of objects) {
      const schema = consumer(doc, { $ref: ref });
      for (const value of valid) expect(schema.safeParse(value).success, ref).toBe(true);
      for (const value of invalid)
        expect(schema.safeParse(value).success, `${ref} rejects ${JSON.stringify(value)}`).toBe(
          false,
        );
    }
  });

  it('accepts the actual health response whose upstreams have never succeeded (null lastSuccessAt)', async () => {
    const app = createApp({ db: createHealthProbe(db.pool) });
    const doc = (await (await app.request('/v1/openapi')).json()) as OpenApiDoc;
    const healthConsumer = consumer(
      doc,
      doc.paths['/v1/health']!.get.responses['200']!.content['application/json']!.schema,
    );
    const res = await app.request('/v1/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { upstreams: Record<string, unknown> };
    const upstreams = ['eastmoney', 'tiantian', 'sina', 'tencent', 'ths'];
    expect(body.upstreams).toEqual(
      Object.fromEntries(upstreams.map((name) => [name, { lastSuccessAt: null }])),
    );
    expect(healthConsumer.parse(body)).toEqual(body);
    for (const name of upstreams) {
      const others = { ...body.upstreams };
      delete others[name];
      expect(healthConsumer.safeParse({ ...body, upstreams: others }).success, name).toBe(false);
      expect(
        healthConsumer.safeParse({ ...body, upstreams: { ...body.upstreams, [name]: {} } }).success,
        name,
      ).toBe(false);
    }
  });
});
