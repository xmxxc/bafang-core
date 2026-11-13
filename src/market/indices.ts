import { shanghaiDate, shanghaiMinutesOfDay, type Clock } from '../clock';
import type { SessionCalendar, TradingCalendar } from '../trading-calendar';
import type { Quote } from './quote';
import { marketStatus, type MarketStatus } from './status';
import { fetchTencentQuotes } from './tencent';
import { fetchThsQuote } from './ths';
import { UpstreamError, type UpstreamFetcher } from './upstream';

export type IndexMarket = 'cn' | 'hk';
export type QuoteSource = 'tencent' | 'ths';
export type IndexCode = '000001.SH' | '399001.SZ' | '399006.SZ' | 'HSI.HK';

interface IndexDefinition {
  code: IndexCode;
  name: string;
  market: IndexMarket;
  tencent: string;
  ths: string;
}

/** 大盘指数：固定这四个，顺序即返回顺序。 */
const INDICES: readonly IndexDefinition[] = [
  { code: '000001.SH', name: '上证指数', market: 'cn', tencent: 'sh000001', ths: 'zs_1A0001' },
  { code: '399001.SZ', name: '深证成指', market: 'cn', tencent: 'sz399001', ths: 'zs_399001' },
  { code: '399006.SZ', name: '创业板指', market: 'cn', tencent: 'sz399006', ths: 'zs_399006' },
  { code: 'HSI.HK', name: '恒生指数', market: 'hk', tencent: 'hkHSI', ths: 'hk_HSI' },
];

export interface MarketIndex {
  code: IndexCode;
  name: string;
  market: IndexMarket;
  marketStatus: MarketStatus;
  available: boolean;
  point: string | null;
  prevClose: string | null;
  change: string | null;
  changePercent: number | null;
  tradeDate: string | null;
  quoteTime: string | null;
  source: QuoteSource | null;
  fallback: boolean;
}

export interface IndexService {
  list(asOf?: Date): Promise<MarketIndex[]>;
}

export interface IndexServiceDeps {
  upstream: UpstreamFetcher;
  clock: Clock;
  /** A 股交易日历。 */
  calendar: TradingCalendar;
  /** 港股交易日历（含半日市）。 */
  hkCalendar: SessionCalendar;
}

const DAY_MS = 24 * 3600_000;
const MINUTE_MS = 60_000;
const MINUTES = (hour: number, minute: number) => hour * 60 + minute;
/** 往回找上一个交易日的上限。 */
const MAX_LOOKBACK_DAYS = 31;

/** 一个交易日内的时段边界（Asia/Shanghai 从午夜起算的分钟数）。午间休市仍算交易时段。 */
interface Session {
  open: number;
  /** 时段边界：开盘、午休开始与结束、收盘，用来截断行情缓存。 */
  boundaries: number[];
  close: number;
}

/** A 股：09:30 开盘，11:30–13:00 午休，15:00 收盘。 */
const A_SHARE_SESSION: Session = {
  open: MINUTES(9, 30),
  boundaries: [MINUTES(9, 30), MINUTES(11, 30), MINUTES(13, 0), MINUTES(15, 0)],
  close: MINUTES(15, 0),
};

/** 港股：09:30 开市，12:00–13:00 午休，收市竞价至 16:10。半日市只有早市，收市时刻取自日历。 */
function hkSession(date: Date, calendar: SessionCalendar): Session {
  const earlyClose = calendar.earlyCloseMinutes(date);
  if (earlyClose !== null) {
    return { open: MINUTES(9, 30), boundaries: [MINUTES(9, 30), earlyClose], close: earlyClose };
  }
  return {
    open: MINUTES(9, 30),
    boundaries: [MINUTES(9, 30), MINUTES(12, 0), MINUTES(13, 0), MINUTES(16, 10)],
    close: MINUTES(16, 10),
  };
}

/** 行情缓存时长：交易时段秒级，其余较长；不可用的结果只短暂缓存。都截断到下一个时段边界。 */
const TTL_MS: Record<MarketStatus | 'unavailable', number> = {
  trading: 10_000,
  pre_market: 30_000,
  closed: 5 * 60_000,
  holiday: 5 * 60_000,
  unavailable: 10_000,
};

interface ResolvedQuote {
  quote: Quote | null;
  source: QuoteSource | null;
  fallback: boolean;
}

/**
 * 大盘指数行情：腾讯为主来源（一次批量请求），某个指数在腾讯取不到或不可信时，
 * 单独回退到同花顺；都失败就标为不可用（数值为 null，不用 0）。
 *
 * 市场状态与「应有的交易日」都按各自市场的交易日历判定（A 股日历；港股日历含休市日与半日市），
 * 不用报价日期去推断：今天是交易日且已开盘，就必须拿到今天的报价；否则（盘前、休市）报价不得早于
 * 上一个交易日。对不上的报价视为不可信，回退或标为不可用，不会因此宣布休市。
 *
 * 缓存只存行情（按指数，在进程内）；市场状态每次请求都重新计算。行情缓存时长见 `TTL_MS`，
 * 并截断到所属市场的下一个时段边界（开盘、午休、收盘、半日市收市、零点），跨过边界一定重新取数。
 */
