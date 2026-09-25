-- Cached Zalo OA and Messenger display names. Refresh at most daily.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS channel_names JSONB;
