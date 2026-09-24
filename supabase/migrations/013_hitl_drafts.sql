-- ============================================================
-- 013 — Hàng đợi bản nháp HITL (người duyệt trước khi gửi)
--
-- Một dòng là một tin sắp gửi cho khách (Zalo hoặc Messenger).
-- Quản lý sửa draft_reply trên /admin rồi mới bấm gửi.
-- Runtime cũng CREATE TABLE IF NOT EXISTS trong services/drafts.js,
-- nên bản này và hàm ensure schema phải giữ cùng các cột.
-- ============================================================

CREATE TABLE IF NOT EXISTS outbound_drafts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    channel             TEXT NOT NULL CHECK (channel IN ('zalo', 'messenger')),
    customer_name       TEXT,
    customer_phone      TEXT,
    customer_user_id    TEXT,
    customer_intent     TEXT,
    assigned_department TEXT,
    ticket_status       TEXT,
    draft_reply         TEXT NOT NULL DEFAULT '',
    approval_status     TEXT NOT NULL DEFAULT 'PENDING_REVIEW'
                        CHECK (approval_status IN ('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SENT')),
    kiot_summary        TEXT,
    invoice_code        TEXT,
    customer_code       TEXT,
    qr_image_url        TEXT,
    reviewed_at         TIMESTAMPTZ,
    sent_at             TIMESTAMPTZ,
    send_error          TEXT,
    send_via            TEXT,
    send_hook           TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbound_drafts_status_created
    ON outbound_drafts (approval_status, created_at DESC);
