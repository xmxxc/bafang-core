import { z } from 'zod';
import { UpstreamError, type UpstreamFetcher } from './upstream';

/** 东方财富上游：基金搜索与基金基础信息。地址属于行情模块内部的实现细节。 */

const REFERER = 'https://fund.eastmoney.com/';
const SEARCH_URL = 'https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx';
const BASE_INFO_URL = 'https://fundmobapi.eastmoney.com/FundMApi/FundBaseTypeInformation.ashx';
const NAV_REFERER = 'https://fundf10.eastmoney.com/';
const NAV_URL = 'https://api.fund.eastmoney.com/f10/lsjz';

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
  return (body.Datas ?? [])
    .filter((item) => item.CATEGORY === FUND_CATEGORY && /^\d{6}$/.test(item.CODE))
    .map((item) => ({
      code: item.CODE,
      name: item.NAME,
      type: item.FundBaseInfo?.FTYPE ?? null,
    }));
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
  if (!data) return null;
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
  /** 当日涨跌幅（百分比），无前一日净值时为 0。 */
  dailyChange: number;
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
  return (body.Data?.LSJZList ?? []).map((item) => ({
    date: item.FSRQ,
    unitNav: item.DWJZ,
    cumulativeNav: item.LJJZ ?? null,
    dailyChange: parsePercent(item.JZZZL),
  }));
}

function parsePercent(value: string | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
