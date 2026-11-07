import { and, eq, gte, lt } from 'drizzle-orm';
import type { Pool } from 'pg';
import { createDb } from '../db';
import { tradingHolidays } from '../db/schema';

/** 交易日历所属的市场：cn A 股、hk 港股。 */
export type CalendarMarket = 'cn' | 'hk';

export interface HolidayEntry {
  /** Asia/Shanghai 的 YYYY-MM-DD。 */
  date: string;
  /** 休市原因，例如「春节」。 */
  name: string;
  /** 半日市的收市时刻 `HH:MM`（Asia/Shanghai）；省略表示全天休市。目前只有港股有半日市。 */
  earlyClose?: string;
}

/** 读取全部已导入的休市日（工作日，不含周末），返回 YYYY-MM-DD 字符串列表。默认 A 股。 */
export async function loadHolidays(pool: Pool, market: CalendarMarket = 'cn'): Promise<string[]> {
  return (await loadCalendarDays(pool, market))
    .filter((entry) => entry.earlyClose === undefined)
    .map((entry) => entry.date);
}

/** 读取某个市场已导入的全部特殊日期（全天休市与半日市）。 */
export async function loadCalendarDays(
  pool: Pool,
  market: CalendarMarket,
): Promise<HolidayEntry[]> {
  const db = createDb(pool);
  const rows = await db
    .select({
      date: tradingHolidays.date,
      name: tradingHolidays.name,
      earlyClose: tradingHolidays.earlyClose,
    })
    .from(tradingHolidays)
    .where(eq(tradingHolidays.market, market))
    .orderBy(tradingHolidays.date);
  return rows.map((row) => ({
    date: row.date,
    name: row.name,
    ...(row.earlyClose ? { earlyClose: row.earlyClose } : {}),
  }));
}

/**
 * 按年导入某个市场的休市日（默认 A 股）：先删除该市场该年已有的日期再插入，重复执行结果不变（幂等），
 * 不影响其他市场的数据。只应导入落在工作日的日期；周末由交易日历自行判定。
 * 删除与插入在同一个事务里完成，任一失败整体回滚，原年数据保持不变；
 * 写入前校验数据（日期格式合法、属于目标年份、无重复、半日市时刻合法），不合法直接拒绝。
 */
export async function importHolidays(
  pool: Pool,
  year: number,
  holidays: HolidayEntry[],
  market: CalendarMarket = 'cn',
): Promise<void> {
  validateHolidays(year, holidays, market);
  const db = createDb(pool);
  const start = `${year}-01-01`;
  const end = `${year + 1}-01-01`;
  await db.transaction(async (tx) => {
    await tx
      .delete(tradingHolidays)
      .where(
        and(
          eq(tradingHolidays.market, market),
          gte(tradingHolidays.date, start),
          lt(tradingHolidays.date, end),
        ),
      );
    if (holidays.length > 0) {
      await tx.insert(tradingHolidays).values(
        holidays.map((entry) => ({
          market,
          date: entry.date,
          name: entry.name,
          earlyClose: entry.earlyClose ?? null,
        })),
      );
    }
  });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 校验休市日：日期格式合法、属于目标年份、日期无重复；半日市只用于港股且时刻为 HH:MM。 */
function validateHolidays(year: number, holidays: HolidayEntry[], market: CalendarMarket): void {
  const seen = new Set<string>();
  for (const entry of holidays) {
    if (!DATE_RE.test(entry.date)) {
      throw new Error(`休市日格式必须是 YYYY-MM-DD：${entry.date}`);
    }
    if (entry.date.slice(0, 4) !== String(year)) {
      throw new Error(`休市日 ${entry.date} 不属于要导入的 ${year} 年`);
    }
    if (seen.has(entry.date)) {
      throw new Error(`休市日重复：${entry.date}`);
    }
    if (entry.earlyClose !== undefined) {
      if (market !== 'hk') throw new Error(`只有港股日历支持半日市：${entry.date}`);
      if (!TIME_RE.test(entry.earlyClose)) {
        throw new Error(`半日市收市时刻必须是 HH:MM：${entry.date} ${entry.earlyClose}`);
      }
    }
    seen.add(entry.date);
  }
}
