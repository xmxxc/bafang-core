import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadConfig, toDbConfig } from '../config';
import { createPool } from '../db';
import { importHolidays, type CalendarMarket, type HolidayEntry } from './holidays';

/**
 * 按年导入某个市场的休市日（默认 A 股）。用法：
 *
 *   pnpm trading-calendar:import 2026
 *   pnpm trading-calendar:import 2026 --file /path/to/holidays.json
 *   pnpm trading-calendar:import 2026 --market hk
 *
 * 默认读取仓库内 `data/holidays/<year>.json`（A 股）或 `data/holidays/hk-<year>.json`（港股）。
 * 重复执行幂等（先删该市场该年再插入），不影响其他市场。港股条目可带 `earlyClose`（半日市收市时刻）。
 */

const HolidayFileSchema = z.object({
  year: z.number().int(),
  market: z.enum(['cn', 'hk']).optional(),
  holidays: z.array(
    z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      name: z.string(),
      earlyClose: z.string().optional(),
    }),
  ),
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  weekday: 'short',
});

function parseArgs(argv: string[]): { year: number; file?: string; market: CalendarMarket } {
  const args = argv.slice(2);
  const yearArg = args.find((arg) => /^\d{4}$/.test(arg));
  if (!yearArg) {
    throw new Error('用法：pnpm trading-calendar:import <年份> [--file <路径>] [--market cn|hk]');
  }
  const fileIndex = args.indexOf('--file');
  const file = fileIndex >= 0 ? args[fileIndex + 1] : undefined;
  const marketIndex = args.indexOf('--market');
  const market = marketIndex >= 0 ? args[marketIndex + 1] : 'cn';
  if (market !== 'cn' && market !== 'hk') {
    throw new Error(`--market 只能是 cn 或 hk：${market}`);
  }
  return { year: Number(yearArg), file, market };
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
  const { year, file, market } = parseArgs(process.argv);
  const defaultName = market === 'cn' ? `${year}.json` : `${market}-${year}.json`;
  const filePath =
    file ??
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      `../../data/holidays/${defaultName}`,
    );
  const parsed = HolidayFileSchema.parse(JSON.parse(readFileSync(filePath, 'utf8')));
  if (parsed.year !== year) {
    throw new Error(`数据文件年份 ${parsed.year} 与要导入的年份 ${year} 不一致`);
  }
  if (parsed.market !== undefined && parsed.market !== market) {
    throw new Error(`数据文件市场 ${parsed.market} 与要导入的市场 ${market} 不一致`);
  }
  assertWeekdays(parsed.holidays);

  const pool = createPool(toDbConfig(loadConfig()));
  try {
    await importHolidays(pool, year, parsed.holidays, market);
    console.log(`已导入 ${market} ${year} 年 ${parsed.holidays.length} 个特殊交易日（工作日）`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
