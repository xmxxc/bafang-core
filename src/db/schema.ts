import { date, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

export const appMeta = pgTable('app_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 交易日历的特殊日期（按市场、按年导入）：`market` 为 `cn`（A 股）或 `hk`（港股）。
 * `early_close` 为空表示全天休市；有值（`HH:MM`，Asia/Shanghai）表示当天是半日市，在该时刻收市。
 * 只记录落在工作日的日期，周末由交易日历自行判定，因此这里不会出现周六、周日。
 * `date` 用 YYYY-MM-DD 字符串表示。加入 `market` 之前导入的数据都是 A 股，迁移时默认归为 `cn`。
 */
export const tradingHolidays = pgTable(
  'trading_holidays',
  {
    market: text('market').notNull().default('cn'),
    date: date('date', { mode: 'string' }).notNull(),
    name: text('name').notNull(),
    earlyClose: text('early_close'),
  },
  (table) => [primaryKey({ columns: [table.market, table.date] })],
);
