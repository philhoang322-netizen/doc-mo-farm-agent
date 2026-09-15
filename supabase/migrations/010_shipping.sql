-- ============================================================
-- 010 — Delivery and payment terms the bot can actually quote
--
-- "Ship bao nhiêu?" and "mấy ngày tới?" come up in nearly every sale, and
-- they come up at the worst possible moment: right when the customer has
-- decided to buy. Until now the agent had nothing to answer with, so it fell
-- back on "farm sẽ hỏi lại" — which is where the order quietly dies.
--
-- Kept as rows the farm edits, not text in the prompt, so a shipping fee
-- change never needs a developer.
-- ============================================================

CREATE TABLE IF NOT EXISTS shipping_zones (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        TEXT NOT NULL,              -- "Nội thành TP.HCM"
    keywords    TEXT,                       -- "hcm, sài gòn, quận 1, thủ đức"
    fee         NUMERIC(12,2) NOT NULL DEFAULT 0,
    free_from   NUMERIC(12,2),              -- free shipping above this order value
    eta         TEXT,                       -- "1-2 ngày"
    note        TEXT,
    is_active   BOOLEAN DEFAULT TRUE,
    sort_order  INT DEFAULT 100,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zones_active ON shipping_zones(is_active, sort_order);

-- Starting rows so the bot is never empty-handed. The farm corrects these;
-- they are placeholders, deliberately plain, not invented promises.
INSERT INTO shipping_zones (name, keywords, fee, free_from, eta, sort_order) VALUES
  ('Nội thành TP.HCM', 'hcm, ho chi minh, sai gon, saigon, tphcm, quan 1, quan 3, quan 7, binh thanh, phu nhuan, thu duc, go vap, tan binh', 25000, 500000, '1-2 ngày', 10),
  ('Đồng Nai, Bình Dương, Vũng Tàu', 'dong nai, bien hoa, binh duong, thu dau mot, vung tau, ba ria, long thanh, trang bom', 30000, 500000, '2-3 ngày', 20),
  ('Các tỉnh còn lại', 'ha noi, da nang, can tho, hue, nha trang, hai phong, tinh khac', 40000, 700000, '3-5 ngày', 90)
ON CONFLICT DO NOTHING;

-- Free-text terms that don't fit a zone: minimum order, cash on delivery,
-- returns, invoices. One editable block, read into the prompt.
INSERT INTO app_state (key, value) VALUES
  ('shipping_terms',
   'Đơn tối thiểu: 200.000đ.
Thanh toán: chuyển khoản trước, hoặc COD (trả tiền khi nhận) tuỳ khu vực.
Đồ uống lên men cần giữ mát, farm đóng thùng xốp cho đơn đi tỉnh.
Farm gửi hàng các ngày trong tuần, trừ Chủ nhật.')
ON CONFLICT (key) DO NOTHING;
