-- ============================================================
-- 002 — Cross-channel identity
-- One customer can be reached on several Zalo channels (OA, Bot).
-- Zalo issues a DIFFERENT id per channel, so we keep a mapping table
-- and merge customers once a shared phone number proves they are one person.
-- ============================================================

CREATE TABLE IF NOT EXISTS customer_identities (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id  UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    channel      TEXT NOT NULL CHECK (channel IN ('oa','bot','web','test')),
    external_id  TEXT NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (channel, external_id)
);

CREATE INDEX IF NOT EXISTS idx_identities_customer ON customer_identities(customer_id);
CREATE INDEX IF NOT EXISTS idx_identities_external ON customer_identities(external_id);

-- Phone is the merge key — index it (not unique: merges resolve duplicates).
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone) WHERE phone IS NOT NULL;

-- Backfill identities from existing customers.
-- Keys written before this migration used the form "bot_<chatId>" for the Bot
-- channel and a bare numeric id for the OA channel.
INSERT INTO customer_identities (customer_id, channel, external_id)
SELECT
    id,
    CASE
        WHEN zalo_user_id LIKE 'bot\_%'  THEN 'bot'
        WHEN zalo_user_id LIKE 'test\_%' THEN 'test'
        WHEN zalo_user_id = 'debug_user' THEN 'test'
        ELSE 'oa'
    END,
    zalo_user_id
FROM customers
WHERE zalo_user_id IS NOT NULL
ON CONFLICT (channel, external_id) DO NOTHING;

-- Audit trail of merges, so a wrong merge can be investigated later.
CREATE TABLE IF NOT EXISTS customer_merges (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    survivor_id   UUID NOT NULL,
    merged_id     UUID NOT NULL,
    matched_on    TEXT,
    merged_at     TIMESTAMPTZ DEFAULT NOW()
);
