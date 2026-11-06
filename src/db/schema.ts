import { date, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const appMeta = pgTable('app_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A 股休市日（按年导入）。只记录落在工作日的休市日，周末由交易日历自行判定，
 * 因此这里不会出现周六、周日。`date` 用 YYYY-MM-DD 字符串表示。
 */
export const tradingHolidays = pgTable('trading_holidays', {
  date: date('date', { mode: 'string' }).primaryKey(),
  name: text('name').notNull(),
});
