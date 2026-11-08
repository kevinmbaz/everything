# Time Tracking: explicit private Jetson storage

## Scope and build

Private mode is selected **only** by `VITE_PRIVATE_STORAGE=1`. It uses the shared
`private_storage/client.mjs`, `browser.mjs`, and `vite.mjs` contract documented in
`../../private_storage/README.md`. It never installs `window.puter`, authenticates
from a cached user, imports an old browser mirror, or falls back after a network
failure. The ordinary Puter build and its offline behavior remain separate.

From this app directory:

```sh
npm run build                         # ordinary Puter dist
VITE_PRIVATE_STORAGE=1 npm run build  # dist-private
```

The shared private Vite plugin removes the external SDK/telemetry and emits a
network-only `sw.js`. Before authentication or data reads, private startup awaits
legacy-worker retirement and removal of **only** `hourly-` caches. It never
reloads an editor automatically. Even the ordinary worker excludes `/api/`.

Time Tracking is privately deployed at `127.0.0.1:18721`, behind owner-authorized HTTPS port `18921`. Standard and private builds remain separate. No outgoing email was activated.

## Authentication and data

The real authorized `/api/session` is mandatory before the seven KV reads. There
is no private sign-in/sign-out imitation; identity comes from the owner-only
Tailscale/loopback backend. Failed startup is an error, not an empty workspace.

- Native KV: `hourly:{settings,clients,projects,months,timer,backups,invoices}:v1`.
- Monthly JSON: `hourly-data/entries-YYYY-MM.json`.
- JSON snapshots: `hourly-data/backups/backup-YYYY-MM-DD.json`.
- Immutable logo bytes: `hourly-data/logo-<timestamp>-<UUID>.png|jpg|webp`.
  Historical timestamp-only logo names are still readable. Issued invoices keep
  their original logo paths; replacing a logo never deletes its old bytes.

The adapter owns session memoization, conditional revisions, serial transport,
conflict latching, and uncertain-response validation. Month reads accept only an
explicit missing-file error as empty; server/permission/parse errors propagate.
Private writes never reread and reconcile a loaded document. Explicit reload
(after copying unsaved work) is required to pick up another device's changes.

The old mirror/outbox/merge/replay paths are unreachable in private mode:
`refresh()` and `flushPending()` are no-ops, startup omits online/focus/poll replay,
and the offline module does not even read its old metadata. Theme and reminder
preferences may remain device-local; those are not primary storage.

## Atomic commands and failures

The store serializes complete user commands, captures arguments at invocation,
and stages their JSON changes in memory. Internal nested mutations join the
outer command. A single shared transaction commits the resulting unique resource
operations; there is no compensating-write sequence in private mode.

This covers entry/month-index creation, cross-month moves, bulk entry changes,
client/project archival, invoice creation/voiding with all rate locks, payments,
CSV imports, and full JSON restore (including removed months and timer cleanup).
Transactions exceeding the shared 512-operation/8-MiB limit fail visibly rather
than partially importing.

Timer start persists a UUID. Stop uses entry ID `timer-<timer UUID>` and
idempotency key `timer-stop-<timer UUID>` (legacy timers use their start timestamp).
Entry insertion, month index and timer clear are one transaction. The timer
remains visible until acknowledgment. An uncertain/failed stop retains the exact
in-memory operation batch; another explicit Stop retries that **same** batch and
key, never recalculates duration or creates another entry. A conflicting second
device cannot force a write. There is no persistent retry queue and no automatic
retry after reconnect. Reloading reads the actual saved timer; it does not itself
stop or create an entry.

After a failed mutation the candidate data remains in memory and the persistent
Jetson banner says **Not saved**. Subsequent ordinary mutations are blocked for
that store session to avoid duplicate commands after an uncertain response.
Copy draft text or download recovery JSON before manually reloading. The special
explicit timer-stop retry is the sole exception. Failed discard retains the
original timer. A successful unrelated operation cannot hide failed transport
work.

The banner includes pending editor drafts and beforeunload protection. Entry,
client/project, timer-edit, settings and onboarding controls retain edits made
while a save is awaiting its response. A newly saved entry/client/project is
updated by its acknowledged ID on the next submit, not added again. If invoice
fields change while issuance is in flight, the newer draft remains visible and
resubmission is blocked: copy those fields and open the issued invoice from
Reports (void/recreate if appropriate), rather than silently changing a frozen
invoice or creating a duplicate. Timer-start drafts typed in flight are kept for
the next timer.

Manual invoice line editors track their own unsaved input; adding, editing or
removing a line advances the parent invoice draft generation. A delayed issuance
acknowledgement cannot dismiss a newer collection or an open, dirty line editor.
The issued invoice stays immutable and follow-up submission cannot issue twice.

