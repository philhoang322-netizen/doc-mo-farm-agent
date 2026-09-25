-- ============================================================
-- 028 — Tombstones for hard-deleted inbox drafts
--
-- Numbered after 027. Does not use 025 or 026.
-- A deleted draft row is removed. This table keeps only the channel,
-- the source message id, who deleted it, and when. No message body.
-- Existing soft-deleted rows (deleted_at set) are copied here and removed
-- so they cannot be restored and cannot be re-imported.
-- ============================================================

CREATE TABLE IF NOT EXISTS deleted_message_tombstones (
    channel        TEXT NOT NULL,
    source_msg_id  TEXT NOT NULL,
    deleted_by     TEXT,
    deleted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (channel, source_msg_id)
);

INSERT INTO deleted_message_tombstones (channel, source_msg_id, deleted_by, deleted_at)
SELECT channel, btrim(source_msg_id), NULL, COALESCE(deleted_at, NOW())
  FROM outbound_drafts
 WHERE deleted_at IS NOT NULL
   AND source_msg_id IS NOT NULL
   AND btrim(source_msg_id) <> ''
ON CONFLICT (channel, source_msg_id) DO NOTHING;

DELETE FROM training_logs
 WHERE draft_id IN (SELECT id FROM outbound_drafts WHERE deleted_at IS NOT NULL);

DELETE FROM staff_handoffs
 WHERE draft_id IN (SELECT id FROM outbound_drafts WHERE deleted_at IS NOT NULL);

DELETE FROM outbound_drafts WHERE deleted_at IS NOT NULL;
