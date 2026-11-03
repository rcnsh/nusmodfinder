-- Non-Graduating (exchange student) availability, from the NUS Registrar PDF.
-- Not present in the NUSMods API, so it arrives via data/ng-courses-<year>.json.
ALTER TABLE modules ADD COLUMN ng INTEGER NOT NULL DEFAULT 0;
ALTER TABLE modules ADD COLUMN ng_semesters TEXT;   -- JSON array, e.g. "[1,2]"
CREATE INDEX IF NOT EXISTS idx_modules_ng ON modules(ng);
