import { z } from 'zod';
import { buildQuote, parseDecimal, shanghaiTime, type Quote } from './quote';
import { UpstreamError, type UpstreamFetcher } from './upstream';

/**
 * 同花顺行情上游（股票与指数行情的备用来源）。每次取一只证券，代码用同花顺自己的写法，
 * 例如 `zs_1A0001`（上证指数）、`zs_399001`、`hk_HSI`。地址属于行情模块内部的实现细节。
 *
 * 同花顺的 CDN 偶尔会从陈旧节点返回过期数据（实测恒生指数：快照接口整份是几个月前的点位，
 * 或分时接口的昨收是几个月前的值，而分时点位是当天的），单看一份响应无法识别。
 * 因此同时取「快照」与「分时」两份响应交叉校验：昨收必须完全一致、最新价必须基本一致，
 * 否则视为不可信、返回 null，宁可让上层标为不可用，也不给错误的涨跌。
 */

const REFERER = 'https://stockpage.10jqka.com.cn/';
const BASE_URL = 'https://d.10jqka.com.cn/v6';
/** 快照与分时的最新价允许的偏差：昨收的 0.5%（两份响应的抓取时刻可能差一两笔成交）。 */
const PRICE_TOLERANCE_DIVISOR = 200n;

const RealheadSchema = z.object({
  items: z.object({
    /** 最新价 */
    '10': z.string().nullish(),
    /** 昨收 */
    '6': z.string().nullish(),
  }),
});

const TimeSchema = z.record(
  z.string(),
  z.object({
    pre: z.string().nullish(),
    date: z.string().nullish(),
    data: z.string().nullish(),
  }),
);

/**
 * 抓取一只证券的报价。上游请求失败时抛出 UpstreamError；
 * 数据缺失、没有当日分时点或两份响应对不上时返回 null。
 */
export async function fetchThsQuote(
  upstream: UpstreamFetcher,
  symbol: string,
): Promise<Quote | null> {
  const [realheadText, timeText] = await Promise.all([
    upstream.fetchText({ url: `${BASE_URL}/realhead/${symbol}/last.js`, referer: REFERER }),
    upstream.fetchText({ url: `${BASE_URL}/time/${symbol}/last.js`, referer: REFERER }),
  ]);
  const realhead = parseJsonp(RealheadSchema, realheadText).items;
  const time = parseJsonp(TimeSchema, timeText)[symbol];
  if (!time) return null;

  const dateMatch = /^(\d{4})(\d{2})(\d{2})$/.exec(time.date ?? '');
  const last = lastMinute(time.data);
  if (!dateMatch || !last) return null;

  const timePre = parseDecimal(time.pre);
  const snapshotPre = parseDecimal(realhead['6']);
  const timePrice = parseDecimal(last.price);
  const snapshotPrice = parseDecimal(realhead['10']);
  if (timePre === null || snapshotPre === null || timePrice === null || snapshotPrice === null) {
    return null;
  }
  if (timePre !== snapshotPre || timePre <= 0n) return null;
  const drift = snapshotPrice > timePrice ? snapshotPrice - timePrice : timePrice - snapshotPrice;
  if (drift * PRICE_TOLERANCE_DIVISOR > timePre) return null;

  const [, year, month, day] = dateMatch as unknown as string[];
  const at = shanghaiTime(year!, month!, day!, last.hhmm.slice(0, 2), last.hhmm.slice(2, 4));
  return buildQuote(last.price, time.pre, `${year}-${month}-${day}`, at);
}

export interface ThsIntradayPoint {
  time: Date;
  changePercent: number;
}