Settings tracking compares control values so the blur/change event following an
acknowledged input autosave is not a fresh edit. Acknowledgements still match
field generations, not just values. Navigating away releases clean tracking but
retains dirty settings controls **only in memory** for return to Settings; pending
debounces finish normally. Invalid/rejected input remains reachable and warned,
and an older response cannot clear newer edits. Once a detached view is fully
acknowledged it is released. Rejected writes retain the existing copy/reload
policy, not a new automatic retry path.

## Logos and snapshots

Logo uploads go directly to the conditional binary API under a unique immutable
name, then settings commit their reference. Failure may leave an unreferenced
blob but cannot destroy a previously issued invoice's logo. JSON snapshot bytes,
snapshot index and retention deletes are one conditional transaction; document
reads, never stat/list observations, establish the revision baseline. Snapshot
creation is manual or once at startup when the selected cadence is due; failures
are visible, with no background replay.

JSON exports and these in-app snapshots include logo **paths, not logo bytes**.
Explicit cloud migration therefore needs the original logo files separately.
Use the shared backend's consistent full SQLite backups for complete server-side
protection; same-disk snapshots do not protect against losing the Jetson disk.
There is no automatic migration of Puter or browser datasets.

## Verification and remaining rollout gates

All app tests are run serially with the shared low-memory lock:

```sh
flock -w 300 /home/nadir/.hermes/cache/scratch/everything-private-tests.lock \
  env LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 npm test -- --maxWorkers=1
```

New suites: `tests/private-store.test.js`, `tests/private-mode.test.js`,
`tests/private-ui.test.js`, and `tests/private-review.test.js`. Development used
failing regressions before each behavior change, then targeted green runs and
the existing full suite. Store
fault-injection tests use an injected test adapter; they prove command composition
and visible failure behavior, **not** the backend's atomicity or authorization.
UI tests use jsdom. Source-level build/startup checks are not production builds or
real service-worker migration tests.

Verified app results after the bounded review fixes: ordinary test configuration
**14 files / 247 tests passed**; explicit `VITE_PRIVATE_STORAGE=1` with the four
private suites **4 files / 42 tests passed**. The review suite adds 13 jsdom
regressions: manual-line status/unload, open child drafts, clean issuance,
delayed-ack line add/edit/remove with test-adapter readback and duplicate
submission prevention, autosave/blur, clean teardown, invalid/rejected settings
retention, detached debounce completion, and newer same/other-field edits.
Both reported blockers were reproduced RED before their fixes; focused GREEN
runs preceded full-suite verification. `git diff --check -- src/time-tracking`
passed. Ordinary Node runs emit the existing experimental localStorage warning;
explicit private runs do
not read that browser mirror. An early missing shared Vite helper required
`--configLoader native` for interim runs; the final commands above work without
that workaround. The parent subsequently verified both builds and real browser acceptance.

## Verified private deployment — 2026-11-08

- Open `https://jetson-energy.tail274ca7.ts.net:18921/` through the updated hubs or desktop launcher, using the Tailscale owner identity.
- Data: `/home/nadir/.local/share/everything-time-tracking/time-tracking.sqlite3`; identity file: `/home/nadir/.config/everything-time-tracking/owner-login.txt`.
- User units: `everything-time-tracking.service`, `everything-time-tracking-backup.service`, `everything-time-tracking-backup.timer`. Daily backup at 04:20 local time plus up to five minutes delay, retaining seven same-disk snapshots under `backups/`.
- Parent reran 247 tests and both builds. Real isolated Chromium checks passed for UI progress, timer restart/single stop entry, stale/denied writes, manual invoice child/parent draft protection, settings autosave/blur/navigation and snapshot restoration. Actual logo upload bytes (after the app's intended image preparation) matched stored/restored bytes and rendered in a fresh browser. Legacy-worker migration and absence of external requests were verified. App and shared-layer independent reviews passed.
- Actual production Serve checks passed for owner authorization, direct/CSRF denial, unique unlinked probe persistence across an app-service restart and conditional cleanup, secure browser/hub navigation, service/timer/permissions and isolated snapshot restoration. Existing apps, routes and receive-only mail were preserved.
- Reports: `/home/nadir/.local/share/everything-local/private-rollout/time-tracking-{browser,production}-results.json`. The adjacent `test-first-batch-production.mjs time-tracking --exercise` deliberately creates/deletes a probe, restarts the app and runs backup; it is not a passive check.

Laptop/off-site access remains unverified. Save/export and close legacy tabs before reopening; no automatic cloud import or offline replay is provided. JSON exports omit logo bytes. Newer edits made while an invoice is being issued remain copy-only drafts, not changes to the frozen invoice; copy them before closing and use Reports to inspect/void/recreate as appropriate. Keep off-device backups for disk-failure protection.
