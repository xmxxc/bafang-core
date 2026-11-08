CREATE TABLE "positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"fund_code" text NOT NULL,
	"shares" numeric(24, 4) NOT NULL,
	"total_cost" numeric(24, 2) NOT NULL,
	"snapshot_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "positions_user_channel_idx" ON "positions" USING btree ("user_id","channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "positions_user_fund_channel_uidx" ON "positions" USING btree ("user_id","fund_code","channel_id");