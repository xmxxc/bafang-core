CREATE UNIQUE INDEX IF NOT EXISTS "channels_user_name_uidx" ON "channels" USING btree ("user_id","name");
