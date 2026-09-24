-- HITL review form: refund decision + compact ViettelPost address.
-- Runtime also ALTER TABLE in services/drafts.js.

ALTER TABLE outbound_drafts ADD COLUMN IF NOT EXISTS review_form TEXT;
