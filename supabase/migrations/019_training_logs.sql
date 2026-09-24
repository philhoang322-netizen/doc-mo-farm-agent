-- ============================================================
-- 019 — Nhật ký huấn luyện: câu quản lý sửa trước khi duyệt gửi
--
-- Chỉ ghi khi bản gửi khác bản AI gốc (so sau khi trim).
-- Runtime cũng CREATE TABLE trong services/trainingLog.js.
-- ============================================================

ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS customer_query TEXT;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS ai_draft_version TEXT;

CREATE TABLE IF NOT EXISTS training_logs (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    draft_id                    UUID,
    sales_channel               TEXT,
    customer_original_query     TEXT NOT NULL DEFAULT '',
    customer_intent             TEXT,
    ai_draft_version            TEXT NOT NULL,
    manager_corrected_version   TEXT NOT NULL,
    action                      TEXT NOT NULL DEFAULT 'STORE_AS_FEW_SHOT_EXAMPLE'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_training_logs_draft
    ON training_logs (draft_id) WHERE draft_id IS NOT NULL;
