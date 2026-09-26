-- Who marked an invoice or order paid, and how.
-- payment_status already allows chua_tt / da_tt / mot_phan (migration 030).
-- kiot_payment_id records a KiotViet payment posted via POST /payments,
-- or the sentinel 'included' when totalPayment was sent on invoice create.
ALTER TABLE kiot_invoices ADD COLUMN IF NOT EXISTS paid_by TEXT;
ALTER TABLE kiot_invoices ADD COLUMN IF NOT EXISTS payment_method TEXT;
ALTER TABLE kiot_invoices ADD COLUMN IF NOT EXISTS kiot_payment_id TEXT;
