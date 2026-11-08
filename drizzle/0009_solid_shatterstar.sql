CREATE TYPE "trade_status" AS ENUM('pending', 'confirmed');--> statement-breakpoint
CREATE TYPE "trade_type" AS ENUM('buy', 'sell', 'switch_out', 'switch_in');--> statement-breakpoint
CREATE TABLE "trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position_id" uuid NOT NULL,
	"type" "trade_type" NOT NULL,
	"status" "trade_status" DEFAULT 'pending' NOT NULL,
	"submitted_date" date NOT NULL,
	"before_cutoff" boolean NOT NULL,
	"application_date" date NOT NULL,
	"settlement_date" date NOT NULL,
	"amount" numeric(24, 2),
	"shares" numeric(24, 4),
	"fee_rate" numeric(9, 6) NOT NULL,
	"confirmed_nav" numeric(24, 4),
	"confirmed_shares" numeric(24, 4),
	"switch_id" uuid,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trades_position_created_idx" ON "trades" USING btree ("position_id","created_at","id");--> statement-breakpoint
CREATE INDEX "trades_status_settlement_idx" ON "trades" USING btree ("status","settlement_date");--> statement-breakpoint
CREATE INDEX "trades_switch_idx" ON "trades" USING btree ("switch_id");