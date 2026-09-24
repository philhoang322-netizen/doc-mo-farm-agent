-- ============================================================
-- 018 — Vận hành tin: loại tin, mẫu, kênh bán
--
-- approval_status giữ nguyên 4 giá trị HITL.
-- Trạng thái hiển thị (Thành công, Thất bại, Chờ xử lý,
-- Đang gửi, Chờ gửi) được tính từ các cột này, không ghi đè.
-- Runtime cũng ALTER trong services/drafts.js.
-- ============================================================

ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS message_type TEXT;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS template_name TEXT;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS sales_channel TEXT;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS delivery_phase TEXT;

CREATE TABLE IF NOT EXISTS sales_channels (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
