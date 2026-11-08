# Tasks — explicit private storage

## Scope and activation

`VITE_PRIVATE_STORAGE=1` selects the real shared Tasks storage client and produces `dist-private`. The ordinary build still produces `dist`, loads Puter, and retains its upstream offline/collaboration behavior. Private mode is never selected by a failed SDK load or failed login.

The shared backend, identity boundary and transport contract are documented in `../../private_storage/README.md`. Tasks is privately deployed on loopback **18718**, behind owner-authorized HTTPS **18918**. See the verified deployment details below.

Private startup:

1. Run the shared browser preparation helper before session/data access.
2. Verify the real `/api/session` for `app: tasks`, `storage: jetson`. No cached user, fake SDK, browser-primary dataset, or Puter fallback.
3. Read the three native KV documents through the injected client. Authentication/read failures stop startup rather than loading an old mirror.

The private Vite plugin removes the external SDK/preconnect/analytics scripts and replaces the normal shell-worker generator with the shared network-only worker. It removes only caches beginning `tasks-`, including the old `tasks-sdk` cache. Both standard and private builds were verified during deployment.

### Legacy service-worker migration limitation

The old Tasks worker serves a cached-first shell, and old page code can reload on `controllerchange`. Safe retirement must not force activation or reload an open editor. **Save/export work and close every old Tasks tab/window before reopening the private deployment.** A previously cached shell may otherwise continue opening the old application until those tabs close and the replacement can activate naturally. The shared helper deliberately refuses to force takeover; its timeout or preparation failure blocks private authentication rather than weakening this boundary. The isolated Chromium rollout harness verified the actual cached legacy navigation and safe upgrade after old tabs close.

## Personal features and disabled capabilities

Retained: personal lists/tasks, notes, priorities, tags, subtasks, recurrence, calendar, logbook, browser reminders and local JSON/ICS downloads. Reminders run while Tasks is open; they are not server-side push notifications. Theme/reminder-deduplication preferences may remain device-local, but task data does not.

Unavailable in private mode:

- Public read-only lists, share URLs and calendar subscription feeds.
- Collaboration, invites, approvals, linked-replica fallback, KV share discovery and polling.
- Puter sign-in/sign-out and SDK calls.
- Offline shim, task mirror, outbox loading, online/focus replay and pre-write cloud merging.

Share sheets and link routes explain the restriction without fetching the supplied URL. Calendar feed controls are disabled; local ICS download remains available. Startup and ordinary edits do not publish data. Sharing/collaboration/feed state is stripped on load, save and import, **even when the exported account matches the current owner**. Existing Puter publications are not remotely revoked by this app; private mode makes no calls to those services.

## Storage and atomicity

Allowed KV resources:

- `tasks:settings:v1`
- `tasks:lists:v1`
- `tasks:items:v1`

Monthly archives: `tasks-data/log-YYYY-MM.json` only. No share files, replicas or public ICS files are written.

The app passes native KV envelopes and UTF-8 archive text to the shared `transaction` API. The shared client supplies quoted revision baselines, `X-Everything-Request: 1`, JSON serialization and transaction IDs. Application `rev`/epoch metadata is not an alternative to server CAS.

Every private save uses a transaction. List deletion and default-list changes, first-list-plus-first-task creation, import and wipe update coupled KV documents together. Archival commits monthly files and the hot task/month index together. Import/wipe delete known old archive files in the same transaction as all three KV documents. No pre-write KV refresh or merge is performed.

Only explicit `ENOENT` permits an empty new archive. Network/permission/corrupt JSON failures stop archival and remain visible. Housekeeping skips unsaved editors and abandons preparation if another mutation or draft intervenes. Failed archival keeps hot task copies and the previous in-memory month index. The shared transaction limit remains 512 operations / 8 MiB: oversized imports, wipes or archive sweeps fail as a whole, not as partially committed chunks.

## Failure and editing behavior

