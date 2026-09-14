-- ============================================================
-- 007 — Long conversations without long prompts
--
-- Sending the last N turns verbatim is the only memory the agent had, so a
-- customer asking their tenth question found it had forgotten the first.
-- Raising N fixes the memory and inflates every message.
--
-- Instead: keep a rolling summary of what the conversation has established.
-- Written once every few messages by a small model, carried in the prompt as
-- a short block, it holds the whole thread for a fraction of the cost.
-- ============================================================

ALTER TABLE customers ADD COLUMN IF NOT EXISTS convo_summary        TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS convo_summary_at     TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS convo_summary_upto   INT DEFAULT 0;
