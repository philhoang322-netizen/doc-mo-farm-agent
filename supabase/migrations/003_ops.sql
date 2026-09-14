-- ============================================================
-- 003 — Operations: durable app state + human handoff
-- ============================================================

-- Key/value store that survives restarts. Holds the rotating Zalo
-- tokens, which previously lived only in memory and in the logs.
CREATE TABLE IF NOT EXISTS app_state (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Human handoff: when true, the AI stays silent for this customer
-- and a person answers instead.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS bot_paused    BOOLEAN     DEFAULT FALSE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS paused_reason TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS paused_at     TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_customers_paused ON customers(bot_paused) WHERE bot_paused = TRUE;

-- Dedup of inbound webhook events across restarts and replicas.
CREATE TABLE IF NOT EXISTS processed_events (
    msg_id     TEXT PRIMARY KEY,
    channel    TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_processed_events_created ON processed_events(created_at);
