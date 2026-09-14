-- ============================================================
-- 008 — Following up on customers who went quiet
--
-- The largest single source of lost sales in chat commerce is not a bad
-- answer, it is silence: a customer asks the price, gets it, and never comes
-- back. Industry reporting puts recovery from a timely, specific follow-up at
-- roughly 10-35% of those conversations.
--
-- Rules encoded here: at most two follow-ups ever, never at night, never after
-- an order, never to someone waiting on a human, and never to someone who
-- asked the bot to stop.
-- ============================================================

ALTER TABLE customers ADD COLUMN IF NOT EXISTS followup_stage  INT DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS followup_last_at TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS followup_optout  BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_customers_followup
  ON customers(followup_stage, last_seen_at)
  WHERE followup_optout = FALSE AND bot_paused = FALSE;
