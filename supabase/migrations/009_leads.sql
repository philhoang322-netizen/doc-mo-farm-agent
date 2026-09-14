-- ============================================================
-- 009 — Interest becomes a record, not a memory
--
-- Until now the farm could see that someone talked and whether they bought.
-- What was missing is the middle: which product they were actually after and
-- how close they were. That is the difference between "34 people chatted" and
-- "chị Hương wants turmeric drink for her mother and is worried about taste".
--
-- Kept as columns on customers rather than a separate deals table: a farm has
-- one conversation per person, not a pipeline of parallel opportunities, and a
-- join nobody needs is a join that eventually goes stale.
-- ============================================================

ALTER TABLE customers ADD COLUMN IF NOT EXISTS interest_product TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS interest_note    TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS lead_stage       TEXT DEFAULT 'new'
  CHECK (lead_stage IN ('new','browsing','interested','deciding','ordered','lost'));
ALTER TABLE customers ADD COLUMN IF NOT EXISTS lead_updated_at  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_customers_lead_stage ON customers(lead_stage, lead_updated_at DESC);

-- Anyone who already bought is past the funnel.
UPDATE customers c SET lead_stage = 'ordered', lead_updated_at = NOW()
WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)
  AND (lead_stage IS NULL OR lead_stage = 'new');
