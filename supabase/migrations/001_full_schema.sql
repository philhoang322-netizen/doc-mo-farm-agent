-- ============================================================
-- Doc Mo Farm — Full Production Schema Migration
-- Run this against your PostgreSQL / Supabase database
-- ============================================================

-- Enable pgvector for embeddings (Supabase has this by default)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- STEP 1: BACKUP OLD CONVERSATIONS before dropping anything
-- Renames old table so data is preserved, migrated later
-- ============================================================
DO $$
BEGIN
  -- Backup old conversations table if it exists
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'conversations') THEN
    ALTER TABLE conversations RENAME TO _conversations_backup;
    RAISE NOTICE 'Backed up conversations → _conversations_backup';
  END IF;

  -- Backup old customers table if it exists (preserve IDs for FK mapping)
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'customers') THEN
    ALTER TABLE customers RENAME TO _customers_backup;
    RAISE NOTICE 'Backed up customers → _customers_backup';
  END IF;

  -- Drop old dependent tables
  DROP TABLE IF EXISTS order_items CASCADE;
  DROP TABLE IF EXISTS orders CASCADE;
  DROP TABLE IF EXISTS products CASCADE;
END $$;

-- ============================================================
-- DOMAIN 1: CUSTOMERS
-- ============================================================

CREATE TABLE customers (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    zalo_user_id        TEXT UNIQUE,
    phone               TEXT,
    full_name           TEXT,
    display_name        TEXT,
    avatar_url          TEXT,
    gender              TEXT CHECK (gender IN ('male','female','unknown')) DEFAULT 'unknown',
    city                TEXT,
    district            TEXT,
    full_address        TEXT,
    status              TEXT DEFAULT 'active'
                        CHECK (status IN ('active','blocked','churned','vip')),
    customer_tier       TEXT DEFAULT 'new'
                        CHECK (customer_tier IN ('new','regular','loyal','vip','champion')),
    acquisition_channel TEXT DEFAULT 'zalo_oa',
    preferred_language  TEXT DEFAULT 'vi',
    first_seen_at       TIMESTAMPTZ DEFAULT NOW(),
    last_seen_at        TIMESTAMPTZ DEFAULT NOW(),
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_customers_zalo_user_id ON customers(zalo_user_id);
CREATE INDEX idx_customers_status ON customers(status);
CREATE INDEX idx_customers_tier ON customers(customer_tier);
CREATE INDEX idx_customers_last_seen ON customers(last_seen_at DESC);

-- Extended profile (AI-extracted)
CREATE TABLE customer_profiles (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id         UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    household_size      INT,
    has_children        BOOLEAN,
    has_elderly         BOOLEAN,
    health_concerns     TEXT[],
    dietary_prefs       TEXT[],
    allergies           TEXT[],
    price_sensitivity   TEXT CHECK (price_sensitivity IN ('low','medium','high')),
    preferred_delivery_day TEXT[],
    preferred_delivery_time TEXT,
    communication_tone  TEXT DEFAULT 'friendly',
    ai_notes            JSONB DEFAULT '{}',
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(customer_id)
);

-- Structured preferences (queryable)
CREATE TABLE customer_preferences (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id         UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    preference_type     TEXT NOT NULL,
    preference_key      TEXT NOT NULL,
    preference_value    TEXT NOT NULL,
    confidence          FLOAT DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
    source              TEXT CHECK (source IN ('explicit','inferred')) DEFAULT 'inferred',
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(customer_id, preference_type, preference_key)
);

CREATE INDEX idx_prefs_customer ON customer_preferences(customer_id);

-- ============================================================
-- DOMAIN 2: CONVERSATIONS & AI MEMORY
-- ============================================================

CREATE TABLE conversation_sessions (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id         UUID REFERENCES customers(id),
    zalo_user_id        TEXT,
    channel             TEXT DEFAULT 'zalo_oa',
    status              TEXT DEFAULT 'active'
                        CHECK (status IN ('active','closed','escalated')),
    intent              TEXT,
    topic               TEXT,
    message_count       INT DEFAULT 0,
    ai_handled          BOOLEAN DEFAULT TRUE,
    escalated_to_human  BOOLEAN DEFAULT FALSE,
    context_summary     TEXT,
    resolved            BOOLEAN DEFAULT FALSE,
    started_at          TIMESTAMPTZ DEFAULT NOW(),
    ended_at            TIMESTAMPTZ,
    last_message_at     TIMESTAMPTZ DEFAULT NOW(),
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sessions_customer ON conversation_sessions(customer_id);
CREATE INDEX idx_sessions_zalo_user ON conversation_sessions(zalo_user_id);
CREATE INDEX idx_sessions_status ON conversation_sessions(status);
CREATE INDEX idx_sessions_last_message ON conversation_sessions(last_message_at DESC);

CREATE TABLE messages (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id          UUID REFERENCES conversation_sessions(id),
    customer_id         UUID REFERENCES customers(id),
    zalo_user_id        TEXT,
    role                TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
    content             TEXT NOT NULL,
    content_type        TEXT DEFAULT 'text',
    zalo_message_id     TEXT UNIQUE,
    model_used          TEXT,
    tokens_used         INT,
    extracted_intent    TEXT,
    extracted_entities  JSONB DEFAULT '{}',
    sentiment           TEXT CHECK (sentiment IN ('positive','neutral','negative')),
    sentiment_score     FLOAT,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_messages_session ON messages(session_id);
CREATE INDEX idx_messages_customer ON messages(customer_id);
CREATE INDEX idx_messages_zalo_user ON messages(zalo_user_id);
CREATE INDEX idx_messages_created ON messages(created_at DESC);
CREATE INDEX idx_messages_role ON messages(role);

-- Permanent AI memory per customer
CREATE TABLE ai_memories (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id         UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    memory_type         TEXT NOT NULL
                        CHECK (memory_type IN (
                            'fact','preference','order_pattern',
                            'complaint','life_event','relationship','financial'
                        )),
    memory_key          TEXT NOT NULL,
    memory_value        TEXT NOT NULL,
    memory_json         JSONB DEFAULT '{}',
    confidence          FLOAT DEFAULT 0.8 CHECK (confidence BETWEEN 0 AND 1),
    importance          INT DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
    source_session_id   UUID REFERENCES conversation_sessions(id),
    is_active           BOOLEAN DEFAULT TRUE,
    expires_at          TIMESTAMPTZ,
    last_referenced     TIMESTAMPTZ DEFAULT NOW(),
    reference_count     INT DEFAULT 1,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(customer_id, memory_type, memory_key)
);

CREATE INDEX idx_memories_customer ON ai_memories(customer_id);
CREATE INDEX idx_memories_type ON ai_memories(memory_type);
CREATE INDEX idx_memories_active ON ai_memories(is_active) WHERE is_active = TRUE;
CREATE INDEX idx_memories_importance ON ai_memories(customer_id, importance DESC);

-- ============================================================
-- DOMAIN 3: PRODUCTS & COMMERCE
-- ============================================================

CREATE TABLE products (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sku             TEXT UNIQUE NOT NULL,
    name            TEXT NOT NULL,
    name_vi         TEXT NOT NULL,
    description     TEXT,
    category        TEXT NOT NULL,
    subcategory     TEXT,
    base_price      NUMERIC(12,2) NOT NULL,
    sale_price      NUMERIC(12,2),
    unit            TEXT DEFAULT 'cái',
    stock_qty       INT DEFAULT 0,
    low_stock_threshold INT DEFAULT 10,
    is_available    BOOLEAN DEFAULT TRUE,
    image_url       TEXT,
    tags            TEXT[],
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_products_category ON products(category);
CREATE INDEX idx_products_available ON products(is_available);

-- Seed Doc Mo Farm products
INSERT INTO products (sku, name, name_vi, category, base_price, unit, tags) VALUES
('DMF-SHP-001', 'Premium Shampoo', 'Dầu gội cao cấp', 'personal_care', 180000, 'chai', ARRAY['hair','organic','premium']),
('DMF-BTH-001', 'Body Wash', 'Dầu tắm', 'personal_care', 120000, 'chai', ARRAY['body','organic']),
('DMF-SCH-001', 'Cheese Sausage', 'Xúc xích phô mai', 'food', 85000, 'gói', ARRAY['snack','sausage','cheese']),
('DMF-SCG-001', 'Garlic Sausage', 'Xúc xích tỏi', 'food', 85000, 'gói', ARRAY['snack','sausage','garlic']),
('DMF-NGM-001', 'Fermented Ginger Water', 'Nước gừng lên men', 'beverage', 95000, 'chai', ARRAY['probiotic','ginger','fermented','healthy']),
('DMF-NNG-001', 'Fermented Turmeric Water', 'Nước nghệ lên men', 'beverage', 95000, 'chai', ARRAY['probiotic','turmeric','fermented','healthy']),
('DMF-KC-001', 'Banana Candy', 'Kẹo chuối', 'snack', 45000, 'gói', ARRAY['candy','banana','natural']),
('DMF-CS-001', 'Dried Banana', 'Chuối sấy dẻo', 'snack', 65000, 'gói', ARRAY['dried','banana','healthy']);

CREATE SEQUENCE IF NOT EXISTS order_seq START 1;

CREATE TABLE orders (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_number    TEXT UNIQUE,
    customer_id     UUID NOT NULL REFERENCES customers(id),
    session_id      UUID REFERENCES conversation_sessions(id),
    status          TEXT DEFAULT 'pending'
                    CHECK (status IN ('pending','confirmed','preparing','shipping','delivered','cancelled','refunded')),
    subtotal        NUMERIC(12,2) NOT NULL DEFAULT 0,
    discount_amount NUMERIC(12,2) DEFAULT 0,
    shipping_fee    NUMERIC(12,2) DEFAULT 0,
    total_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
    payment_method  TEXT CHECK (payment_method IN ('cod','bank_transfer','momo','zalo_pay')),
    payment_status  TEXT DEFAULT 'pending'
                    CHECK (payment_status IN ('pending','paid','refunded')),
    paid_at         TIMESTAMPTZ,
    delivery_address TEXT,
    delivery_date   DATE,
    delivery_time_slot TEXT,
    delivered_at    TIMESTAMPTZ,
    customer_note   TEXT,
    internal_note   TEXT,
    created_via     TEXT DEFAULT 'zalo_ai',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION set_order_number()
RETURNS TRIGGER AS $$
BEGIN
    NEW.order_number := 'ORD-' || TO_CHAR(NOW(), 'YYYY') || '-' ||
                        LPAD(nextval('order_seq')::TEXT, 6, '0');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_order_number
    BEFORE INSERT ON orders
    FOR EACH ROW
    WHEN (NEW.order_number IS NULL)
    EXECUTE FUNCTION set_order_number();

CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created ON orders(created_at DESC);

CREATE TABLE order_items (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id      UUID REFERENCES products(id),
    product_name    TEXT NOT NULL,
    quantity        NUMERIC(10,2) NOT NULL CHECK (quantity > 0),
    unit            TEXT DEFAULT 'cái',
    unit_price      NUMERIC(12,2) NOT NULL,
    subtotal        NUMERIC(12,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_order_items_order ON order_items(order_id);

-- ============================================================
-- DOMAIN 4: ANALYTICS & LTV
-- ============================================================

CREATE TABLE customer_ltv (
    id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id                 UUID UNIQUE NOT NULL REFERENCES customers(id),
    total_orders                INT DEFAULT 0,
    total_revenue               NUMERIC(14,2) DEFAULT 0,
    avg_order_value             NUMERIC(12,2) DEFAULT 0,
    first_order_at              TIMESTAMPTZ,
    last_order_at               TIMESTAMPTZ,
    avg_days_between_orders     FLOAT,
    predicted_next_order_date   DATE,
    top_categories              TEXT[],
    top_products                TEXT[],
    total_messages              INT DEFAULT 0,
    total_sessions              INT DEFAULT 0,
    rfm_recency                 INT CHECK (rfm_recency BETWEEN 1 AND 5),
    rfm_frequency               INT CHECK (rfm_frequency BETWEEN 1 AND 5),
    rfm_monetary                INT CHECK (rfm_monetary BETWEEN 1 AND 5),
    churn_risk                  TEXT DEFAULT 'low'
                                CHECK (churn_risk IN ('low','medium','high','churned')),
    updated_at                  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ltv_revenue ON customer_ltv(total_revenue DESC);
CREATE INDEX idx_ltv_churn ON customer_ltv(churn_risk);

-- Event stream (append-only, partitioned by month)
CREATE TABLE events (
    id              UUID DEFAULT uuid_generate_v4(),
    customer_id     UUID,
    session_id      UUID,
    event_type      TEXT NOT NULL,
    event_data      JSONB DEFAULT '{}',
    occurred_at     TIMESTAMPTZ DEFAULT NOW(),
    created_at      TIMESTAMPTZ DEFAULT NOW()
) PARTITION BY RANGE (occurred_at);

CREATE TABLE events_2025_06 PARTITION OF events
    FOR VALUES FROM ('2025-06-01') TO ('2025-07-01');
CREATE TABLE events_2025_07 PARTITION OF events
    FOR VALUES FROM ('2025-07-01') TO ('2025-08-01');
CREATE TABLE events_2025_08 PARTITION OF events
    FOR VALUES FROM ('2025-08-01') TO ('2025-09-01');
CREATE TABLE events_2025_09 PARTITION OF events
    FOR VALUES FROM ('2025-09-01') TO ('2025-10-01');
CREATE TABLE events_2025_10 PARTITION OF events
    FOR VALUES FROM ('2025-10-01') TO ('2025-11-01');
CREATE TABLE events_2025_11 PARTITION OF events
    FOR VALUES FROM ('2025-11-01') TO ('2025-12-01');
CREATE TABLE events_2025_12 PARTITION OF events
    FOR VALUES FROM ('2025-12-01') TO ('2026-01-01');
CREATE TABLE events_2026_01 PARTITION OF events
    FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE events_2026_02 PARTITION OF events
    FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE events_2026_03 PARTITION OF events
    FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE events_2026_04 PARTITION OF events
    FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE events_2026_05 PARTITION OF events
    FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE events_2026_06 PARTITION OF events
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE events_2026_07 PARTITION OF events
    FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

CREATE INDEX idx_events_customer ON events(customer_id, occurred_at DESC);
CREATE INDEX idx_events_type ON events(event_type, occurred_at DESC);

-- ============================================================
-- DOMAIN 5: FAQ (AI-generated from chat history)
-- ============================================================

CREATE TABLE faqs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    question        TEXT NOT NULL,
    answer          TEXT NOT NULL,
    category        TEXT,
    product_id      UUID REFERENCES products(id),
    source          TEXT DEFAULT 'ai_generated'
                    CHECK (source IN ('manual','ai_generated','chat_history')),
    frequency_count INT DEFAULT 1,
    is_published    BOOLEAN DEFAULT FALSE,
    generated_from_date_start DATE,
    generated_from_date_end   DATE,
    generated_by    TEXT DEFAULT 'claude-sonnet-4-6',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_faqs_category ON faqs(category);
CREATE INDEX idx_faqs_published ON faqs(is_published);
CREATE INDEX idx_faqs_frequency ON faqs(frequency_count DESC);

-- ============================================================
-- DOMAIN 6: KNOWLEDGE BASE
-- ============================================================

CREATE TABLE knowledge_base (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    category        TEXT NOT NULL,
    title           TEXT NOT NULL,
    content         TEXT NOT NULL,
    product_id      UUID REFERENCES products(id),
    version         INT DEFAULT 1,
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_kb_category ON knowledge_base(category);
CREATE INDEX idx_kb_active ON knowledge_base(is_active);

-- Seed FAQ knowledge base from existing FAQ doc
INSERT INTO knowledge_base (category, title, content, is_active) VALUES
('product', 'Nước nghệ lên men là gì?',
 'Thức uống làm từ nghệ, gừng, riềng organic, lên men thủ công với probiotic. Vị chua nhẹ, thơm dễ uống, hỗ trợ tiêu hóa.', true),
('product', 'Nước nghệ lên men có vị như thế nào?',
 'Vị chua nhẹ tự nhiên, thơm gừng-nghệ, hậu vị thanh. Có mật ong tự nhiên cân bằng vị. Dễ uống hơn nghệ tươi truyền thống.', true),
('product', 'Sản phẩm có đường không?',
 'Có khoảng 3% mật ong tự nhiên. Không dùng đường tinh luyện công nghiệp.', true),
('product', 'Có cần bảo quản lạnh không?',
 'Có. Sản phẩm lên men tự nhiên, không có chất bảo quản mạnh. Bảo quản lạnh để giữ chất lượng tốt nhất.', true),
('product', 'Vì sao có cặn dưới đáy chai?',
 'Cặn tự nhiên từ nghệ, gừng, gia vị hoặc quá trình lên men. Bình thường của sản phẩm thủ công.', true),
('faq', 'Uống lúc nào phù hợp?',
 'Buổi sáng sau ăn nhẹ, trước bữa ăn, sau khi ăn nhiều dầu mỡ, hoặc sau tập luyện nhẹ.', true),
('policy', 'Điểm khác biệt của Doc Mo Farm',
 'Sản xuất thủ công tại eco-farm. Nguyên liệu organic. Probiotic tự nhiên. Hương vị dễ uống. Lifestyle healthy và bền vững.', true);

-- ============================================================
-- TRIGGERS: updated_at auto-update
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_customers_updated BEFORE UPDATE ON customers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_orders_updated BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_products_updated BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_ai_memories_updated BEFORE UPDATE ON ai_memories
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_faqs_updated BEFORE UPDATE ON faqs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- STEP 2: MIGRATE OLD CONVERSATION DATA → new messages table
-- Copies _conversations_backup into messages, linking customers
-- ============================================================
DO $$
DECLARE
  migrated_count INT := 0;
BEGIN
  IF NOT EXISTS (SELECT FROM information_schema.tables WHERE table_name = '_conversations_backup') THEN
    RAISE NOTICE 'No old conversations to migrate.';
    RETURN;
  END IF;

  -- Insert old conversations into new messages table
  -- Map zalo_user_id → customer.id via the new customers table
  INSERT INTO messages (
    customer_id,
    zalo_user_id,
    role,
    content,
    created_at
  )
  SELECT
    c.id,
    cb.zalo_user_id,
    cb.role,
    cb.message,
    cb.created_at
  FROM _conversations_backup cb
  LEFT JOIN customers c ON c.zalo_user_id = cb.zalo_user_id
  WHERE cb.message IS NOT NULL AND cb.message != '';

  GET DIAGNOSTICS migrated_count = ROW_COUNT;
  RAISE NOTICE 'Migrated % old messages into messages table.', migrated_count;

  -- Migrate old customers into new customers table
  INSERT INTO customers (zalo_user_id, full_name, display_name, phone, full_address, created_at)
  SELECT
    zalo_user_id,
    name,
    name,
    phone,
    address,
    created_at
  FROM _customers_backup
  ON CONFLICT (zalo_user_id) DO NOTHING;

  RAISE NOTICE 'Customer migration complete.';
END $$;

-- ============================================================
-- STEP 3: VERIFY — show counts after migration
-- ============================================================
DO $$
DECLARE
  customer_count INT;
  message_count  INT;
BEGIN
  SELECT COUNT(*) INTO customer_count FROM customers;
  SELECT COUNT(*) INTO message_count  FROM messages;
  RAISE NOTICE '✅ Migration complete: % customers, % messages', customer_count, message_count;
END $$;
