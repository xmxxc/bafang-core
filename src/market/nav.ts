import { shanghaiDate, shanghaiMinutesOfDay, type Clock } from '../clock';
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
/** 净值公布窗口分界：19:00 Asia/Shanghai。公布前的请求沿用上一个公布日的缓存。 */
const NAV_PUBLISH_MINUTES = 19 * 60;

export interface LatestNav {
  navDate: string;
  unitNav: string;
  cumulativeNav: string | null;
  dailyChange: number;
}

export interface NavPoint {
  date: string;
  unitNav: string;
  cumulativeNav: string | null;
  dailyChange: number;
}

export interface NavService {
  /** 最新一期净值；基金无净值数据时返回 null。 */
  latest(code: string): Promise<LatestNav | null>;
  /** 按区间返回历史净值序列（最新在前）；基金无净值数据时返回 null。 */
  history(code: string, range: NavRange): Promise<NavPoint[] | null>;
}

export function createNavService(deps: { upstream: UpstreamFetcher; clock: Clock }): NavService {
  const latestCache = new DailyCache<LatestNav>();
  const historyCache = new DailyCache<NavPoint[]>();

  return {
    async latest(code) {
      const windowKey = navWindowKey(deps.clock.now());
      const cached = latestCache.get(windowKey, code);
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
      latestCache.set(windowKey, code, latest);
      return latest;
    },

    async history(code, range) {
      const windowKey = navWindowKey(deps.clock.now());
      const cacheKey = `${code}:${range}`;
      const cached = historyCache.get(windowKey, cacheKey);
      if (cached) return cached;
      const startDate = addMonths(shanghaiDate(deps.clock.now()), -RANGE_MONTHS[range]);
      const points: NavPoint[] = [];
      for (let pageIndex = 1; pageIndex <= MAX_PAGES; pageIndex++) {
        const page = await fetchNavPage(deps.upstream, code, pageIndex, PAGE_SIZE, startDate);
        if (page.length === 0) break;
        points.push(...page.map(toNavPoint));
        if (page.length < PAGE_SIZE) break;
      }
      if (points.length === 0) return null;
      historyCache.set(windowKey, cacheKey, points);
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

/**
 * 净值缓存键：以 19:00 Asia/Shanghai 为界，公布前归属上一个公布日、公布后归属当日。
 * 这样净值一经公布，下一次公布窗口到来前请求都命中缓存；公布窗口一到即重新抓取。
 */
function navWindowKey(now: Date): string {
  const date = shanghaiDate(now);
  if (shanghaiMinutesOfDay(now) < NAV_PUBLISH_MINUTES) {
    return shanghaiDate(new Date(now.getTime() - 24 * 3600_000));
  }
  return date;
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
