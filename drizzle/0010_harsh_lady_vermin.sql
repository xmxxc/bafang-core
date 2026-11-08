CREATE TABLE "bind_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bind_codes" ADD CONSTRAINT "bind_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bind_codes_user_created_idx" ON "bind_codes" USING btree ("user_id","created_at");

--> statement-breakpoint
CREATE TABLE "bind_code_failures" (
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"window_started" timestamp with time zone NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "bind_code_failures_scope_key_pk" PRIMARY KEY("scope","key")
);
--> statement-breakpoint
CREATE INDEX "bind_code_failures_window_idx" ON "bind_code_failures" USING btree ("window_started");
--> statement-breakpoint
CREATE UNIQUE INDEX "bind_codes_code_hash_active_uidx" ON "bind_codes" USING btree ("code_hash") WHERE "bind_codes"."active";
