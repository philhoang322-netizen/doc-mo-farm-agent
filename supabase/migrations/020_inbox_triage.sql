-- Inbox triage on HITL drafts: hot / urgent / normal.
-- Runtime also ALTER TABLE in services/drafts.js.

ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS triage_level TEXT;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS triage_label TEXT;

CREATE INDEX IF NOT EXISTS idx_outbound_drafts_triage
    ON outbound_drafts (triage_level, created_at DESC);
