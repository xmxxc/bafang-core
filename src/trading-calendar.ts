import { shanghaiDate } from './clock';
import { loadHolidays } from './trading-calendar/holidays';
import type { Pool } from 'pg';

export interface TradingCalendar {
  isTradingDay(date: Date): boolean;
}

const weekdayFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  weekday: 'short',
});

/**
 * A 股交易日历：工作日（周一至周五）且不在休市日集合内才算交易日。
 * 周末恒为休市（A 股不会因为调休在周末开市）；休市日按年导入（见 `trading-calendar/holidays.ts`），
 * 集合里的日期用 Asia/Shanghai 的 YYYY-MM-DD 表示。
 */
export class ChineseTradingCalendar implements TradingCalendar {
  private readonly holidays: ReadonlySet<string>;

  constructor(holidays: Iterable<string> = []) {
    this.holidays = new Set(holidays);
  }

  isTradingDay(date: Date): boolean {
    const weekday = weekdayFormatter.format(date);
    if (weekday === 'Sat' || weekday === 'Sun') return false;
    return !this.holidays.has(shanghaiDate(date));
  }
}

/** 按启动流程从数据库加载休市日，构建交易日历。 */
export async function loadTradingCalendar(pool: Pool): Promise<TradingCalendar> {
  return new ChineseTradingCalendar(await loadHolidays(pool));
}
