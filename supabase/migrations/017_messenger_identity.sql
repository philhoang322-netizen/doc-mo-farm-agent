-- ============================================================
-- 017 — Messenger identity channel
-- A Facebook PSID is stored as external_id "fb_<psid>" with channel
-- "messenger". Zalo OA / Bot keys are unchanged.
-- ============================================================

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE t.relname = 'customer_identities'
      AND n.nspname = 'public'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%channel%'
  LOOP
    EXECUTE format('ALTER TABLE customer_identities DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE customer_identities
  ADD CONSTRAINT customer_identities_channel_check
  CHECK (channel IN ('oa', 'bot', 'web', 'test', 'messenger'));
