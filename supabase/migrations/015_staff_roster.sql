-- ============================================================
-- 014 — Staff roster and handover assignments
--
-- Who is on shift (Asia/Ho_Chi_Minh) and which conversation was
-- handed to them. notify_target is a Zalo Bot chat id. Blank or
-- "owner" means the existing owner alert chat (ALERT_BOT_CHAT_ID).
-- Runtime also CREATE TABLE IF NOT EXISTS in services/roster.js.
-- ============================================================

CREATE TABLE IF NOT EXISTS staff_shifts (
    id            UUID PRIMARY KEY,
    name          TEXT NOT NULL,
    notify_target TEXT,
    weekdays      TEXT NOT NULL,
    start_min     INT NOT NULL,
    end_min       INT NOT NULL,
    timezone      TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
    online        BOOLEAN NOT NULL DEFAULT FALSE,
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS staff_handoffs (
    id                UUID PRIMARY KEY,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    external_id       TEXT,
    customer_id       UUID,
    draft_id          UUID,
    reason            TEXT,
    urgency           TEXT,
    source            TEXT,
    label             TEXT,
    assignee_name     TEXT,
    assignee_id       UUID,
    notify_target     TEXT,
    mode              TEXT,
    window_label      TEXT,
    next_label        TEXT,
    starts_in_minutes INT,
    last_message      TEXT,
    notified          BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_staff_handoffs_created
    ON staff_handoffs (created_at DESC);
