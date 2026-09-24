-- ============================================================
-- 014 — Nhật ký thao tác (append-only)
--
-- Một dòng là một việc đã xảy ra: khách nhắn, AI soạn, quản lý sửa
-- hoặc duyệt, nhân viên đổi trạng thái đơn, hệ thống đẩy KiotViet.
-- Không UPDATE / DELETE. Runtime cũng tạo bảng trong services/audit.js.
-- Không ghi token, mật khẩu, hay secret — app redact trước khi INSERT.
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_logs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    seq          BIGSERIAL NOT NULL,
    at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor        TEXT NOT NULL CHECK (char_length(actor) BETWEEN 1 AND 120),
    action       TEXT NOT NULL CHECK (char_length(action) BETWEEN 1 AND 80),
    entity_type  TEXT NOT NULL CHECK (char_length(entity_type) BETWEEN 1 AND 40),
    entity_id    TEXT NOT NULL CHECK (char_length(entity_id) BETWEEN 1 AND 200),
    before       JSONB,
    after        JSONB,
    meta         JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_at
    ON audit_logs (at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity
    ON audit_logs (entity_type, entity_id, at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action
    ON audit_logs (action, at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_conversation
    ON audit_logs ((meta->>'conversation_id'), at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_order
    ON audit_logs ((meta->>'order_number'), at DESC);

CREATE OR REPLACE FUNCTION audit_logs_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'audit_logs is append-only';
END;
$$;

DROP TRIGGER IF EXISTS audit_logs_no_update ON audit_logs;
CREATE TRIGGER audit_logs_no_update
    BEFORE UPDATE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION audit_logs_reject_mutation();

DROP TRIGGER IF EXISTS audit_logs_no_delete ON audit_logs;
CREATE TRIGGER audit_logs_no_delete
    BEFORE DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION audit_logs_reject_mutation();
