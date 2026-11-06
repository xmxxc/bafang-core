import { shanghaiDate, shanghaiMinutesOfDay, type Clock } from '../clock';
import type { TradingCalendar } from '../trading-calendar';
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
  list(): Promise<MarketIndex[]>;
}

export interface IndexServiceDeps {
  upstream: UpstreamFetcher;
  clock: Clock;
  calendar: TradingCalendar;
}

const DAY_MS = 24 * 3600_000;
const MINUTES = (hour: number, minute: number) => hour * 60 + minute;
const A_SHARE_OPEN = MINUTES(9, 30);
/** 港股：09:30 开市，16:10 收市竞价结束（午间休市仍算交易时段，与 A 股的判定口径一致）。 */
const HK_OPEN = MINUTES(9, 30);
const HK_CLOSE = MINUTES(16, 10);
/** 港股开市后多久仍拿不到当日行情，就判定当天休市。 */
const HK_HOLIDAY_GRACE = 5;
/** 港股行情最多允许落后的自然日数（覆盖农历新年、复活节等最长连续休市）。 */
const HK_MAX_STALE_DAYS = 7;
/** A 股往回找上一个交易日的上限。 */
const MAX_LOOKBACK_DAYS = 31;

/** 缓存时长：交易时段秒级，其余较长；不可用的结果只短暂缓存，避免上游故障时被反复打。 */
const TTL_MS: Record<MarketStatus | 'unavailable', number> = {
  trading: 10_000,
  pre_market: 30_000,
  closed: 5 * 60_000,
  holiday: 5 * 60_000,
  unavailable: 10_000,
};

/**
 * 大盘指数行情：腾讯为主来源（一次批量请求），某个指数在腾讯取不到或不可信时，
 * 单独回退到同花顺；都失败就标为不可用（数值为 null，不用 0）。
 *
 * 可信度：报价的交易日必须与当前应有的交易日对得上。
 * - A 股按交易日历：交易日开盘后必须是当天，其余时间（盘前、休市）不早于上一个交易日。
 * - 港股没有维护的交易日历，用报价自身的交易日推断：工作日开市后报价仍停在之前的交易日，
 *   就判定当天休市；报价落后超过 7 个自然日视为过期。
 *
 * 缓存按指数分别存放在进程内，时长见 `TTL_MS`。
 */
export function createIndexService(deps: IndexServiceDeps): IndexService {
  const cache = new Map<string, { item: MarketIndex; expiresAt: number }>();

  return {
    async list() {
      const now = deps.clock.now();
      const nowMs = now.getTime();
      const stale = INDICES.filter((index) => {
        const entry = cache.get(index.code);
        return !entry || entry.expiresAt <= nowMs;
      });
      if (stale.length > 0) {
        const fresh = await resolveQuotes(stale, now, deps);
        for (const item of fresh) {
          const ttl = TTL_MS[item.available ? item.marketStatus : 'unavailable'];
          cache.set(item.code, { item, expiresAt: nowMs + ttl });
        }
      }
      return INDICES.map((index) => cache.get(index.code)!.item);
    },
  };
}

async function resolveQuotes(
  indices: readonly IndexDefinition[],
  now: Date,
  deps: IndexServiceDeps,
): Promise<MarketIndex[]> {
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

  return Promise.all(
    indices.map(async (index) => {
      const fromPrimary = trusted(index, primary.get(index.tencent) ?? null, now, deps.calendar);
      if (fromPrimary) return toItem(index, fromPrimary, 'tencent', false, now, deps.calendar);
      const fromBackup = trusted(index, await fetchBackup(index, deps), now, deps.calendar);
      if (fromBackup) return toItem(index, fromBackup, 'ths', true, now, deps.calendar);
      return toItem(index, null, null, true, now, deps.calendar);
    }),
  );
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

/** 报价的交易日与当前应有的交易日对得上才可信，否则返回 null。 */
function trusted(
  index: IndexDefinition,
  quote: Quote | null,
  now: Date,
  calendar: TradingCalendar,
): Quote | null {
  if (!quote) return null;
  const today = shanghaiDate(now);
  if (quote.tradeDate > today) return null;
  const earliest =
    index.market === 'cn'
      ? aShareSessionDate(now, calendar)
      : shanghaiDate(new Date(now.getTime() - HK_MAX_STALE_DAYS * DAY_MS));
  return quote.tradeDate >= earliest ? quote : null;
}

/** A 股当前应展示的交易日：交易日开盘后是当天，否则是上一个交易日。 */
function aShareSessionDate(now: Date, calendar: TradingCalendar): string {
  if (calendar.isTradingDay(now) && shanghaiMinutesOfDay(now) >= A_SHARE_OPEN) {
    return shanghaiDate(now);
  }
  let day = new Date(now.getTime() - DAY_MS);
  for (let i = 0; i < MAX_LOOKBACK_DAYS && !calendar.isTradingDay(day); i++) {
    day = new Date(day.getTime() - DAY_MS);
  }
  return shanghaiDate(day);
}

const weekdayFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  weekday: 'short',
});

/**
 * 港股市场状态（香港与上海同在 UTC+8）：周末休市；工作日 09:30 前盘前；开市后如果报价的
 * 交易日仍早于今天（留 5 分钟余量），说明当天没有开市，判定为休市；否则 16:10 前交易中、之后已收盘。
 * 没有可用报价时只能按时段判断。
 */
function hkMarketStatus(now: Date, quote: Quote | null): MarketStatus {
  const weekday = weekdayFormatter.format(now);
  if (weekday === 'Sat' || weekday === 'Sun') return 'holiday';
  const minutes = shanghaiMinutesOfDay(now);
  if (minutes < HK_OPEN) return 'pre_market';
  if (quote && quote.tradeDate < shanghaiDate(now)) {
    return minutes < HK_OPEN + HK_HOLIDAY_GRACE ? 'pre_market' : 'holiday';
  }
  return minutes < HK_CLOSE ? 'trading' : 'closed';
}

function toItem(
  index: IndexDefinition,
  quote: Quote | null,
  source: QuoteSource | null,
  fallback: boolean,
  now: Date,
  calendar: TradingCalendar,
): MarketIndex {
  return {
    code: index.code,
    name: index.name,
    market: index.market,
    marketStatus: index.market === 'cn' ? marketStatus(now, calendar) : hkMarketStatus(now, quote),
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
