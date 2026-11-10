CREATE TABLE "qr_login_tickets" (
	"ticket_hash" text PRIMARY KEY NOT NULL,
	"browser_hash" text NOT NULL,
	"user_id" uuid,
	"confirmed_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "qr_login_tickets" ADD CONSTRAINT "qr_login_tickets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "qr_login_tickets_expires_idx" ON "qr_login_tickets" USING btree ("expires_at");