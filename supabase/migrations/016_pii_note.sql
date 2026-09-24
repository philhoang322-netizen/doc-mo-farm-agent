-- Note that outbound LLM prompts were scanned for PII.
-- The note lists placeholder counts only. It does not store the raw value.
-- Customer intent and the saved message stay unchanged on this server.

ALTER TABLE outbound_drafts
  ADD COLUMN IF NOT EXISTS pii_note TEXT;
