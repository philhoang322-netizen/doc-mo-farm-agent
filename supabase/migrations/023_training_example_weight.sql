-- Learning toggle on Approve & Send.
-- example_kind: correction (manager edited, weight 1) or approved (sent as-is, weight 0.35).
-- actor is the manager name. Unchecked learning writes no row.

ALTER TABLE training_logs ADD COLUMN IF NOT EXISTS example_kind TEXT;
ALTER TABLE training_logs ADD COLUMN IF NOT EXISTS example_weight REAL;
ALTER TABLE training_logs ADD COLUMN IF NOT EXISTS actor TEXT;
