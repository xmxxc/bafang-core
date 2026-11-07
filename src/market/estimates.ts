import { shanghaiDate, type Clock } from '../clock';
import type { TradingCalendar } from '../trading-calendar';
import {
  fetchSinaEstimates,
  fetchTiantianEstimates,
  type SourceEstimate,
} from './estimate-sources';
import { formatNav } from './estimate-sources';
import type { NavService } from './nav';
import { marketStatus, type MarketStatus } from './status';
import { UpstreamError, type UpstreamFetcher } from './upstream';

/** 交易时段内估值的缓存时长（秒级）。 */
const TRADING_TTL_MS = 30_000;
/** 进程内估值缓存的条目上限。 */
const MAX_CACHE_ENTRIES = 5000;
const MARKET_OPEN = '09:30';

export type EstimateSource = 'tiantian' | 'sina';

export const ESTIMATE_SOURCE_NAMES: Record<EstimateSource, string> = {
  tiantian: '天天基金',
  sina: '新浪财经',
};

export interface Estimate {
  changePercent: number;
  value: string;
  time: string;
  source: EstimateSource;
  sourceName: string;
  /** 一级来源（天天基金）没有给出估值，改用了后面的来源。 */
  fallback: boolean;
  referenceOnly: true;
}

/**
 * 单只基金的估值状态，均为显式枚举：
 * - estimated   有估值（交易时段，或当天收盘后的收盘估值）
 * - unavailable 所有来源都失败或都没有当天估值
 * - pre_market  交易日开盘前，不提供估值
 * - holiday     休市（周末或休市日），不提供估值
 */
export type EstimateStatus = 'estimated' | 'unavailable' | 'pre_market' | 'holiday';

export interface EstimateItem {
  code: string;
  status: EstimateStatus;
  estimate: Estimate | null;
}

export interface EstimateBatch {
  marketStatus: MarketStatus;
  time: string;
  items: EstimateItem[];
}

export interface EstimateService {
  /** 批量估值；codes 已去重，顺序即返回顺序。 */
  batch(codes: readonly string[]): Promise<EstimateBatch>;
}

export interface EstimateServiceDeps {
  upstream: UpstreamFetcher;
  clock: Clock;
  calendar: TradingCalendar;
  /** 用来核对估值基准的净值模块；与净值接口共用同一个实例与缓存。 */
  nav: NavService;
}

interface CacheEntry {
  estimate: Estimate | null;
  expiresAt: number;
}

/**
 * 估值服务：天天基金 → 新浪两级回退。
 *
 * - 盘前、休市不访问上游，直接返回对应状态。
 * - 交易时段（含午休）每只基金的结果缓存 `TRADING_TTL_MS`。
 * - 收盘后拿到的收盘估值（估值时间不早于 15:00）缓存到下一个交易日开盘（按交易日历推算）；
 *   收盘后取不到估值、或只拿到 15:00 前的估值时仍按短缓存处理，之后再试。
 *
 * 基准核对：一条估值只有当它的基准净值就是「估值日期之前最近一期已公布净值」时才采纳，
 * 否则它估的是一个已经结算过的交易日（例如 QDII 净值晚到、来源还在用更早的基准），按无估值处理：
 * 一级过期就回退二级，二级也过期就是 unavailable。核对不了的估值同样不采纳：来源没给出可核对的
 * 基准（见 estimate-sources），或者净值模块给不出期望的基准（净值上游失败且没有缓存、基金没有
 * 净值数据）。净值模块自己的缓存仍可用，所以此前已取到的净值在净值上游故障期间照常用于核对。
 * 因此被采纳的估值一定核对过基准，收盘估值可以放心长缓存。
 *
 * 缓存先放在进程内，按基金代码作键、带到期时间，以后换成 Redis 时用同样的键与 TTL 即可。
 */
