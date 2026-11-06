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
/** 公布窗口内、当天净值尚未公布时的重抓间隔。 */
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
  latest(code: string): Promise<LatestNav | null>;
  /** 按区间返回历史净值序列（最新在前）；基金无净值数据时返回 null。 */
  history(code: string, range: NavRange): Promise<NavPoint[] | null>;
}

export interface NavServiceDeps {
  upstream: UpstreamFetcher;
  clock: Clock;
  calendar: TradingCalendar;
}

/**
 * 净值缓存语义：
 * - 公布窗口前（00:00–19:00 Asia/Shanghai）：当天净值还没到公布时间，最新净值不会变化，
 *   缓存到 19:00。
 * - 公布窗口内（19:00 起）且当天是交易日：当天净值随时可能公布，但公布时刻未知。此时若已
 *   取到当天净值（净值日期 == 当天），它就是最终值，缓存到下一次窗口；否则说明上游仍返回
 *   旧净值，只按 `NAV_PUBLISH_POLL_MS` 短缓存，间隔一到就重新抓取，直到拿到当天净值。
 * - 公布窗口内但当天不是交易日（周末或休市日）：没有新净值要公布，缓存到下一次窗口。
 */
export function createNavService(deps: NavServiceDeps): NavService {
  const latestCache = new DailyCache<LatestNav>();
  const historyCache = new DailyCache<NavPoint[]>();
  const latestPoll = new PollCache<LatestNav>(NAV_PUBLISH_POLL_MS);
  const historyPoll = new PollCache<NavPoint[]>(NAV_PUBLISH_POLL_MS);

  return {
    async latest(code) {
      const now = deps.clock.now();
      const plan = navCachePlan(now, deps.calendar);
      const cached = latestCache.get(plan.key, code) ?? latestPoll.get(code, now.getTime());
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
      if (plan.kind === 'pending' && point.date < plan.expectedDate) {
        latestPoll.set(code, latest, now.getTime());
      } else {
        latestCache.set(plan.key, code, latest);
      }
      return latest;
    },

    async history(code, range) {
      const now = deps.clock.now();
      const plan = navCachePlan(now, deps.calendar);
      const cacheKey = `${code}:${range}`;
      const cached =
        historyCache.get(plan.key, cacheKey) ?? historyPoll.get(cacheKey, now.getTime());
      if (cached) return cached;
      const startDate = addMonths(shanghaiDate(now), -RANGE_MONTHS[range]);
      const points: NavPoint[] = [];
      for (let pageIndex = 1; pageIndex <= MAX_PAGES; pageIndex++) {
        const page = await fetchNavPage(deps.upstream, code, pageIndex, PAGE_SIZE, startDate);
        if (page.length === 0) break;
        points.push(...page.map(toNavPoint));
        if (page.length < PAGE_SIZE) break;
      }
      if (points.length === 0) return null;
      const latestDate = points[0]!.date;
      if (plan.kind === 'pending' && latestDate < plan.expectedDate) {
        historyPoll.set(cacheKey, points, now.getTime());
      } else {
        historyCache.set(plan.key, cacheKey, points);
      }
      return points;
    },
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

type NavCachePlan =
  { kind: 'stable'; key: string } | { kind: 'pending'; key: string; expectedDate: string };

/**
 * 决定当前请求的缓存策略：稳定缓存键，以及在公布窗口内是否进入「等待当天净值」的短轮询状态。
 * 缓存键用 Asia/Shanghai 日期表示；公布窗口前归属上一个公布日，窗口一到归属当天。
 */
function navCachePlan(now: Date, calendar: TradingCalendar): NavCachePlan {
  if (shanghaiMinutesOfDay(now) < NAV_PUBLISH_MINUTES) {
    return { kind: 'stable', key: shanghaiDate(new Date(now.getTime() - 24 * 3600_000)) };
  }
  const today = shanghaiDate(now);
  if (!calendar.isTradingDay(now)) {
    return { kind: 'stable', key: today };
  }
  return { kind: 'pending', key: today, expectedDate: today };
}

/** 带 TTL 的短缓存：用于公布窗口内、当天净值尚未公布时暂存旧值。 */
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