/** 读取同花顺当日真实分时点；不插值、不前向填充。 */
export async function fetchThsIntraday(
  upstream: UpstreamFetcher,
  symbol: string,
): Promise<ThsIntradayPoint[]> {
  const [text, snapshotText] = await Promise.all([
    upstream.fetchText({ url: `${BASE_URL}/time/${symbol}/last.js`, referer: REFERER }),
    upstream.fetchText({ url: `${BASE_URL}/realhead/${symbol}/last.js`, referer: REFERER }),
  ]);
  const time = parseJsonp(TimeSchema, text)[symbol];
  const snapshot = parseJsonp(RealheadSchema, snapshotText).items;
  if (!time?.date) throw new UpstreamError('bad_response', 'ths time response missing date');
  if (time.data === null || time.data === undefined)
    throw new UpstreamError('bad_response', 'ths time response missing data');
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(time.date);
  const pre = parseDecimal(time.pre);
  if (!match) throw new UpstreamError('bad_response', 'ths time response has an invalid date');
  if (pre === null || pre <= 0n)
    throw new UpstreamError('bad_response', 'ths time response has an invalid previous close');
  if (parseDecimal(snapshot['6']) !== pre)
    throw new UpstreamError('bad_response', 'ths time and realhead previous close disagree');
  const [, year, month, day] = match;
  const date = `${year}-${month}-${day}`;
  const check = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(check.getTime()) || check.toISOString().slice(0, 10) !== date)
    throw new UpstreamError('bad_response', 'ths time response has an impossible date');
  if (time.data === '') return [];
  const points = new Map<number, ThsIntradayPoint>();
  for (const raw of time.data.split(';')) {
    const [hhmm, price] = raw.split(',');
    if (!hhmm || !/^\d{4}$/.test(hhmm) || !price)
      throw new UpstreamError('bad_response', 'ths time response contains a malformed point');
    const hour = Number(hhmm.slice(0, 2)),
      minute = Number(hhmm.slice(2));
    const label = hour * 60 + minute;
    if (minute > 59 || hour > 23)
      throw new UpstreamError('bad_response', 'ths time response contains an invalid clock label');
    const parsed = buildQuote(
      price,
      time.pre,
      date,
      shanghaiTime(year!, month!, day!, hhmm.slice(0, 2), hhmm.slice(2)),
    );
    if (!parsed)
      throw new UpstreamError('bad_response', 'ths time response contains an invalid price');
    // Valid after-session or other non-trading labels are filtered, never erase the day.
    if (!((label >= 570 && label <= 690) || (label >= 780 && label <= 900))) continue;
    const at = parsed.time.getTime();
    const previous = points.get(at);
    if (previous && previous.changePercent !== parsed.changePercent)
      throw new UpstreamError(
        'bad_response',
        'ths time response contains conflicting duplicate labels',
      );
    points.set(at, { time: parsed.time, changePercent: parsed.changePercent });
  }
  const sorted = [...points.values()].sort((a, b) => a.time.getTime() - b.time.getTime());
  const last = lastMinute(time.data);
  const price = last ? parseDecimal(last.price) : null;
  const current = parseDecimal(snapshot['10']);
  if (price === null || current === null || current <= 0n)
    throw new UpstreamError('bad_response', 'ths time response cannot validate its latest price');
  const drift = price > current ? price - current : current - price;
  if (drift * PRICE_TOLERANCE_DIVISOR > pre)
    throw new UpstreamError('bad_response', 'ths time and realhead prices disagree');
  return sorted;
}

/** 分时数据是 `HHMM,价格,成交额,均价,成交量;…`，取最后一个点。 */
function lastMinute(data: string | null | undefined): { hhmm: string; price: string } | null {
  const points = (data ?? '').split(';').filter((point) => point.trim() !== '');
  const [hhmm, price] = (points.at(-1) ?? '').split(',');
  if (!hhmm || !/^\d{4}$/.test(hhmm) || !price) return null;
  return { hhmm, price };
}

/** 同花顺返回 `quotebridge_…({...})` 形式的 JSONP。 */
function parseJsonp<T>(schema: z.ZodType<T>, text: string): T {
  const start = text.indexOf('(');
  const end = text.lastIndexOf(')');
  if (start < 0 || end <= start) {
    throw new UpstreamError('bad_response', 'ths response is not JSONP');
  }
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start + 1, end));
  } catch {
    throw new UpstreamError('bad_response', 'ths response is not valid JSON');
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new UpstreamError('bad_response', 'ths response did not match the expected shape');
  }
  return result.data;
}
