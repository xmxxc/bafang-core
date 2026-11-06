import { z } from 'zod';
import { UpstreamError, type UpstreamFetcher } from './upstream';

/**
 * 估值上游：天天基金（一级）与新浪（二级）。两者都支持一次请求多只基金。
 * 地址属于行情模块内部的实现细节；所有请求都经过统一上游抓取适配器。
 */

/** 上游给出的一条估值，已校验为当天、数值合法。 */
export interface SourceEstimate {
  /** 估值涨跌幅（百分比）。 */
  changePercent: number;
  /** 估值对应的单位水平，保留 4 位小数的字符串。 */
  value: string;
  /** 估值时间。 */
  time: Date;
}

const TIANTIAN_URL = 'https://fundcomapi.tiantianfunds.com/mm/newCore/FundValuationLast';
const TIANTIAN_REFERER = 'https://fund.eastmoney.com/';
const SINA_URL = 'https://hq.sinajs.cn/';
const SINA_REFERER = 'https://finance.sina.com.cn/';

const TiantianResponseSchema = z.object({
  success: z.boolean(),
  errorCode: z.number().nullish(),
  data: z.array(z.unknown()).nullish(),
});

const NumberLike = z.union([z.number(), z.string()]).nullish();

const TiantianRowSchema = z.object({
  FCODE: z.string(),
  GSZ: NumberLike,
  GSZZL: NumberLike,
  /** 形如 "2026-11-06 14:30"。 */
  GZTIME: z.string().nullish(),
});

/**
 * 天天基金批量估值。返回有当天估值的基金；上游没给、字段缺失或不是当天的估值都不在结果里，
 * 由调用方回退。整个请求失败（网络、非 JSON、success 为 false）时抛出 UpstreamError。
 */
export async function fetchTiantianEstimates(
  upstream: UpstreamFetcher,
  codes: readonly string[],
  today: string,
): Promise<Map<string, SourceEstimate>> {
  const url = `${TIANTIAN_URL}?FCODES=${codes.join(',')}&FIELDS=FCODE,GSZ,GSZZL,GZTIME`;
  const body = parseJson(
    TiantianResponseSchema,
    await upstream.fetchText({ url, referer: TIANTIAN_REFERER }),
  );
  if (!body.success || (body.errorCode ?? 0) !== 0) {
    throw new UpstreamError('bad_response', `tiantian returned errorCode ${body.errorCode}`);
  }
  const wanted = new Set(codes);
  const result = new Map<string, SourceEstimate>();
  for (const raw of body.data ?? []) {
    const row = TiantianRowSchema.safeParse(raw);
    if (!row.success || !wanted.has(row.data.FCODE)) continue;
    const [date, time] = (row.data.GZTIME ?? '').trim().split(/\s+/);
    const estimate = toEstimate(row.data.GSZZL, row.data.GSZ, date, time, today);
    if (estimate) result.set(row.data.FCODE, estimate);
  }
  return result;
}

const SINA_LINE = /var hq_str_fu_(\d{6})="([^"]*)"/g;

/**
 * 新浪批量估值（`fu_` 行情）。每只基金一行，字段依次为：名称、估值时间、估值、上一净值、
 * 上一累计净值、（保留）、估值涨跌幅、估值日期……；没有估值的基金返回空串。
 * 返回有当天估值的基金；响应里一行都没有时视为上游失败，抛出 UpstreamError。
 */
export async function fetchSinaEstimates(
  upstream: UpstreamFetcher,
  codes: readonly string[],
  today: string,
): Promise<Map<string, SourceEstimate>> {
  const url = `${SINA_URL}list=${codes.map((code) => `fu_${code}`).join(',')}`;
  const text = await upstream.fetchText({ url, referer: SINA_REFERER, encoding: 'gbk' });
  const lines = [...text.matchAll(SINA_LINE)];
  if (lines.length === 0) {
    throw new UpstreamError('bad_response', 'sina response contained no fund lines');
  }
  const wanted = new Set(codes);
  const result = new Map<string, SourceEstimate>();
  for (const [, code, content] of lines) {
    if (!code || !content || !wanted.has(code)) continue;
    const fields = content.split(',');
    const estimate = toEstimate(fields[6], fields[2], fields[7], fields[1], today);
    if (estimate) result.set(code, estimate);
  }
  return result;
}

/**
 * 把上游的估值字段规整成 SourceEstimate；任何一项缺失、不可解析，或者估值日期不是今天，
 * 都视为「这个来源没有估值」返回 null，绝不以 0 兜底。估值为 0 或负数不合法；
 * 涨跌幅为 0 而估值合法时是真实的 0%。
 */
function toEstimate(
  changeRaw: unknown,
  valueRaw: unknown,
  date: string | undefined,
  time: string | undefined,
  today: string,
): SourceEstimate | null {
  const change = toFiniteNumber(changeRaw);
  const value = toFiniteNumber(valueRaw);
  if (change === null || value === null || value <= 0) return null;
  if (date !== today || !time || !/^\d{2}:\d{2}(:\d{2})?$/.test(time)) return null;
  const at = new Date(`${date}T${time.length === 5 ? `${time}:00` : time}+08:00`);
  if (Number.isNaN(at.getTime())) return null;
  return { changePercent: change, value: value.toFixed(4), time: at };
}

function toFiniteNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '--') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseJson<T>(schema: z.ZodType<T>, text: string): T {
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
  return result.data;
}
