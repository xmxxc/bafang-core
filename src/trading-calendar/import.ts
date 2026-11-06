import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadConfig, toDbConfig } from '../config';
import { createPool } from '../db';
import { importHolidays, type HolidayEntry } from './holidays';

/**
 * 按年导入 A 股休市日。用法：
 *
 *   pnpm trading-calendar:import 2026
 *   pnpm trading-calendar:import 2026 --file /path/to/holidays.json
 *
 * 默认读取仓库内 `data/holidays/<year>.json`。重复执行幂等（先删该年再插入）。
 */

const HolidayFileSchema = z.object({
  year: z.number().int(),
  holidays: z.array(
    z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      name: z.string(),
    }),
  ),
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  weekday: 'short',
});

function parseArgs(argv: string[]): { year: number; file?: string } {
  const args = argv.slice(2);
  const yearArg = args.find((arg) => /^\d{4}$/.test(arg));
  if (!yearArg) {
    throw new Error('用法：pnpm trading-calendar:import <年份> [--file <路径>]');
  }
  const fileIndex = args.indexOf('--file');
  const file = fileIndex >= 0 ? args[fileIndex + 1] : undefined;
  return { year: Number(yearArg), file };
}

function assertWeekdays(holidays: HolidayEntry[]): void {
  for (const entry of holidays) {
    if (!DATE_RE.test(entry.date)) {
      throw new Error(`休市日格式必须是 YYYY-MM-DD：${entry.date}`);
    }
    const weekday = WEEKDAY_FORMATTER.format(new Date(`${entry.date}T00:00:00+08:00`));
    if (weekday === 'Sat' || weekday === 'Sun') {
      throw new Error(`休市日不应包含周末（${entry.date} 是 ${weekday}），周末由交易日历自行判定`);
    }
  }
}

async function main(): Promise<void> {
  const { year, file } = parseArgs(process.argv);
  const filePath =
    file ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../../data/holidays/${year}.json`);
  const parsed = HolidayFileSchema.parse(JSON.parse(readFileSync(filePath, 'utf8')));
  if (parsed.year !== year) {
    throw new Error(`数据文件年份 ${parsed.year} 与要导入的年份 ${year} 不一致`);
  }
  assertWeekdays(parsed.holidays);

  const pool = createPool(toDbConfig(loadConfig()));
  try {
    await importHolidays(pool, year, parsed.holidays);
    console.log(`已导入 ${year} 年 ${parsed.holidays.length} 个休市日（工作日）`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
