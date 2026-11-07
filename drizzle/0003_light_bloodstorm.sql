DROP INDEX "login_methods_user_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "login_methods_user_type_uidx" ON "login_methods" USING btree ("user_id","type");