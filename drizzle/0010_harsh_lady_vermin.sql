CREATE TABLE "bind_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bind_codes" ADD CONSTRAINT "bind_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bind_codes_code_hash_uidx" ON "bind_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "bind_codes_user_created_idx" ON "bind_codes" USING btree ("user_id","created_at");
