-- One-off, local only. Brings a database that already applied the previous
-- 0103 in line with the regenerated one, without dropping the plugin tables.
--
-- The regenerated migration differs from the old one by exactly three things:
-- plugin_connections.install_id, its foreign key, and its index. Applying those
-- and restamping the ledger row leaves the database in the state a fresh
-- `drizzle-kit migrate` would produce, and keeps any connections already there.
--
-- Run with:  psql "$DATABASE_URL_UNPOOLED" -f scripts/local/fix-plugin-install-id.sql
BEGIN;

ALTER TABLE "plugin_connections" ADD COLUMN IF NOT EXISTS "install_id" uuid;

ALTER TABLE "plugin_connections"
  DROP CONSTRAINT IF EXISTS "plugin_connections_install_id_plugin_installs_id_fk";
ALTER TABLE "plugin_connections"
  ADD CONSTRAINT "plugin_connections_install_id_plugin_installs_id_fk"
  FOREIGN KEY ("install_id") REFERENCES "public"."plugin_installs"("id")
  ON DELETE set null ON UPDATE no action;

CREATE INDEX IF NOT EXISTS "plugin_connections_install_idx"
  ON "plugin_connections" USING btree ("install_id");

-- drizzle records the sha256 of each migration file. Restamp the row for the
-- old file so the regenerated one reads as applied rather than pending.
UPDATE drizzle.__drizzle_migrations
   SET hash = '4c5b780f8d03f3c42e9c4a667a6ca0e904895b3fc1e0ebe6ac7c919504eebe31',
       created_at = 1788226925313
 WHERE hash = 'd8fab8787d471dc0135cbd9bb20302851d9a361972cfd86ceedde04d18c17165';

COMMIT;
