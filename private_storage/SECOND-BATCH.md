# Second private-storage batch: fixed integration contract

Scope: `solitaire`, `sudoku`, `contacts`. These have source but were not installed/privately deployed in the initial fleet. Existing Projects, Invoicing, Tasks, Expenses, Time Tracking and receive-only mail must remain untouched operationally. No deployment by implementation agents.

Read `README.md` for the existing authenticated shared API, CAS, transaction, worker preparation, failure and build rules. Reuse the existing helpers without changing their API or globally impersonating Puter. Default Puter builds must remain functional.

## Fixed resource policy

Each app gets a separate backend/database, explicit private build and its own HTTPS origin selected by the parent later. The existing backend/transport needs no new list API:

- Solitaire: one native-JSON KV document `solitaire:state:v1`.
- Sudoku: one native-JSON KV document `sudoku:state:v1`.
- Contacts: one native-JSON KV document `contacts:book:v1`.
- No files or file listings are permitted for these new app policies. Contact avatars remain in the native contact records; preserve existing size/validation limits.

Document formats are app-owned, versioned and validated before hydration. Missing server state is `null`, never an error fallback. Hydrate from the authenticated server BEFORE gameplay/contact editing/autosave becomes possible. No automatic localStorage/Puter import or browser-primary fallback. Any explicit import must validate, preserve identifiers literally and explain replacement semantics.

Use one captured document mutation (or one-operation transaction) for coupled changes. The shared client retains the original read revision and serializes writes. No timestamp-winner merge, background force-save, refresh-and-retry, or invisible error recovery. Dirty means local draft, queued write, uncertain response or conflict; only acknowledged matching generations become saved. Failures preserve visible work, warn before unload and require explicit recovery/reload. Keep actual local game engines/workers; do not invent a puzzle or multiplayer service.

### Solitaire

Persist board, mode preference, all mode statistics, Vegas bank and settled-game ledger coherently. Preserve Klondike/Spider families and draw/suit variants. Settlement/win/abandon/undo must not double-count across retry or reopen. Keep per-device accounting semantics explicit; do not silently merge legacy banks. Private state is new until explicitly imported. Browser-local device/UI cosmetics may remain only if not authoritative progress. Await first load before play and prohibit late hydration from replacing a board already being played. Preserve original default cloud sync separately.

### Sudoku

Persist validated puzzle snapshot, settings, statistics and daily/streak data in the single document. Preserve local module-worker generation and inline fallback. No private cloud-sync/timestamp merge or local save replay. Preserve actual serializer capabilities and explicitly document any undo/redo history not represented by the original snapshot. Changes to a completed puzzle and statistics must be consistent and counted once.

### Contacts

Use an app-local private adapter wrapping the one `contacts:book:v1` document; never add a fake global Puter object. Existing per-contact `get/set/del/list` interfaces can be implemented over a validated in-memory book hydrated once from the shared client. Serialize captured per-contact updates into full-book conditional saves, publish committed state only on success, and never refresh the book's CAS baseline merely to accept stale editors. A coarse book-wide conflict is preferable to lost contact edits. Preserve full listing, local vCard import/export, avatars and explicit partial-result semantics for independent bulk operations. Disable private Smart Add/AI, Drive import, unimplemented Calendar/MCP/headless cross-app bridges and cloud sharing; do not call them or report success. Mailto is an external client handoff, not sending. No mail infrastructure changes.

## Ownership and gates

- Backend agent: only additive `policies.py` entries and dedicated new Python policy/HTTP tests. Do not edit existing first-batch semantics or restart services. CLI choices already derive from policies; inspect before assuming.
- Each app agent: only its own `src/APP/**` source/tests/docs. No shared files, builds/deployments, services, production data, credentials or commits.
- Parent owns serial dependency installation, baseline tests, default/private builds, real-browser/HTTP restart/fresh-profile/failure/conflict/migration/backup checks, independent reviews and eventual scoped deployment.
- Use strict incremental RED/GREEN tests, preserving existing tests/manifests/lockfiles. Shared low-memory lock: `/home/nadir/.hermes/cache/scratch/everything-private-tests.lock`; English locale; `--maxWorkers=1` (add `--minWorkers=1` only for Contacts' installed Vitest 2; Vitest 4 in the games rejects that flag). Contacts' build deliberately runs its test suite before Vite; do not remove that step.
- SDK/telemetry removal must not remove local assets. Await safe shared worker preparation before session/data access. Cache prefixes must come from inspected app source; never clear unrelated caches or force an old editor reload.
- Record exact unit totals and source limitations. Parent accepts only real executed evidence, not mock-based deployment claims.