- Changes are dirty immediately; form drafts are also tracked before a transport call. Quick-add text participates in the status/unload warning.
- Snapshot values are captured before awaiting persistence. Older acknowledgements cannot clear a newer generation.
- Task/list forms stay open if the write fails or if the user types more while it is pending. A newly created task/list edited during its acknowledgement is subsequently updated, not inserted again.
- Private writes reject on failure. They never resolve as “saved here” or queued success.
- The store serializes submissions and conservatively latches **all failed/uncertain writes** for that store instance, not just conflicts. Later snapshots cannot run behind a failed archive or partial-intent transaction. There is no background retry or in-app force-save.
- A persistent banner distinguishes unsaved work, failed acknowledgement and conflicts; `beforeunload` warns while unsaved state remains. Readiness does not trigger an automatic reload.
- After failure: keep the tab open, copy unsubmitted form text and export useful in-memory task data before explicitly reopening. A failed/timeout response may mean the server committed but the response was lost; inspect the reopened state before repeating an action. There is no durable browser outbox to recover unsaved work after closing the tab.

## Export/import limitation — archive bytes are NOT in JSON

The existing local JSON export contains active/recent tasks and **archive month references, not archived logbook bytes**. Private exports include `archiveNotice`, and Settings explains the omission. A complete history backup requires the shared backend's consistent database backup, handled by deployment operations—not this JSON download.

Private import rejects JSON with nonempty `items.logMonths` rather than pretending those referenced files were restored. For an intentional active/recent-only migration, retain the original export/archives separately and explicitly remove the `logMonths` references before importing. Import replaces the current dataset and deletes its known archive files atomically; the confirmation warns about this. No automatic cloud/browser migration occurs.

## Verification performed

Serialized command (from this app directory):

```sh
flock -w 300 /home/nadir/.hermes/cache/scratch/everything-private-tests.lock \
  env LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 npm test -- --maxWorkers=1
```

- Unmodified baseline: **12 files, 235 tests passed**.
- Verified source suite: **18 files, 297 tests passed**, including the quick-add draft-transfer regressions.
- Red/green regressions exercised private injection, atomic saves/archive deletion, same-owner publication stripping, disabled APIs/routes, draft and delayed-write preservation, failure latching, duplicate prevention, archive-read races and corruption, and no replay.
- Actual shared client + Store tests use an explicitly in-process HTTP-response fixture: native envelopes, archive transaction wire shape, session denial and stale-client conflict. These are not claims of real-server persistence.
- Vite configuration/plugin tests transform the actual Tasks HTML and inspect an in-memory emitted worker without building the application. UI tests use lightweight DOM/modal primitives, not a real browser.
- `git diff --check -- src/tasks` passed. The original 12 test files were not modified. No shared module/backend or other app was changed by this task.

## Verified private deployment — 2026-11-08

- Open `https://jetson-energy.tail274ca7.ts.net:18918/` with the owner's Tailscale identity. Both launcher hubs and the desktop entry now use this private origin.
- Data: `/home/nadir/.local/share/everything-tasks/tasks.sqlite3`; owner identity configuration: `/home/nadir/.config/everything-tasks/owner-login.txt`. The identifier is not a mailbox password.
- User service: `everything-tasks.service`; backup units: `everything-tasks-backup.service` and `everything-tasks-backup.timer`. Daily backups run at 04:30 local time plus up to five minutes of randomized delay, retaining seven snapshots in the data directory's `backups/`. These are same-disk backups, not disk-failure protection.
- Parent reran all 297 app tests, both builds and isolated Chromium checks for real UI persistence, fresh profiles/backend restart, stale-client rejection, failed saves, archive-capable database restoration and safe worker migration. The quick-add regression verifies a real reload warning, preservation when reload is cancelled, and cleanup on explicit discard.
- Independent Tasks re-review and shared JS/backend reviews passed. Shared tests include real worker termination while a prepared tab stays open.
- Actual Tailscale production checks verified authorized session, unauthenticated/CSRF rejection, a unique unlinked file surviving an app-service restart, conditional cleanup, private browser startup, actual hub navigation, enabled service/timer, restrictive permissions and snapshot restoration in isolation. Other routes, original dirty files and receive-only mail were preserved.
- Reports: `/home/nadir/.local/share/everything-local/private-rollout/tasks-{browser,production}-results.json`.
- Production verifier: `node /home/nadir/.local/share/everything-local/private-rollout/test-first-batch-production.mjs tasks`. Adding `--exercise` deliberately creates/deletes a disposable unlinked probe, restarts only Tasks and runs its backup; it is not a passive status check.

Laptop/off-site connectivity has not been independently checked. Keep the Jetson online, save/export old tabs before migration, and wait for confirmed Jetson saves. No automatic cloud import, offline write recovery, public sharing or outgoing-mail integration was enabled.
