import { z } from 'zod';
import { UpstreamError, type UpstreamFetcher } from './upstream';

/** 东方财富上游：基金搜索与基金基础信息。地址属于行情模块内部的实现细节。 */

const REFERER = 'https://fund.eastmoney.com/';
const SEARCH_URL = 'https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx';
const BASE_INFO_URL = 'https://fundmobapi.eastmoney.com/FundMApi/FundBaseTypeInformation.ashx';

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
