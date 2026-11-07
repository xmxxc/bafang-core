CREATE TABLE "github_oauth_states" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"browser_hash" text NOT NULL,
	"verifier" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "github_oauth_states_expires_idx" ON "github_oauth_states" USING btree ("expires_at");