export function createIndexService(deps: IndexServiceDeps): IndexService {
  const cache = new Map<string, { resolved: ResolvedQuote; expiresAt: number }>();

  return {
    async list(asOf) {
      const now = asOf ?? deps.clock.now();
      const nowMs = now.getTime();
      const stale = INDICES.filter((index) => {
        const entry = cache.get(index.code);
        return !entry || entry.expiresAt <= nowMs;
      });
      if (stale.length > 0) {
        const fresh = await resolveQuotes(stale, now, deps);
        stale.forEach((index, i) => {
          const resolved = fresh[i]!;
          const status = statusOf(index.market, now, deps);
          const ttl = TTL_MS[resolved.quote ? status : 'unavailable'];
          const boundary = nextBoundary(index.market, now, deps);
          cache.set(index.code, { resolved, expiresAt: Math.min(nowMs + ttl, boundary) });
        });
      }
      return INDICES.map((index) => toItem(index, cache.get(index.code)!.resolved, now, deps));
    },
  };
}

async function resolveQuotes(
  indices: readonly IndexDefinition[],
  now: Date,
  deps: IndexServiceDeps,
): Promise<ResolvedQuote[]> {
  let primary = new Map<string, Quote | null>();
  try {
    primary = await fetchTencentQuotes(
      deps.upstream,
      indices.map((index) => index.tencent),
    );
  } catch (error) {
    if (!(error instanceof UpstreamError)) throw error;
    console.warn('[bafang-core] tencent quotes failed', error.kind, error.message);
  }

  const resolved = await Promise.all(
    indices.map(async (index): Promise<ResolvedQuote> => {
      const fromPrimary = trusted(index, primary.get(index.tencent) ?? null, now, deps);
      if (fromPrimary) return { quote: fromPrimary, source: 'tencent', fallback: false };
      const fromBackup = trusted(index, await fetchBackup(index, deps), now, deps);
      if (fromBackup) return { quote: fromBackup, source: 'ths', fallback: true };
      return { quote: null, source: null, fallback: true };
    }),
  );
  // 只有报价通过字段解析、交叉校验与交易日核对、被实际采纳时，才算该上游成功。
  for (const source of new Set(resolved.map((item) => item.source))) {
    if (source) deps.upstream.recordSuccess?.(source);
  }
  return resolved;
}

async function fetchBackup(index: IndexDefinition, deps: IndexServiceDeps): Promise<Quote | null> {
  try {
    return await fetchThsQuote(deps.upstream, index.ths);
  } catch (error) {
    if (!(error instanceof UpstreamError)) throw error;
    console.warn('[bafang-core] ths quote failed', index.ths, error.kind, error.message);
    return null;
  }
}

function calendarOf(market: IndexMarket, deps: IndexServiceDeps): TradingCalendar {
  return market === 'cn' ? deps.calendar : deps.hkCalendar;
}

function sessionOf(market: IndexMarket, date: Date, deps: IndexServiceDeps): Session {
  return market === 'cn' ? A_SHARE_SESSION : hkSession(date, deps.hkCalendar);
}

/** 报价的交易日与当前应有的交易日对得上才可信，否则返回 null。 */
function trusted(
  index: IndexDefinition,
  quote: Quote | null,
  now: Date,
  deps: IndexServiceDeps,
): Quote | null {
  if (!quote) return null;
  if (quote.tradeDate > shanghaiDate(now)) return null;
  return quote.tradeDate >= sessionDate(index.market, now, deps) ? quote : null;
}

/** 当前应展示的交易日：今天是交易日且已开盘时是今天，否则是上一个交易日。 */
function sessionDate(market: IndexMarket, now: Date, deps: IndexServiceDeps): string {
  const calendar = calendarOf(market, deps);
  if (
    calendar.isTradingDay(now) &&
    shanghaiMinutesOfDay(now) >= sessionOf(market, now, deps).open
  ) {
    return shanghaiDate(now);
  }
  let day = new Date(now.getTime() - DAY_MS);
  for (let i = 0; i < MAX_LOOKBACK_DAYS && !calendar.isTradingDay(day); i++) {
    day = new Date(day.getTime() - DAY_MS);
  }
  return shanghaiDate(day);
}

function statusOf(market: IndexMarket, now: Date, deps: IndexServiceDeps): MarketStatus {
  if (market === 'cn') return marketStatus(now, deps.calendar);
  if (!deps.hkCalendar.isTradingDay(now)) return 'holiday';
  const minutes = shanghaiMinutesOfDay(now);
  const session = hkSession(now, deps.hkCalendar);
  if (minutes < session.open) return 'pre_market';
  if (minutes >= session.close) return 'closed';
  return 'trading';
}

/** 所属市场在 now 之后的下一个时段边界（含次日零点）的时间戳。 */
function nextBoundary(market: IndexMarket, now: Date, deps: IndexServiceDeps): number {
  const dayStart = new Date(`${shanghaiDate(now)}T00:00:00+08:00`).getTime();
  const candidates = [dayStart + DAY_MS];
  if (calendarOf(market, deps).isTradingDay(now)) {
    for (const minutes of sessionOf(market, now, deps).boundaries) {
      candidates.push(dayStart + minutes * MINUTE_MS);
    }
  }
  return Math.min(...candidates.filter((at) => at > now.getTime()));
}

function toItem(
  index: IndexDefinition,
  { quote, source, fallback }: ResolvedQuote,
  now: Date,
  deps: IndexServiceDeps,
): MarketIndex {
  return {
    code: index.code,
    name: index.name,
    market: index.market,
    marketStatus: statusOf(index.market, now, deps),
    available: quote !== null,
    point: quote?.price ?? null,
    prevClose: quote?.prevClose ?? null,
    change: quote?.change ?? null,
    changePercent: quote?.changePercent ?? null,
    tradeDate: quote?.tradeDate ?? null,
    quoteTime: quote?.time.toISOString() ?? null,
    source,
    fallback,
  };
}
