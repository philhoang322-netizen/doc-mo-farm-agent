-- Approved FAQ for grounded drafts, plus versioned bot rules.
-- Answer text is loaded after deploy. This migration has no FAQ rows.

CREATE TABLE IF NOT EXISTS faq_items (
  code           TEXT PRIMARY KEY,
  item_group     TEXT NOT NULL DEFAULT '',
  product        TEXT NOT NULL DEFAULT '',
  question       TEXT NOT NULL,
  variants       TEXT NOT NULL DEFAULT '',
  answer         TEXT NOT NULL DEFAULT '',
  conditions     TEXT NOT NULL DEFAULT '',
  action_flag    TEXT NOT NULL,
  verify_status  TEXT NOT NULL,
  source         TEXT NOT NULL DEFAULT '',
  enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  extra          JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_faq_items_enabled ON faq_items (enabled);

CREATE TABLE IF NOT EXISTS bot_rule_versions (
  version     INTEGER PRIMARY KEY,
  body        TEXT NOT NULL,
  actor       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS faq_review TEXT;
