import { buildQuote, shanghaiTime, type Quote } from './quote';
import { UpstreamError, type UpstreamFetcher } from './upstream';

/**
 * 腾讯行情上游（股票与指数行情的主来源）。一次请求可取多只证券，代码用腾讯自己的写法，
 * 例如 `sh000001`、`sz399001`、`hkHSI`。地址属于行情模块内部的实现细节。
 */

const QUOTE_URL = 'https://qt.gtimg.cn/q=';
const REFERER = 'https://gu.qq.com/';

/** 响应里每只证券一行：v_<代码>="字段1~字段2~…"; */
const LINE = /^v_([A-Za-z0-9]+)="([^"]*)";?$/;
const FIELD_PRICE = 3;
const FIELD_PREV_CLOSE = 4;
const FIELD_TIME = 30;

/**
 * 批量抓取报价。返回的 Map 对每个请求的代码都有一项：解析出可用报价时是 Quote，
 * 上游没有这只证券、字段缺失或不可解析时是 null（由调用方回退）。
 * 整个请求失败（超时、5xx、空响应体、完全无法识别的响应）时抛出 UpstreamError。
 */
export async function fetchTencentQuotes(
  upstream: UpstreamFetcher,
  symbols: readonly string[],
): Promise<Map<string, Quote | null>> {
  const text = await upstream.fetchText({
    url: QUOTE_URL + symbols.join(','),
    referer: REFERER,
    encoding: 'gbk',
  });
  const rows = new Map<string, string[]>();
  let recognized = false;
  for (const line of text.split(/\r?\n/)) {
    const match = LINE.exec(line.trim());
    if (!match) continue;
    recognized = true;
    rows.set(match[1]!, match[2]!.split('~'));
  }
  if (!recognized) {
    throw new UpstreamError('bad_response', 'tencent quote response has no recognizable lines');
  }
  const quotes = new Map<string, Quote | null>();
  for (const symbol of symbols) {
    const fields = rows.get(symbol);
    quotes.set(symbol, fields ? toQuote(fields) : null);
  }
  return quotes;
}

function toQuote(fields: string[]): Quote | null {
  const time = parseTime(fields[FIELD_TIME]);
  if (!time) return null;
  return buildQuote(fields[FIELD_PRICE], fields[FIELD_PREV_CLOSE], time.date, time.at);
}

/** A 股是 `20261106161401`，港股是 `2026/11/06 18:30:50`，都是 UTC+8 本地时间。 */
function parseTime(text: string | undefined): { date: string; at: Date } | null {
  const match =
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(text ?? '') ??
    /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text ?? '');
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match as unknown as string[];
  const at = shanghaiTime(year!, month!, day!, hour, minute, second);
  if (Number.isNaN(at.getTime())) return null;
  return { date: `${year}-${month}-${day}`, at };
}
