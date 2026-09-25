-- When the customer's message actually arrived at Messenger or Zalo.
-- sent_at already exists (013). sent_by is the admin actor; send_message_id
-- is the id Graph or Zalo returned. 025 and 026 belong to other branches.
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS source_received_at TIMESTAMPTZ;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS sent_by TEXT;
ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS send_message_id TEXT;

-- Cheap only: synthetic Messenger ids embed the webhook millisecond clock.
-- A real Graph mid or Zalo msg_id is left null (the card shows created_at with '~').
UPDATE outbound_drafts
SET source_received_at = to_timestamp(
  substring(source_msg_id from '_([0-9]{13})$')::double precision / 1000.0
)
WHERE source_received_at IS NULL
  AND source_msg_id ~ '^(fb|pb|att)_.+_[0-9]{13}$';
