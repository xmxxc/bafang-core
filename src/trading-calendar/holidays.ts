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
 * 删除与插入在同一个事务里完成，任一失败整体回滚，原年数据保持不变；
 * 写入前校验数据（日期格式合法、属于目标年份、无重复），不合法直接拒绝。
 */
export async function importHolidays(
  pool: Pool,
  year: number,
  holidays: HolidayEntry[],
): Promise<void> {
  validateHolidays(year, holidays);
  const db = createDb(pool);
  const start = `${year}-01-01`;
  const end = `${year + 1}-01-01`;
  await db.transaction(async (tx) => {
    await tx
      .delete(tradingHolidays)
      .where(and(gte(tradingHolidays.date, start), lt(tradingHolidays.date, end)));
    if (holidays.length > 0) {
      await tx.insert(tradingHolidays).values(
        holidays.map((entry) => ({
          date: entry.date,
          name: entry.name,
        })),
      );
    }
  });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 校验休市日：日期格式合法、属于目标年份、日期无重复。 */
function validateHolidays(year: number, holidays: HolidayEntry[]): void {
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
    seen.add(entry.date);
  }
}
