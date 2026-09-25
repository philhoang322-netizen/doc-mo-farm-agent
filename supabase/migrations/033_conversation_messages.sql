-- Conversation history for the HITL inbox, plus FB-Sale / FB-DV thread labels.
-- Message bodies stay in this database. Webhooks and the backfill job must
-- not write those bodies to logs.

CREATE TABLE IF NOT EXISTS conversation_messages (
    source_msg_id       TEXT PRIMARY KEY,
    channel             TEXT NOT NULL CHECK (channel IN ('fb', 'zalo')),
    thread_id           TEXT NOT NULL,
    direction           TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    sender_label        TEXT,
    message_text        TEXT,
    attachments_summary TEXT,
    created_time        TIMESTAMPTZ NOT NULL,
    sender_meta         JSONB
);

CREATE INDEX IF NOT EXISTS idx_conversation_messages_thread
    ON conversation_messages (channel, thread_id, created_time);

CREATE TABLE IF NOT EXISTS thread_labels (
    channel     TEXT NOT NULL CHECK (channel IN ('fb', 'zalo')),
    thread_id   TEXT NOT NULL,
    label       TEXT NOT NULL CHECK (label IN ('sale', 'dv', 'unknown')),
    source      TEXT NOT NULL CHECK (source IN ('staff_lanh', 'signature', 'keyword', 'manual', 'model')),
    confidence  REAL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (channel, thread_id)
);

CREATE TABLE IF NOT EXISTS fb_backfill_state (
    id           INTEGER PRIMARY KEY,
    months       INTEGER,
    cursor       TEXT,
    threads      INTEGER NOT NULL DEFAULT 0,
    messages     INTEGER NOT NULL DEFAULT 0,
    errors       INTEGER NOT NULL DEFAULT 0,
    pages        INTEGER NOT NULL DEFAULT 0,
    rate_limits  INTEGER NOT NULL DEFAULT 0,
    skipped_old  INTEGER NOT NULL DEFAULT 0,
    seen         INTEGER NOT NULL DEFAULT 0,
    already      INTEGER NOT NULL DEFAULT 0,
    done         BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
