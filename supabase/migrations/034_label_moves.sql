-- Manual Sale/DV moves. The folded customer text stays in this database.
-- Do not copy these rows into the repo, logs, or API responses.

CREATE TABLE IF NOT EXISTS label_moves (
    id           TEXT PRIMARY KEY,
    channel      TEXT NOT NULL CHECK (channel IN ('fb', 'zalo')),
    thread_id    TEXT NOT NULL,
    from_label   TEXT,
    to_label     TEXT NOT NULL CHECK (to_label IN ('sale', 'dv')),
    actor        TEXT,
    moved_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    inbound_text TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_label_moves_moved
    ON label_moves (moved_at DESC);
