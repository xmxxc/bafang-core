import { shanghaiDate, shanghaiMinutesOfDay, type Clock } from '../clock';
import type { TradingCalendar } from '../trading-calendar';
import { DailyCache } from './daily-cache';
import { fetchNavPage, type UpstreamNavPoint } from './eastmoney';
import type { UpstreamFetcher } from './upstream';

export type NavRange = '1m' | '3m' | '1y';

/** 每个区间对应的回看月数。 */
const RANGE_MONTHS: Record<NavRange, number> = { '1m': 1, '3m': 3, '1y': 12 };
/** 历史净值每页条数（上游上限）。 */
const PAGE_SIZE = 20;
/** 翻页上限，防御异常上游返回永不结束的分页。 */
const MAX_PAGES = 60;
/** 净值公布窗口分界：19:00 Asia/Shanghai。 */
const NAV_PUBLISH_MINUTES = 19 * 60;
/** 最近一个应已公布的净值还没拿到时的重抓间隔。 */
const NAV_PUBLISH_POLL_MS = 5 * 60_000;

export interface LatestNav {
  navDate: string;
  unitNav: string;
  cumulativeNav: string | null;
  dailyChange: number | null;
}

export interface NavPoint {
  date: string;
  unitNav: string;
  cumulativeNav: string | null;
  dailyChange: number | null;
}

export interface NavService {
  /** 最新一期净值；基金无净值数据时返回 null。 */
  latest(code: string, asOf?: Date): Promise<LatestNav | null>;
  /** 按区间返回历史净值序列（最新在前）；基金无净值数据时返回 null。 */
  history(code: string, range: NavRange, asOf?: Date): Promise<NavPoint[] | null>;
  /**
   * 净值日期早于 date 的最近一期已公布净值（date 为 YYYY-MM-DD）；查不到时返回 null。
   * 先看最新一期，最新一期已经是 date 当天或之后时再从近 1 月走势里找；两者都走同一套缓存。
   */
  latestBefore(code: string, date: string, asOf?: Date): Promise<NavPoint | null>;
}

export interface NavServiceDeps {
  upstream: UpstreamFetcher;
  clock: Clock;
  calendar: TradingCalendar;
}

/**
 * 净值缓存语义：以「按交易日历，最近一个本该已经公布的净值日期」为准，而不是只看当天几点、
 * 今天是不是交易日。该日期记为 expectedDate：
 * - 若已取到的净值日期 >= expectedDate，说明最近一期净值已经拿到，是最终值，长缓存到
 *   expectedDate 前进为止（下一个交易日的净值开始应公布）。
 * - 若取到的净值日期 < expectedDate，说明该交易日的净值因延迟（含跨午夜、周末、节假日、
 *   QDII 等）还没公布，只按 `NAV_PUBLISH_POLL_MS` 短缓存，间隔一到就重新抓取，直到拿到。
 * history 的缓存键还带上区间起点（startDate），这样即便 expectedDate 在长假期间保持不变，
 * 每次请求也会按自己的区间边界返回，不会把旧的更长区间原样命中。
 */
