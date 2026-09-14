-- ============================================================
-- 006 — FAQ at farm scale
--
-- The farm has ~20 products and wants a full FAQ for each, so this table is
-- heading for several hundred rows. Two things follow: answers must be
-- grouped by product to stay findable, and the agent can no longer carry
-- every answer in its prompt — it gets an index and looks the rest up.
-- ============================================================

ALTER TABLE bot_lessons ADD COLUMN IF NOT EXISTS product    TEXT;
ALTER TABLE bot_lessons ADD COLUMN IF NOT EXISTS sku        TEXT;
ALTER TABLE bot_lessons ADD COLUMN IF NOT EXISTS sort_order INT DEFAULT 100;

CREATE INDEX IF NOT EXISTS idx_lessons_product ON bot_lessons(product);

-- The 22 rows imported in 005 all describe the fermented turmeric drink.
UPDATE bot_lessons
SET product = 'Nước nghệ lên men', sku = 'DMF-NNG-001'
WHERE product IS NULL AND note LIKE 'FAQ NGM%';

-- Everything else (the welcome message, ad-hoc lessons taught from a
-- transcript) belongs to no single product.
UPDATE bot_lessons SET product = 'Chung' WHERE product IS NULL;
