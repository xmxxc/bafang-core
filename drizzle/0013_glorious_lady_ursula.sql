CREATE TABLE "switches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_position_id" uuid NOT NULL,
	"target_fund_code" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trades" ALTER COLUMN "position_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "switches" ADD CONSTRAINT "switches_source_position_id_positions_id_fk" FOREIGN KEY ("source_position_id") REFERENCES "positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_switch_id_switches_id_fk" FOREIGN KEY ("switch_id") REFERENCES "switches"("id") ON DELETE cascade ON UPDATE no action;