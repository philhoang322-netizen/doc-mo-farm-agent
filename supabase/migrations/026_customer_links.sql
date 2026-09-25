-- Phone-keyed profile linking Zalo, Facebook PSID, and KiotViet.
-- The existing customers / customer_identities tables stay the memory store.
-- This table is what the inbox card reads, including the KiotViet customer id.
CREATE TABLE IF NOT EXISTS customer_links (
  phone              TEXT PRIMARY KEY,
  name               TEXT,
  zalo_user_id       TEXT,
  facebook_psid      TEXT,
  kiot_customer_id   TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_links_zalo ON customer_links (zalo_user_id);
CREATE INDEX IF NOT EXISTS idx_customer_links_psid ON customer_links (facebook_psid);
