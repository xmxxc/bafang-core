ALTER TABLE "github_oauth_states" ADD COLUMN IF NOT EXISTS "purpose" text DEFAULT 'login' NOT NULL;--> statement-breakpoint
ALTER TABLE "github_oauth_states" ADD COLUMN IF NOT EXISTS "user_id" uuid;--> statement-breakpoint
ALTER TABLE "github_oauth_states" ADD COLUMN IF NOT EXISTS "session_id" uuid;--> statement-breakpoint
ALTER TABLE "email_verification_codes" ADD COLUMN IF NOT EXISTS "purpose" text DEFAULT 'login' NOT NULL;--> statement-breakpoint
ALTER TABLE "github_oauth_states" ADD CONSTRAINT "github_oauth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_oauth_states" ADD CONSTRAINT "github_oauth_states_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE cascade ON UPDATE no action;
