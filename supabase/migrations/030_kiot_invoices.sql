-- KiotViet invoices and orders created from the review inbox.
-- 028/029 are reserved for the unmerged hard-delete work.
CREATE TABLE IF NOT EXISTS kiot_invoices (
  id              TEXT PRIMARY KEY,
  kiot_id         TEXT,
  code            TEXT NOT NULL,
  order_code      TEXT,
  order_kiot_id   TEXT,
  draft_id        TEXT,
  document_type   TEXT NOT NULL DEFAULT 'invoice'
                  CHECK (document_type IN ('invoice', 'order')),
  customer_code   TEXT,
  customer_name   TEXT,
  customer_phone  TEXT,
  channel         TEXT CHECK (channel IS NULL OR channel IN ('zalo', 'fb')),
  items           JSONB NOT NULL DEFAULT '[]'::jsonb,
  total           INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at         TIMESTAMPTZ,
  payment_status  TEXT NOT NULL DEFAULT 'chua_tt'
                  CHECK (payment_status IN ('chua_tt', 'da_tt', 'mot_phan')),
  paid_at         TIMESTAMPTZ,
  amount_paid     INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS kiot_invoices_code_uidx ON kiot_invoices (code);
CREATE INDEX IF NOT EXISTS kiot_invoices_order_code_idx ON kiot_invoices (order_code);
CREATE INDEX IF NOT EXISTS kiot_invoices_phone_idx ON kiot_invoices (customer_phone);
CREATE INDEX IF NOT EXISTS kiot_invoices_created_idx ON kiot_invoices (created_at DESC);
CREATE INDEX IF NOT EXISTS kiot_invoices_draft_idx ON kiot_invoices (draft_id);
