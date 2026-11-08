-- 交易日历按市场区分：已有数据都是 A 股，ADD COLUMN 的默认值把它们归为 'cn'。
ALTER TABLE "trading_holidays" ADD COLUMN "market" text DEFAULT 'cn' NOT NULL;--> statement-breakpoint
ALTER TABLE "trading_holidays" ADD COLUMN "early_close" text;--> statement-breakpoint
ALTER TABLE "trading_holidays" DROP CONSTRAINT "trading_holidays_pkey";--> statement-breakpoint
ALTER TABLE "trading_holidays" ADD CONSTRAINT "trading_holidays_market_date_pk" PRIMARY KEY("market","date");
