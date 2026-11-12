import { z } from 'zod';
import { formatFixed, parseFixed, rescale, type Fixed } from '../positions/decimal';
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
  /**
   * 来源给出的估值基准：估值是在这一期单位净值上推算的涨跌。没有可核对基准的估值不会出现在
   * 结果里。date 为 null 表示来源只给了基准净值、没给日期（新浪），由估值服务查询历史唯一核实。
   */
  base: { unitNav: string; date: string | null };
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
/** 由 `quoteDecimalTokens` 保留了原文的十进制文本；仍是 JSON 数字说明预处理没认出来，整行不采纳。 */
const DecimalText = z.string().nullish();

const TiantianRowSchema = z.object({
  FCODE: z.string(),
  GSZ: DecimalText,
  GSZZL: NumberLike,
  /** 形如 "2026-11-06 14:30"。 */
  GZTIME: z.string().nullish(),
  /** 天天基金已知的最近一期单位净值及其日期。 */
  NAV: DecimalText,
  PDATE: z.string().nullish(),
});

/**
 * 天天基金批量估值。行里的 NAV / PDATE 是天天基金已知的最近一期净值。只有 PDATE 是合法日期、
 * 严格早于估值日期，且 NAV 合法时，它才是这条估值的基准，交给调用方核对。
 * 其余情况都没有可核对的基准，这条估值不采纳、由调用方回退：
 * - NAV 或 PDATE 缺失、不可解析；
 * - PDATE 晚于估值日期（数据自相矛盾）；
 * - PDATE 等于估值日期：当天净值已公布，行里只剩当天净值，看不出估值用的是哪一期基准。
 * 返回有当天估值的基金；上游没给、字段缺失或不是当天的估值都不在结果里，
 * 由调用方回退。整个请求失败（网络、非 JSON、success 为 false）时抛出 UpstreamError。
 */
export async function fetchTiantianEstimates(
  upstream: UpstreamFetcher,
  codes: readonly string[],
  today: string,
): Promise<Map<string, SourceEstimate>> {
  const url = `${TIANTIAN_URL}?FCODES=${codes.join(',')}&FIELDS=FCODE,GSZ,GSZZL,GZTIME,NAV,PDATE`;
  const text = await upstream.fetchText({ url, referer: TIANTIAN_REFERER });
  const body = parseJson(TiantianResponseSchema, quoteDecimalTokens(text, ['GSZ', 'NAV']));
  if (!body.success || (body.errorCode ?? 0) !== 0) {
    throw new UpstreamError('bad_response', `tiantian returned errorCode ${body.errorCode}`);
  }
  const wanted = new Set(codes);
  const result = new Map<string, SourceEstimate>();
  for (const raw of body.data ?? []) {
    const row = TiantianRowSchema.safeParse(raw);
    if (!row.success || !wanted.has(row.data.FCODE)) continue;
    const [date, time] = (row.data.GZTIME ?? '').trim().split(/\s+/);
    const navDate = row.data.PDATE?.trim() ?? '';
    const baseNav = formatNav(row.data.NAV);
    if (!date || !isIsoDate(navDate) || navDate >= date || !baseNav) continue;
    const base = { unitNav: baseNav, date: navDate };
    const estimate = toEstimate(row.data.GSZZL, row.data.GSZ, date, time, today, base);
    if (estimate) result.set(row.data.FCODE, estimate);
  }
  return result;
}

const SINA_LINE = /var hq_str_fu_(\d{6})="([^"]*)"/g;

/**
 * 新浪批量估值（`fu_` 行情）。每只基金一行，字段依次为：名称、估值时间、估值、基准单位净值、
 * 基准累计净值、（保留）、估值涨跌幅、估值日期……；没有估值的基金返回空串。
 * 新浪不给基准日期，只给基准净值；没有可解析的基准净值的行无法核对，视为没有估值。
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
    const baseNav = formatNav(fields[3]);
    if (!baseNav) continue;
    const base = { unitNav: baseNav, date: null };
    const estimate = toEstimate(fields[6], fields[2], fields[7], fields[1], today, base);
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
  base: SourceEstimate['base'],
): SourceEstimate | null {
  const change = toFiniteNumber(changeRaw);
  const value = formatNav(valueRaw);
  if (change === null || value === null) return null;
  if (date !== today || !time || !/^\d{2}:\d{2}(:\d{2})?$/.test(time)) return null;
  const at = new Date(`${date}T${time.length === 5 ? `${time}:00` : time}+08:00`);
  if (Number.isNaN(at.getTime())) return null;
  return { changePercent: change, value, time: at, base };
}

/** 是否为真实存在的 YYYY-MM-DD 日期。 */
function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * 把单位净值（或估值）规整成 4 位小数字符串：保留上游的十进制文本，用定点四舍五入（远离零），
 * 不经过二进制浮点。缺失、不可解析，或舍入后不为正时返回 null。
 */
export function formatNav(raw: unknown): string | null {
  const parsed = toDecimal(raw);
  if (!parsed) return null;
  const nav = rescale(parsed, 4);
  return nav.value > 0n ? formatFixed(nav) : null;
}

/**
 * 上游十进制文本的精确定点表示，可以是指数形式（如 `1e-7`），只把指数折进 scale，不做浮点运算。
 * 只接受字符串：JSON 数字已经被 `JSON.parse` 变成 binary64，不再是上游写下的数，一律拒绝。
 */
function toDecimal(raw: unknown): Fixed | null {
  if (typeof raw !== 'string') return null;
  const match = /^\+?([^eE]+)(?:[eE]([+-]?\d{1,3}))?$/.exec(raw.trim());
  if (!match) return null;
  const [, mantissa = '', exponent = '0'] = match;
  const scale = mantissa.split('.')[1]?.length ?? 0;
  const parsed = parseFixed(mantissa, scale);
  return parsed && { value: parsed.value, scale: scale - Number(exponent) };
}

function toFiniteNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '--') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 在 `JSON.parse` 之前，把指定键的 JSON 数字 token 原样改写成字符串，例如
 * `"GSZ":1.00004999999999999999` → `"GSZ":"1.00004999999999999999"`，让定点工具拿到上游原文。
 * 只匹配「键名字符串 + 冒号 + 严格符合 JSON 语法的数字 + 逗号或右花括号」：JSON 字符串内部的引号
 * 必然转义，不会被误认成键。其他写法保持原样，由解析或 schema 拒绝。
 */
function quoteDecimalTokens(text: string, keys: readonly string[]): string {
  const pattern = new RegExp(
    `("(?:${keys.join('|')})"\\s*:\\s*)(-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)(?=\\s*[,}])`,
    'g',
  );
  return text.replace(pattern, '$1"$2"');
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
