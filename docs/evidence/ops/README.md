# The ops log

`runs/` holds one JSON run record per run of a script that touched a remote (Phase 7 7C):
`<UTC yyyymmddThhmmssZ>-<script>-<4 hex>.json`, written by `scripts/run-record.mjs` on every exit
path. The fields and the writer's contract are in `docs/REFERENCE.md` "Operations"; `npm run
check:findings` validates every file, and `npm run ops:requests` totals the live calls here and in
`docs/evidence/requests.tsv`. Commit new records with the change they belong to.
