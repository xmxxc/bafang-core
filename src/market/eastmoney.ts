import { z } from 'zod';
import { UpstreamError, type UpstreamFetcher } from './upstream';

/** 东方财富上游：基金搜索与基金基础信息。地址属于行情模块内部的实现细节。 */

const REFERER = 'https://fund.eastmoney.com/';
const SEARCH_URL = 'https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx';
const BASE_INFO_URL = 'https://fundmobapi.eastmoney.com/FundMApi/FundBaseTypeInformation.ashx';
const NAV_REFERER = 'https://fundf10.eastmoney.com/';
const NAV_URL = 'https://api.fund.eastmoney.com/f10/lsjz';
const FUND_PAGE_HOST = 'fund.eastmoney.com';

/** 搜索接口里基金条目的 CATEGORY；其余是股票、指数等。 */
const FUND_CATEGORY = 700;

const SearchResponseSchema = z.object({
  ErrCode: z.number(),
  Datas: z
    .array(
      z.object({
        CODE: z.string(),
        NAME: z.string(),
        CATEGORY: z.number().nullish(),
        FundBaseInfo: z.object({ FTYPE: z.string().nullish() }).nullish(),
      }),
    )
    .nullish(),
});

const BaseInfoResponseSchema = z.object({
  ErrCode: z.number(),
  Datas: z
    .object({
      FCODE: z.string(),
      SHORTNAME: z.string(),
      FTYPE: z.string().nullish(),
      SSBCFMDATA: z.union([z.string(), z.number()]).nullish(),
    })
    .nullish(),
});

export interface UpstreamFundHit {
  code: string;
  name: string;
  type: string | null;
}

export interface UpstreamFundBaseInfo {
  code: string;
  name: string;
  type: string | null;
  /** 上游给出的买入确认 T+N 天数；缺失或无法解析时为 null。 */
  confirmDays: number | null;
}

/** 官方基金页“查看相关ETF”关系；页面时间仅是抓取时间，不是报价时间。 */
export async function fetchLinkedEtfCode(
  upstream: UpstreamFetcher,
  code: string,
): Promise<string | null> {
  const text = await upstream.fetchText({
    url: `https://${FUND_PAGE_HOST}/${code}.html`,
    referer: 'https://fund.eastmoney.com/',
  });
  const header =
    /<div class=["']fundDetail-tit["']>([\s\S]*?)<div class=["']fundDetail-tools["']>/.exec(
      text,
    )?.[1];
  if (!header) return null;
  const codes = [...header.matchAll(/<span class=["']ui-num["']>(\d{6})<\/span>/g)].map(
    (m) => m[1],
  );
  if (codes.length !== 1 || codes[0] !== code) return null;
  const links = [
    ...header.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi),
  ].filter((m) => /^查看\s*相关ETF[>＞]?$/i.test(m[2]!.replace(/<[^>]+>/g, '').trim()));
  if (links.length !== 1) return null;
  // The official page still emits http links; only the code is read, and all requests
  // use the fixed HTTPS host. Never navigate to an upstream-provided URL.
  const target = /^https?:\/\/fund\.eastmoney\.com\/(\d{6})\.html$/.exec(links[0]![1]!);
  return target && target[1] !== code ? target[1]! : null;
}

/** 上交所官网 FUND_LIST 明确提供基金类型、细分类型和上市日期。 */
export async function fetchVerifiedEtfCode(
  upstream: UpstreamFetcher,
  code: string,
  asOf: Date,
): Promise<boolean> {
  if (/^1\d{5}$/.test(code)) return verifyShenzhenEtf(upstream, code, asOf);
  if (!/^5\d{5}$/.test(code)) return false;
  const url = new URL('https://query.sse.com.cn/commonSoaQuery.do');
  for (const [key, value] of Object.entries({
    sqlId: 'FUND_LIST',
    fundType: '00',
    fundCode: code,
    isPagination: 'true',
    'pageHelp.pageSize': '100',
    'pageHelp.pageNo': '1',
    // Empty subclass asks the official list for all ETF subclasses (01/03/etc.).
    subClass: '',
  }))
    url.searchParams.set(key, value);
  const body = await upstream.fetchText({ url: url.href, referer: 'https://www.sse.com.cn/' });
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new UpstreamError('bad_response', 'SSE FUND_LIST is not JSON');
  }
  const parsed = z
    .object({
      actionErrors: z.array(z.unknown()),
      result: z.array(
        z.object({
          fundCode: z.string(),
          fundType: z.string(),
          subClass: z.string(),
          listingDate: z.string(),
        }),
      ),
    })
    .safeParse(raw);
  if (!parsed.success || parsed.data.actionErrors.length)
    throw new UpstreamError('bad_response', 'SSE FUND_LIST protocol invalid');
  // Official typeConversion / getFundType: 00 is ETF except monetary funds 05/07.
  // Include every documented domestic ETF class (equity, bonds, gold, commodity).
  // 04/33/34/35 explicitly denote cross-border ETFs: no overseas calendar mapping yet.
  const domesticEtfClasses = new Set([
    '01',
    '02',
    '03',
    '06',
    '08',
    '09',
    '31',
    '32',
    '36',
    '37',
    '38',
  ]);
  return (
    parsed.data.result.length === 1 &&
    parsed.data.result[0]!.fundCode === code &&
    parsed.data.result[0]!.fundType === '00' &&
    domesticEtfClasses.has(parsed.data.result[0]!.subClass) &&
    validListingDate(parsed.data.result[0]!.listingDate, asOf)
  );
}

