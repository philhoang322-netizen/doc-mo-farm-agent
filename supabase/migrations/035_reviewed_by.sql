-- Who pressed Duyệt và gửi / "Gửi khách hàng" for a draft that was sent.
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
