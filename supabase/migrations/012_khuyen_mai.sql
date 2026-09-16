-- ============================================================
-- 012 — Khuyến mãi, và trí nhớ "đã báo giá món này chưa"
--
-- Hai bảng nhỏ, hai việc khác nhau.
--
-- promotions: chính sách khuyến mãi, đặt cho một sản phẩm (có sku) hoặc áp
-- dụng chung cho cả farm (sku để trống). Có ngày bắt đầu và ngày kết thúc để
-- chương trình Tết tự tắt sau Tết — không ai phải nhớ vào tắt tay.
--
-- price_quotes: ghi lại farm đã báo giá món nào cho khách nào. Quy tắc của
-- farm là câu kỹ thuật lần đầu thì kèm giá, các lần sau thôi. Nếu để bot tự
-- nhớ qua lời dặn trong prompt thì nó nhớ lúc được lúc không; ghi vào bảng
-- thì chắc chắn.
-- ============================================================

CREATE TABLE IF NOT EXISTS promotions (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sku         TEXT,             -- NULL = áp dụng cho mọi sản phẩm
    title       TEXT NOT NULL,    -- tên ngắn, hiện ở /admin
    detail      TEXT NOT NULL,    -- câu bot nói với khách, nguyên văn
    starts_on   DATE,             -- NULL = có hiệu lực ngay
    ends_on     DATE,             -- NULL = chạy tới khi tắt tay
    is_active   BOOLEAN DEFAULT TRUE,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promo_live ON promotions(sku) WHERE is_active = TRUE;

-- Một dòng mẫu, tắt sẵn. Để farm mở /admin thấy ngay chỗ điền và định dạng
-- câu chữ, thay vì đối diện một bảng trống không biết bắt đầu từ đâu.
INSERT INTO promotions (sku, title, detail, is_active) VALUES
(NULL, 'Mẫu — sửa hoặc xoá dòng này',
 'Đơn từ 500K farm tặng phí giao trong nội thành ạ.', FALSE)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS price_quotes (
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    sku         TEXT NOT NULL,
    quoted_at   TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (customer_id, sku)
);
