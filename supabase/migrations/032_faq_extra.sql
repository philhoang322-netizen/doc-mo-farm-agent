-- Extra FAQ columns from the 16-column export (intent, notes, source date).
-- No FAQ rows. Answer text stays out of this migration.

ALTER TABLE faq_items ADD COLUMN IF NOT EXISTS extra JSONB NOT NULL DEFAULT '{}'::jsonb;
