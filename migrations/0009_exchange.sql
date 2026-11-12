-- Exchange-mode eligibility (ADR 0007), computed at ingest by src/eligibility.js from the NG list and the
-- restrictions data (data/ng-restrictions-<year>.json). The Worker runs no
-- rule logic; it reads these.
-- ng_allow: 15 bits, bit (NG_SEMS index * 5 + STUDIES index) set = shown in
--   exchange mode (open or note) for that (semester, study level). 0 (the
--   default, so a row ingest never touched) means closed everywhere.
-- ng_rules: JSON {"<bit index>": [rule id, ...]} for the bits with reasons
--   (the closing rules where the bit is clear, the notes where it is set);
--   NULL for a module off the NG list, whose one reason is that.
ALTER TABLE modules ADD COLUMN ng_allow INTEGER NOT NULL DEFAULT 0;
ALTER TABLE modules ADD COLUMN ng_rules TEXT;
