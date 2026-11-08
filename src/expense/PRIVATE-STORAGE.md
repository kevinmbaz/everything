# Expenses: opt-in private storage

`VITE_PRIVATE_STORAGE=1` selects the shared Jetson client and produces `dist-private`; an ordinary build continues to use Puter and `dist`. Do not infer private mode from an SDK/network failure. No global Puter shim, browser dataset mirror, cloud import, or offline replay is installed.

## Setup and integration boundary

The shared contract is `../../private_storage/README.md`. This app imports its client, browser preparation helper and Vite plugin; it does **not** contain another server/transport. The private HTML/plugin removes the Puter SDK and analytics and replaces the legacy worker with a network-only worker. Startup awaits worker preparation before the actual authorized session and data reads. Only `expenses-` caches belong to this app.

Expenses is privately deployed on loopback **18724** behind owner-authorized HTTPS **18924**. The shared client/browser/build helpers, including receipt listing, passed independent review. Standard Puter and private builds remain separate.

## Data and failure behavior

- KV values remain native JSON in the app; the shared transport serializes them exactly once. Only a recognized `ENOENT` supplies an empty file default. Denied, malformed or unreadable documents fail visibly.
- Private commands run serially on detached in-memory drafts. Their final KV/text changes are deduplicated and sent in **one shared transaction**, then published to the visible store only after acknowledgement. This covers month/index creation and moves, settings/categories, report assignment/deletion/transitions, statement matching/unmatching/deletion, import and wipe. Linked month writes also compare the month index and report document; report transitions compare the loaded months.
- Shared sticky revisions and conflict latching govern cross-device writes. No refresh-to-force-save, automatic merge or retry is added. The Jetson banner and beforeunload guard include pending writes, errors, conflicts and unsent form edits. A later unrelated success cannot clear a failure. Copy important unsaved text before manually reloading; drafts are intentionally not persisted in the browser.
- Expense forms stage receipts under cryptographic unique filenames before committing metadata. Replacements never overwrite previous bytes. Old bytes are eligible for cleanup only after the matching metadata commit, and are retained when another loaded/checked expense references them. Cleanup failures remain visible. Rejected or uncertain commits may leave **unreferenced staged receipts**; no automatic orphan sweeper is provided.
- Private form success is bound to the submitted edit generation. An older acknowledgement cannot dismiss newer expense/report/category/onboarding edits or run their navigation callback. Newly created records become the target for the next save, so saving the retained draft updates rather than duplicates them. Receipt replacement/removal made during a save is retained; an already-acknowledged receipt is not uploaded again merely because notes changed.
- Currency acknowledgements clear only their own settings-row generation. Newer pending or failed selections remain in the same control across unrelated store notifications. Statement-import and report-assignment batch controls are temporarily disabled while saving (these batches are not edit-in-place forms), and restored on rejection. Private delete-all confirmation names Jetson; the default Puter wording is unchanged.
- Manual receipt upload/view remains available, up to 10 MiB. Cloud OCR is explicitly unavailable, including imported `autoOcr: true`; no AI fallback is called.

## Migration and limits

No automatic cloud migration. Export explicitly from the upstream app and import the JSON deliberately. JSON export contains receipt **references, not original bytes**. Transfer/reattach original receipts separately; importing metadata alone is not a complete receipt backup. Only safe receipt paths and supported extensions, valid month/date alignment, and unique safe expense IDs are accepted. Existing unsafe legacy IDs/paths require an explicit reviewed migration, not silent rewriting.

Import/wipe are bounded by the shared 512-operation / 8 MiB transaction limit and must fail rather than split into partially committed batches. Large histories and report transitions may reach those limits. Wipe enumerates individual receipt files; it does not request arbitrary directory deletion. Full backups must use the shared server's consistent database backup mechanism, not browser storage or a raw copy of an active SQLite database.

## Tests and remaining rollout gates

Run from `src/expense`:

```sh
flock -w 300 /home/nadir/.hermes/cache/scratch/everything-private-tests.lock \
  env LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 npm test -- --maxWorkers=1
```

The unchanged upstream baseline was 79 passing tests in nine files. Private tests exercise strict reads/session order, transactional rollback and serialization, cross-month/report/reconciliation changes, immutable receipt ordering and retention, rejected real forms, dirty navigation/unload, and explicit no-OCR mode. `private-concurrency.test.js` uses the **real shared client** against a deterministic CAS HTTP-response fixture; it is not a real-backend or browser deployment test.

`private-acknowledgements.test.js` mounts the actual UI and uses the actual serialized store with only remote I/O gated. It holds transaction acknowledgement, edits the controls, then releases it and checks committed data separately from the retained draft, beforeunload protection, receipt identity and second-save record identity. It also covers currency success/failure, category name/icon/color, onboarding (including sample-data completion), bulk report creation, pending batch controls and mode-specific delete wording. Drain pending transaction gates during test cleanup so a failing assertion cannot poison the next test's serialized store queue. The tight regression loop is `npm test -- tests/private-acknowledgements.test.js --maxWorkers=1`, under the same lock and locale above.

The acknowledgement review added 19 regression cases in `private-acknowledgements.test.js`; the complete Expenses suite passed **142 tests in 14 files** under the lock/locale command above. Only the existing Node experimental localStorage warning was emitted. The parent subsequently verified both builds, expanded Chromium acceptance and production deployment.

## Verified private deployment — 2026-11-08

- Open `https://jetson-energy.tail274ca7.ts.net:18924/` via the updated hub or desktop launcher. Authentication uses the Tailscale owner, not a Puter or mailbox login.
- Data: `/home/nadir/.local/share/everything-expense/expense.sqlite3`; owner identity file: `/home/nadir/.config/everything-expense/owner-login.txt`.
- User units: `everything-expense.service`, `everything-expense-backup.service`, `everything-expense-backup.timer`. Daily backup at 04:10 local time plus up to five minutes delay, retaining seven same-disk snapshots under `backups/`.
- Parent reran all 142 tests and both builds. Real isolated Chromium verified receipt bytes, restart/fresh-profile persistence, stale/denied saves, delayed-success draft preservation and follow-up save without duplicate creation, legacy-worker migration and isolated database restoration. App and shared-layer independent reviews passed.
- Actual Serve checks verified owner session, direct/CSRF denial, a unique temporary binary probe across an app-service restart and conditional cleanup, production browser/hub navigation, restrictive permissions, service/timer enablement and snapshot restoration. Other app routes/worktree changes and receive-only mail were preserved.
- Reports: `/home/nadir/.local/share/everything-local/private-rollout/expense-{browser,production}-results.json`. The adjacent `test-first-batch-production.mjs expense --exercise` explicitly writes/deletes a probe, restarts Expenses and runs backup; do not use it as a passive check.

Laptop/off-site access is not independently verified. Save/export old tabs and close them before reopening. No automatic Puter migration; JSON alone omits receipt bytes. Wait for confirmed Jetson saves, and keep off-device backups for disk-failure protection.
