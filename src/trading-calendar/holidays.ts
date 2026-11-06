import { and, gte, lt } from 'drizzle-orm';
import type { Pool } from 'pg';
import { createDb } from '../db';
import { tradingHolidays } from '../db/schema';

export interface HolidayEntry {
  /** Asia/Shanghai 的 YYYY-MM-DD。 */
  date: string;
  /** 休市原因，例如「春节」。 */
  name: string;
}

/** 读取全部已导入的休市日（工作日，不含周末），返回 YYYY-MM-DD 字符串列表。 */
export async function loadHolidays(pool: Pool): Promise<string[]> {
  const db = createDb(pool);
  const rows = await db
    .select({ date: tradingHolidays.date })
    .from(tradingHolidays)
    .orderBy(tradingHolidays.date);
  return rows.map((row) => row.date);
}

/**
 * 按年导入休市日：先删除该年已有的休市日再插入，重复执行结果不变（幂等）。
 * 只应导入落在工作日的休市日；周末由 `ChineseTradingCalendar` 自行判定。
 */
export async function importHolidays(
  pool: Pool,
  year: number,
  holidays: HolidayEntry[],
): Promise<void> {
  const db = createDb(pool);
  const start = `${year}-01-01`;
  const end = `${year + 1}-01-01`;
  await db
    .delete(tradingHolidays)
    .where(and(gte(tradingHolidays.date, start), lt(tradingHolidays.date, end)));
  if (holidays.length > 0) {
    await db.insert(tradingHolidays).values(
      holidays.map((entry) => ({
        date: entry.date,
        name: entry.name,
      })),
    );
  }
}
