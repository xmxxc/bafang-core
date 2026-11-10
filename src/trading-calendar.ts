import { shanghaiDate } from './clock';
import { loadCoveredCalendar } from './trading-calendar/holidays';
import type { Pool } from 'pg';

export interface TradingCalendar {
  isTradingDay(date: Date): boolean;
  /** 该日期所在市场年度是否已完整导入；未实现此方法表示覆盖未知。 */
  hasCoverage?(date: Date): boolean;
}

/** 带半日市的交易日历（港股）。 */
export interface SessionCalendar extends TradingCalendar {
  /** 当天是半日市时返回收市时刻（Asia/Shanghai 从午夜起算的分钟数），否则返回 null。 */
  earlyCloseMinutes(date: Date): number | null;
}

const weekdayFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  weekday: 'short',
});

function isWeekend(date: Date): boolean {
  const weekday = weekdayFormatter.format(date);
  return weekday === 'Sat' || weekday === 'Sun';
}

/**
 * A 股交易日历：工作日（周一至周五）且不在休市日集合内才算交易日。
 * 周末恒为休市（A 股不会因为调休在周末开市）；休市日按年导入（见 `trading-calendar/holidays.ts`），
 * 集合里的日期用 Asia/Shanghai 的 YYYY-MM-DD 表示。
 */
export class ChineseTradingCalendar implements TradingCalendar {
  private readonly holidays: ReadonlySet<string>;
  private readonly coveredYears: ReadonlySet<number>;

  /** coveredYears 只能来自成功完整年度导入的证明；不得根据 holidays 推断。 */
  constructor(holidays: Iterable<string> = [], coveredYears: Iterable<number> = []) {
    this.holidays = new Set(holidays);
    this.coveredYears = new Set(coveredYears);
  }

  hasCoverage(date: Date): boolean {
    return this.coveredYears.has(Number(shanghaiDate(date).slice(0, 4)));
  }

  isTradingDay(date: Date): boolean {
    if (isWeekend(date)) return false;
    return !this.holidays.has(shanghaiDate(date));
  }
}

/**
 * 港股交易日历：周末与导入的休市日不交易；导入的半日市（圣诞前夕、新年前夕、农历新年前夕
 * 落在工作日时）只有早市，在给定时刻收市。香港与上海同在 UTC+8，日期都按 Asia/Shanghai 表示。
 */
export class HongKongTradingCalendar implements SessionCalendar {
  private readonly holidays: ReadonlySet<string>;
  private readonly earlyCloses: ReadonlyMap<string, number>;
  private readonly coveredYears: ReadonlySet<number>;

  /** @param earlyCloses 半日市日期（YYYY-MM-DD）到收市时刻（HH:MM）。 */
  constructor(
    holidays: Iterable<string> = [],
    earlyCloses: Iterable<[string, string]> = [],
    coveredYears: Iterable<number> = [],
  ) {
    this.coveredYears = new Set(coveredYears);
    this.holidays = new Set(holidays);
    this.earlyCloses = new Map(
      [...earlyCloses].map(([date, time]) => {
        const [hour = 0, minute = 0] = time.split(':').map(Number);
        return [date, hour * 60 + minute];
      }),
    );
  }

  isTradingDay(date: Date): boolean {
    if (isWeekend(date)) return false;
    return !this.holidays.has(shanghaiDate(date));
  }

  hasCoverage(date: Date): boolean {
    return this.coveredYears.has(Number(shanghaiDate(date).slice(0, 4)));
  }

  earlyCloseMinutes(date: Date): number | null {
    return this.isTradingDay(date) ? (this.earlyCloses.get(shanghaiDate(date)) ?? null) : null;
  }
}

/** 按启动流程从数据库加载 A 股休市日，构建交易日历。 */
export async function loadTradingCalendar(pool: Pool): Promise<TradingCalendar> {
  const { days, years } = await loadCoveredCalendar(pool, 'cn');
  return new ChineseTradingCalendar(
    days.filter((day) => day.earlyClose === undefined).map((day) => day.date),
    years,
  );
}

/** 按启动流程从数据库加载港股休市日与半日市，构建港股交易日历。 */
export async function loadHongKongTradingCalendar(pool: Pool): Promise<HongKongTradingCalendar> {
  const { days, years } = await loadCoveredCalendar(pool, 'hk');
  return new HongKongTradingCalendar(
    days.filter((day) => day.earlyClose === undefined).map((day) => day.date),
    days.flatMap((day) => (day.earlyClose ? [[day.date, day.earlyClose] as [string, string]] : [])),
    years,
  );
}