/** 深交所基金列表：基金类别/投资类别/代码/上市日期均由交易所字段证明。 */
async function verifyShenzhenEtf(
  upstream: UpstreamFetcher,
  code: string,
  asOf: Date,
): Promise<boolean> {
  const url = new URL('https://www.szse.cn/api/report/ShowReport/data');
  for (const [key, value] of Object.entries({
    SHOWTYPE: 'JSON',
    CATALOGID: '1105',
    TABKEY: 'tab1',
    PAGENO: '1',
    txtkey1: code,
    selectJjlb: 'ETF',
    selectTzlb: '',
  }))
    url.searchParams.set(key, value);
  const text = await upstream.fetchText({ url: url.href, referer: 'https://www.szse.cn/' });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new UpstreamError('bad_response', 'SZSE fund list is not JSON');
  }
  const parsed = z
    .array(
      z.object({
        metadata: z.object({ catalogid: z.string(), tabkey: z.string() }),
        data: z.array(
          z.object({ sys_key: z.string(), jjlb: z.string(), tzlb: z.string(), ssrq: z.string() }),
        ),
      }),
    )
    .safeParse(raw);
  if (!parsed.success) throw new UpstreamError('bad_response', 'SZSE fund list protocol invalid');
  const tables = parsed.data.filter(
    (table) => table.metadata.catalogid === '1105' && table.metadata.tabkey === 'tab1',
  );
  if (tables.length !== 1 || tables[0]!.data.length !== 1) return false;
  const row = tables[0]!.data[0]!;
  const identity =
    /^<a href=['"]https?:\/\/www\.szse\.cn\/market\/trend\/index\.html\?code=(\d{6})['"]><u>(\d{6})<\/u><\/a>$/.exec(
      row.sys_key,
    );
  return (
    identity?.[1] === code &&
    identity[2] === code &&
    row.jjlb === 'ETF' &&
    /^\d{4}-\d{2}-\d{2}$/.test(row.ssrq) &&
    validListingDate(row.ssrq.replaceAll('-', ''), asOf)
  );
}