export function createNavService(deps: NavServiceDeps): NavService {
  const latestCache = new DailyCache<LatestNav>();
  const historyCache = new DailyCache<NavPoint[]>();
  const latestPoll = new PollCache<LatestNav>(NAV_PUBLISH_POLL_MS);
  const historyPoll = new PollCache<NavPoint[]>(NAV_PUBLISH_POLL_MS);

  const service: NavService = {
    async latest(code, asOf) {
      const now = asOf ?? deps.clock.now();
      const expectedDate = expectedPublishDate(now, deps.calendar);
      const cached = latestCache.get(expectedDate, code) ?? latestPoll.get(code, now.getTime());
      if (cached) return cached;
      const page = await fetchNavPage(deps.upstream, code, 1, 1);
      const point = page[0];
      if (!point) return null;
      const latest: LatestNav = {
        navDate: point.date,
        unitNav: point.unitNav,
        cumulativeNav: point.cumulativeNav,
        dailyChange: point.dailyChange,
      };
      if (point.date < expectedDate) {
        latestPoll.set(code, latest, now.getTime());
      } else {
        latestCache.set(expectedDate, code, latest);
      }
      return latest;
    },

    async history(code, range, asOf) {
      const now = asOf ?? deps.clock.now();
      const expectedDate = expectedPublishDate(now, deps.calendar);
      const startDate = addMonths(shanghaiDate(now), -RANGE_MONTHS[range]);
      const cacheKey = `${code}:${range}:${startDate}`;
      const cached =
        historyCache.get(expectedDate, cacheKey) ?? historyPoll.get(cacheKey, now.getTime());
      if (cached) return cached;
      const points: NavPoint[] = [];
      for (let pageIndex = 1; pageIndex <= MAX_PAGES; pageIndex++) {
        const page = await fetchNavPage(deps.upstream, code, pageIndex, PAGE_SIZE, startDate);
        if (page.length === 0) break;
        points.push(...page.map(toNavPoint));
        if (page.length < PAGE_SIZE) break;
      }
      if (points.length === 0) return null;
      const latestDate = points[0]!.date;
      if (latestDate < expectedDate) {
        historyPoll.set(cacheKey, points, now.getTime());
      } else {
        historyCache.set(expectedDate, cacheKey, points);
      }
      return points;
    },

    async latestBefore(code, date, asOf) {
      const latest = await service.latest(code, asOf);
      if (!latest) return null;
      if (latest.navDate < date) return { date: latest.navDate, ...pick(latest) };
      const points = await service.history(code, '1m', asOf);
      return points?.find((point) => point.date < date) ?? null;
    },
  };
  return service;
}

function pick(latest: LatestNav): Omit<NavPoint, 'date'> {
  return {
    unitNav: latest.unitNav,
    cumulativeNav: latest.cumulativeNav,
    dailyChange: latest.dailyChange,
  };
}

function toNavPoint(point: UpstreamNavPoint): NavPoint {
  return {
    date: point.date,
    unitNav: point.unitNav,
    cumulativeNav: point.cumulativeNav,
    dailyChange: point.dailyChange,
  };
}

/**
 * 按交易日历返回「最近一个本该已经公布的净值日期」（Asia/Shanghai 的 YYYY-MM-DD）。
 * 规则：从今天往回找最近一个交易日；若它就是今天，还得等到 19:00 公布窗口开始才算「应已公布」，
 * 否则它的净值要到今晚才出，应继续沿用上一个交易日的期望。周末、节假日、跨午夜都自然落到
 * 最近一个交易日，不会因为「今天不交易」就误判旧值已稳定。
 */
function expectedPublishDate(now: Date, calendar: TradingCalendar): string {
  let day = new Date(now.getTime());
  if (calendar.isTradingDay(day) && shanghaiMinutesOfDay(day) < NAV_PUBLISH_MINUTES) {
    day = new Date(day.getTime() - 24 * 3600_000);
  }
  while (!calendar.isTradingDay(day)) {
    day = new Date(day.getTime() - 24 * 3600_000);
  }
  return shanghaiDate(day);
}

/** 带 TTL 的短缓存：用于最近一个应已公布的净值尚未拿到时暂存旧值。 */
class PollCache<V> {
  private readonly entries = new Map<string, { value: V; fetchedAt: number }>();

  constructor(private readonly ttlMs: number) {}

  get(key: string, nowMs: number): V | undefined {
    const entry = this.entries.get(key);
    if (entry && nowMs - entry.fetchedAt < this.ttlMs) return entry.value;
    this.entries.delete(key);
    return undefined;
  }

  set(key: string, value: V, nowMs: number): void {
    this.entries.set(key, { value, fetchedAt: nowMs });
  }
}

/** 对 YYYY-MM-DD 加若干个月，日份自动收窄到目标月的最后一天。 */
function addMonths(iso: string, delta: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return iso;
  const first = new Date(Date.UTC(year, month - 1 + delta, 1));
  const lastDay = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const clamped = Math.min(day, lastDay);
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), clamped))
    .toISOString()
    .slice(0, 10);
}
