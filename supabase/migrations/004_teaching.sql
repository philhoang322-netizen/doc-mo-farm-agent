-- ============================================================
-- 004 — Teaching the bot without a deploy
--
-- Until now, correcting the agent meant editing a .md file or the system
-- prompt and pushing code. The farm can't do that. These two stores are
-- editable from /admin and read on every conversation.
-- ============================================================

-- Curated question → answer pairs. Highest authority: if one matches,
-- the agent is told to answer with it rather than improvise.
CREATE TABLE IF NOT EXISTS bot_lessons (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    question    TEXT NOT NULL,
    answer      TEXT NOT NULL,
    note        TEXT,
    is_active   BOOLEAN DEFAULT TRUE,
    hit_count   INT DEFAULT 0,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lessons_active ON bot_lessons(is_active) WHERE is_active = TRUE;

-- Free-text house rules ("đừng nói X", "luôn nhắc giao 2 ngày") live in
-- app_state under the key 'bot_rules', so no extra table is needed.
