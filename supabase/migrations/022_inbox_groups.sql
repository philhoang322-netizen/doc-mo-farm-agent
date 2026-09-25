-- Inbox groups: FB-Sale / FB-DV, sticky manual moves, soft delete, webhook dedupe id.
-- Runtime also ALTER TABLE in services/drafts.js. Nothing here deletes a
-- Facebook or Zalo message, and nothing sends.

ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS biz_line TEXT;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS biz_sticky BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS source_msg_id TEXT;

CREATE INDEX IF NOT EXISTS idx_outbound_drafts_source_msg
    ON outbound_drafts (channel, source_msg_id);