function validListingDate(raw: string, asOf: Date) {
  if (!/^\d{8}$/.test(raw)) return false;
  const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}`;
  const parsed = new Date(`${date}T00:00:00+08:00`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed <= asOf &&
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date
  );
}

export async function searchFunds(
  upstream: UpstreamFetcher,
  keyword: string,
): Promise<UpstreamFundHit[]> {
  const url = new URL(SEARCH_URL);
  url.searchParams.set('m', '1');
  url.searchParams.set('key', keyword);
  const body = parse(
    SearchResponseSchema,
    await upstream.fetchText({ url: url.href, referer: REFERER }),
  );
  const hits = (body.Datas ?? [])
    .filter((item) => item.CATEGORY === FUND_CATEGORY && /^\d{6}$/.test(item.CODE))
    .map((item) => ({
      code: item.CODE,
      name: item.NAME,
      type: item.FundBaseInfo?.FTYPE ?? null,
    }));
  // 无匹配是合法空结果：不算失败，但也没有证明接口给出了可用数据，不刷新成功时间。
  if (hits.some((hit) => hit.name.trim() !== '')) upstream.recordSuccess?.('eastmoney');
  return hits;
}

export async function fetchFundBaseInfo(
  upstream: UpstreamFetcher,
  code: string,
): Promise<UpstreamFundBaseInfo | null> {
  const url = new URL(BASE_INFO_URL);
  url.searchParams.set('FCODE', code);
  url.searchParams.set('deviceid', 'Wap');
  url.searchParams.set('plat', 'Wap');
  url.searchParams.set('product', 'EFund');
  url.searchParams.set('version', '2.0.0');
  const body = parse(
    BaseInfoResponseSchema,
    await upstream.fetchText({ url: url.href, referer: REFERER }),
  );
  const data = body.Datas;
  // 基金不存在（Datas 为空）是合法空结果，不刷新成功时间。
  if (!data) return null;
  if (data.FCODE === code && data.SHORTNAME.trim() !== '') upstream.recordSuccess?.('eastmoney');
  return {
    code: data.FCODE,
    name: data.SHORTNAME,
    type: data.FTYPE ?? null,
    confirmDays: parseConfirmDays(data.SSBCFMDATA),
  };
}

function parseConfirmDays(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const days = Number(value);
  return Number.isInteger(days) && days >= 0 && days <= 30 ? days : null;
}

/**
 * 解析上游响应体。东方财富用 ErrCode 表示业务结果：只有 0 才是正常响应（包括空结果、
 * 基金不存在），非零一律视为上游失败，不论是否带 Datas，避免把上游错误当成「无结果」或缓存下来。
 */
function parse<T extends { ErrCode: number }>(schema: z.ZodType<T>, text: string): T {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UpstreamError('bad_response', 'upstream returned non-JSON body');
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new UpstreamError('bad_response', 'upstream response did not match the expected shape');
  }
  if (result.data.ErrCode !== 0) {
    throw new UpstreamError('bad_response', `upstream returned ErrCode ${result.data.ErrCode}`);
  }
  return result.data;
}

const NavResponseSchema = z.object({
  ErrCode: z.number(),
  Data: z
    .object({
      LSJZList: z
        .array(
          z.object({
            FSRQ: z.string(),
            DWJZ: z.string(),
            LJJZ: z.string().nullish(),
            JZZZL: z.string().nullish(),
          }),
        )
        .nullish(),
    })
    .nullish(),
});

export interface UpstreamNavPoint {
  /** 净值日期，YYYY-MM-DD。 */
  date: string;
  /** 单位净值，保留 4 位小数的字符串。 */
  unitNav: string;
  /** 累计净值，缺失时为 null。 */
  cumulativeNav: string | null;
  /** 当日涨跌幅（百分比），上游缺失或不可解析时为 null。 */
  dailyChange: number | null;
}

/** 抓取一页历史净值（按日期倒序，最新在前）。 */
export async function fetchNavPage(
  upstream: UpstreamFetcher,
  code: string,
  pageIndex: number,
  pageSize: number,
  startDate?: string,
): Promise<UpstreamNavPoint[]> {
  const url = new URL(NAV_URL);
  url.searchParams.set('fundCode', code);
  url.searchParams.set('pageIndex', String(pageIndex));
  url.searchParams.set('pageSize', String(pageSize));
  if (startDate) url.searchParams.set('startDate', startDate);
  const body = parse(
    NavResponseSchema,
    await upstream.fetchText({ url: url.href, referer: NAV_REFERER }),
  );
  const points = (body.Data?.LSJZList ?? []).map((item) => ({
    date: item.FSRQ,
    unitNav: item.DWJZ,
    cumulativeNav: item.LJJZ ?? null,
    dailyChange: parsePercent(item.JZZZL),
  }));
  // 空页是合法空结果；只有每一行的日期与单位净值都合法时才算成功。
  if (points.length > 0 && points.every(isWellFormedNav)) upstream.recordSuccess?.('eastmoney');
  return points;
}

/** 日期必须是真实的日历日期（解析后 ISO 往返一致），单位净值必须是有限正数。 */
function isWellFormedNav(point: UpstreamNavPoint): boolean {
  const unitNav = Number(point.unitNav);
  return (
    isCalendarDate(point.date) &&
    /^\d+(\.\d+)?$/.test(point.unitNav) &&
    Number.isFinite(unitNav) &&
    unitNav > 0
  );
}

function isCalendarDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

/**
 * 解析当日涨跌幅。上游在无前一日净值或数据缺失时会给出 null、缺失、空串或「--」等占位，
 * 这些都不是「涨跌幅为 0」，而是「无涨跌幅」，因此返回 null 以明确区分；真实的 0% 仍是 0。
 */
function parsePercent(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '--') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}