export function createEstimateService(deps: EstimateServiceDeps): EstimateService {
  const cache = new Map<string, CacheEntry>();

  function remember(code: string, entry: CacheEntry): void {
    cache.delete(code);
    cache.set(code, entry);
    if (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }

  return {
    async batch(codes) {
      const now = deps.clock.now();
      const status = marketStatus(now, deps.calendar);
      const time = now.toISOString();
      if (status === 'pre_market' || status === 'holiday') {
        return { marketStatus: status, time, items: codes.map((code) => offHours(code, status)) };
      }

      const nowMs = now.getTime();
      const resolved = new Map<string, Estimate | null>();
      for (const code of codes) {
        const entry = cache.get(code);
        if (entry && entry.expiresAt > nowMs) resolved.set(code, entry.estimate);
      }

      const missing = codes.filter((code) => !resolved.has(code));
      if (missing.length > 0) {
        const today = shanghaiDate(now);
        const verify = baseVerifier(deps.nav);
        const primary = await verify(
          await trySource('tiantian', () => fetchTiantianEstimates(deps.upstream, missing, today)),
        );
        const rest = missing.filter((code) => !primary.has(code));
        const secondary =
          rest.length > 0
            ? await verify(
                await trySource('sina', () => fetchSinaEstimates(deps.upstream, rest, today)),
              )
            : new Map<string, SourceEstimate>();

        const closeAt = new Date(`${today}T15:00:00+08:00`).getTime();
        const nextOpenMs = nextMarketOpen(now, deps.calendar).getTime();
        for (const code of missing) {
          const fromPrimary = primary.get(code);
          const fromSecondary = secondary.get(code);
          const estimate = fromPrimary
            ? toEstimate(fromPrimary, 'tiantian', false)
            : fromSecondary
              ? toEstimate(fromSecondary, 'sina', true)
              : null;
          const closingEstimate =
            status === 'closed' && estimate !== null && Date.parse(estimate.time) >= closeAt;
          remember(code, {
            estimate,
            expiresAt: closingEstimate ? nextOpenMs : nowMs + TRADING_TTL_MS,
          });
          resolved.set(code, estimate);
        }
      }

      return {
        marketStatus: status,
        time,
        items: codes.map((code) => {
          const estimate = resolved.get(code) ?? null;
          return { code, status: estimate ? 'estimated' : 'unavailable', estimate };
        }),
      };
    },
  };
}

function offHours(code: string, status: 'pre_market' | 'holiday'): EstimateItem {
  return { code, status, estimate: null };
}

function toEstimate(source: SourceEstimate, name: EstimateSource, fallback: boolean): Estimate {
  return {
    changePercent: source.changePercent,
    value: source.value,
    time: source.time.toISOString(),
    source: name,
    sourceName: ESTIMATE_SOURCE_NAMES[name],
    fallback,
    referenceOnly: true,
  };
}

/**
 * 按「估值日期之前最近一期已公布净值」核对每条估值的基准，只留下基准相符的估值；
 * 过期的、以及期望基准查不到（净值上游失败或没有净值数据）的估值都去掉。
 * 同一批次里对同一只基金的净值查询只做一次。
 */
function baseVerifier(nav: NavService) {
  const lookups = new Map<string, Promise<{ date: string; unitNav: string } | null>>();

  function expectedBase(code: string, date: string) {
    const key = `${code}:${date}`;
    let lookup = lookups.get(key);
    if (!lookup) {
      lookup = nav.latestBefore(code, date).catch((error: unknown) => {
        if (!(error instanceof UpstreamError)) throw error;
        console.warn('[bafang-core] estimate base unavailable', code, error.kind, error.message);
        return null;
      });
      lookups.set(key, lookup);
    }
    return lookup;
  }

  return async (candidates: Map<string, SourceEstimate>): Promise<Map<string, SourceEstimate>> => {
    const checked = await Promise.all(
      [...candidates].map(async ([code, source]) => {
        const expected = await expectedBase(code, shanghaiDate(source.time));
        const matches =
          expected !== null &&
          formatNav(expected.unitNav) === source.base.unitNav &&
          (source.base.date === null || source.base.date === expected.date);
        return [code, matches ? source : null] as const;
      }),
    );
    const accepted = new Map<string, SourceEstimate>();
    for (const [code, source] of checked) if (source) accepted.set(code, source);
    return accepted;
  };
}

/** 单个来源整体失败时记一条日志并视为「这个来源没有估值」，交给下一级。 */
async function trySource(
  name: EstimateSource,
  load: () => Promise<Map<string, SourceEstimate>>,
): Promise<Map<string, SourceEstimate>> {
  try {
    return await load();
  } catch (error) {
    if (!(error instanceof UpstreamError)) throw error;
    console.warn('[bafang-core] estimate source failed', name, error.kind, error.message);
    return new Map();
  }
}

/**
 * 按交易日历返回下一个开盘时刻（09:30 Asia/Shanghai）：今天是交易日且还没到 09:30 就是今天，
 * 否则是之后第一个交易日。
 */
function nextMarketOpen(now: Date, calendar: TradingCalendar): Date {
  const today = shanghaiDate(now);
  const openToday = new Date(`${today}T${MARKET_OPEN}:00+08:00`);
  if (calendar.isTradingDay(now) && openToday.getTime() > now.getTime()) return openToday;
  const noon = new Date(`${today}T12:00:00+08:00`).getTime();
  for (let offset = 1; offset <= 366; offset++) {
    const day = new Date(noon + offset * 24 * 3600_000);
    if (calendar.isTradingDay(day)) {
      return new Date(`${shanghaiDate(day)}T${MARKET_OPEN}:00+08:00`);
    }
  }
  // 一年内找不到交易日只可能是日历数据异常；退回短缓存，不长期持有。
  return new Date(now.getTime() + TRADING_TTL_MS);
}
