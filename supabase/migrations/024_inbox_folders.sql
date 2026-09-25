-- Inbox folders: Chờ xử lý, Đã gửi, Đã mua, Do dự, Từ chối.
-- inbox_prev_status tags the folder a new customer message came back from.
-- Runtime also ALTER TABLE in services/drafts.js.

ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS inbox_status TEXT;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS inbox_prev_status TEXT;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS inbox_status_at TIMESTAMPTZ;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS inbox_status_auto BOOLEAN;
