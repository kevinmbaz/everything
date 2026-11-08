# Private Jetson storage rollout

This is an opt-in, single-owner backend/transport for the Everything apps. The existing Projects and Invoicing implementations remain separate and unchanged. Default Puter builds must continue to work. No global Puter impersonation, browser-primary fallback, automatic cloud import, public endpoint, or outgoing-mail activation is part of this rollout.

## First implementation batch

Expenses (`expense`), Time Tracking (`time-tracking`), and Tasks (`tasks`). Each keeps its distinct existing HTTPS origin, a loopback-only backend process and its own database/data directory. Do not deploy until app-specific tests, real isolated-browser persistence/restart/failure checks and independent review pass.

This document specifies the interface for parallel implementation; it does not claim that the implementation or deployment is complete.

## Backend contract

`python3 private_storage/server.py --app APP --host 127.0.0.1 --port PORT --origin HTTPS_ORIGIN --dist ABSOLUTE_DIST_PRIVATE --data-dir ABSOLUTE_DATA_DIRECTORY --allowed-login-file OWNER_FILE`

Backup: `python3 private_storage/server.py --app APP --data-dir DIRECTORY --backup --retain 7`.

- Python standard library, one `APP.sqlite3` database outside the repository/dist. Restrictive directory/database permissions, WAL with FULL synchronous writes, consistent SQLite backup API snapshots (seven retained), tested isolated restoration. Never copy an active WAL database file directly.
- Explicit code-owned per-app resource policies in `policies.py`, not user-supplied regular expressions. No arbitrary host filesystem API. Unknown app/resource/route rejected.
- Exact configured Host, exact sole `Tailscale-User-Login`, loopback bind only. Tailscale Serve is the identity boundary; local processes are trusted. All data and static content require identity. No CORS or Funnel.
- Mutations require exact Origin and `X-Everything-Request: 1`. Single-resource mutations require quoted integer If-Match (`"0"` for never-existing). Missing precondition 428, malformed 400, stale 409 `CONFLICT`. Atomic SQLite compare/write; deletion tombstones retain increasing revisions. Reject ambiguous/duplicate header/query/JSON fields and unsupported transfer encoding/oversized bodies.
- `GET /api/session` -> `{username:"Jetson storage",uuid:"jetson-owner",storage:"jetson",app:APP}` only after actual authorization. The display identity is not an authentication bypass.
- `GET /api/kv?key=KEY` -> `{value:string|null}` and ETag. The string contains serialized JSON of the app's native KV value. An absent/tombstoned key returns null; stored native null is the string `"null"` on the wire.
- `PUT /api/kv?key=KEY` body `{value:string}`; `DELETE /api/kv?key=KEY`; both return `{ok:true}` and committed ETag.
- `GET /api/file?path=PATH` -> raw bytes and ETag. Optional `stat=1` -> `{path,size,modified:revision}`. Missing file 404 `ENOENT` includes its tombstone/zero ETag.
- `PUT /api/file?path=PATH` raw bytes; `DELETE` same endpoint; response `{ok:true}` and ETag.
- `GET /api/files?prefix=PREFIX` -> `{files:[{path,etag,size,modified}]}` for policy-approved descendant listings; no deleted resources.
- `POST /api/transaction` -> atomic bounded JSON/text operations. Body `{idempotencyKey:string,operations:[{kind:"kv",key,method:"PUT"|"DELETE",ifMatch,value?}|{kind:"file",path,method:"PUT"|"DELETE",ifMatch,value?}]}`. `value` is serialized JSON text for KV or UTF-8 text for files; absent for DELETE. Every operation has its own quoted `ifMatch`. No global If-Match. Validate all resources/preconditions before committing anything. Reject duplicate resources, unknown fields, empty/oversized batches. Maximum 512 operations and 8 MiB request; ordinary binary upload maximum 32 MiB, Expenses receipt maximum 10 MiB.
- Transaction result `{ok:true,revisions:[{kind:"kv",key,etag}|{kind:"file",path,etag}]}` in operation order. Persist idempotency key, canonical request fingerprint and result in the same database transaction. An identical replay returns the original result without another mutation; reuse with different payload returns 409 `IDEMPOTENCY_MISMATCH`. IDs limited to safe ASCII 1–128 characters. Never auto-evict idempotency records in this first batch.
- Static responses: descriptor-relative no-follow traversal, regular files only, correct MIME types, no listing/hidden files/traversal, no-store and same-origin security headers. Do not serve source or data directories. Private workers are network-only.

## Shared client contract

`private_storage/client.mjs` exports `createPrivateStorage({app, fetch=globalThis.fetch})`.

- Return `{mode:'private',getUser,auth:{getUser,isSignedIn},kv:{get,set,del},fs:{read,stat,write,delete,readdir},transaction,events,dirty,error,conflict}`. No signIn/signOut, AI, sharing, worker or other pretending-to-succeed APIs. `isSignedIn` is async and verifies the real session. Apps can call getUser directly at boot.
- All reads authenticate via one memoized, non-resetting session promise and validate matching app + storage. KV get returns native parsed JSON or null; set accepts native JSON value and serializes exactly once.
- File read returns Blob; write accepts string/Blob and returns `{path,size,modified}`. Missing file throws code ENOENT. stat and readdir are observation only, never advance the baseline of data already read. readdir synthesizes immediate virtual directories from descendant file listings.
- Keep sticky quoted revision baselines tied to the first actual document read; only acknowledged writes advance them. Never fetch a fresh revision to overwrite an existing unread KV/file. A preliminary get for a new resource may establish a missing/tombstone baseline, but reject an unread existing resource. Reads after an earlier read do not advance that baseline.
- Serialize all transport mutations through one queue, including transactions (avoids mixed single-resource/transaction races). Capture JSON/string mutation values at call time. Binary Blob inputs are immutable. Queue reads consistently without nesting queued calls/deadlocks. Reject duplicate resources in client transactions too.
- `transaction(operations,{idempotencyKey}={})` accepts native-value KV PUT operations and string-value file PUT operations; caller specifies kind/key-or-path/method/value, not ifMatch. Client adds sticky baseline revisions and serializes KV values once. Default key uses cryptographic UUID. If caller passes a key for explicit retry, retain and replay the identical captured request; reject its reuse for a different proposed operation set. Return the server result and atomically advance all acknowledged baselines only after the complete response validates.
- A stale 409/412 latches the adapter for its lifetime; no force, automatic reload, pre-write merge, or stale retry. A protocol/malformed response cannot silently acknowledge work. Failed mutation remains dirty/error; later unrelated successful writes cannot clear it. Expected missing-file reads are not generic failures. Timeout/aborted writes have uncertain outcome, never Saved status.
- `events` emits `state`; `dirty` includes queued/failed mutations; `error` includes persistent read/write failures; `conflict` is the latched error. UI must also track edits that have not reached transport yet. Preserve draft/form text and beforeunload warning on failure.
- No localStorage/IndexedDB data/outbox fallback or replay. Cosmetic/device preferences may remain local; do not call those primary Jetson data.

`private_storage/browser.mjs` exports `preparePrivateBrowser({cachePrefixes,serviceWorkerUrl='/sw.js'})` to retire a legacy worker before private auth/data reads, clear only app-owned caches, await the network-only replacement controller, and never reload a dirty editor. Do not unconditionally skipWaiting/claim over legacy clients: Tasks' existing controllerchange handler reloads them. Use a safe all-client readiness handshake or fail closed with a save/export-and-close-other-tabs instruction; natural activation after legacy tabs close is acceptable. Test the old cached navigation path, not just a fresh profile.

`private_storage/vite.mjs` exports `privateStoragePlugin({cachePrefixes})`. App Vite config enables it only when `VITE_PRIVATE_STORAGE=1`, sets outDir `dist-private`, and retains its normal build otherwise. The plugin strips external Puter SDK/preconnect and analytics scripts only in the private HTML and emits a network-only `sw.js` that cleans the supplied cache prefixes. Apps must omit their normal worker generator in private mode.

## First-batch resource policies

Expenses:
- KV `exp:settings:v1`, `exp:categories:v1`, `exp:months:v1`.
- Files `expenses-data/exp-YYYY-MM.json`, `expenses-data/reports.json`, `expenses-data/statements.json`, `expenses-data/receipts/ID.EXT`.
- Receipt ID: 1–100 ASCII alphanumeric/hyphen/underscore characters. EXT: jpg/jpeg/png/webp/heic/gif/pdf/bin. New replacements must have unique immutable IDs rather than overwrite prior receipt bytes. Validate calendar months, maximum upload 10 MiB. Listing `expenses-data/receipts/` only.

Time Tracking:
- KV `hourly:settings:v1`, `hourly:clients:v1`, `hourly:projects:v1`, `hourly:months:v1`, `hourly:timer:v1`, `hourly:backups:v1`, `hourly:invoices:v1`.
- Files `hourly-data/entries-YYYY-MM.json`, `hourly-data/backups/backup-YYYY-MM-DD.json`, `hourly-data/logo-STAMP.png|jpg|webp` (STAMP decimal timestamp, optional hyphen + safe unique ID to avoid collisions).
- Listing `hourly-data/backups/` only. Validate real months/dates.

Tasks:
- KV `tasks:settings:v1`, `tasks:lists:v1`, `tasks:items:v1`.
- Files `tasks-data/log-YYYY-MM.json`, validated month. No public shares/ICS URLs/collab replicas. Local ICS download remains possible. No file listing required.

## App integration requirements

- Expenses: strict reads (only ENOENT yields defaults); atomic month/index creation, cross-month moves, reports and statement reconciliation; immutable receipt staging before metadata commit, old-byte deletion only after the matching successful commit. Keep manual receipt upload/view and visibly disable cloud OCR, including inherited autoOcr=true. No form loss on failed saves.
- Time Tracking: no offline stub/mirror/outbox/automatic merge/replay in private mode. Timer stop atomically inserts deterministic entry, updates month index and clears the timer, with stable idempotency key. Cross-month moves and invoice/rate-lock operations must be atomic. Failure retains visible unsaved work; loading another device's timer must not create duplicate entries.
- Tasks: no offline SDK shim/mirror/replay, background publication, public routes or collaboration polling in private mode. Atomic multi-key save and monthly archive changes; safe import/wipe strips collaboration/public links. Failure remains visibly dirty rather than queued-success. Backups must not claim archive bytes are included unless actually included.

## Verification and rollout

Source audit reports and immutable initial dirty-file/Serve baselines are in `/home/nadir/.local/share/everything-local/private-rollout/`. There are 51 app manifests; Projects/Invoicing were already privately deployed, and audit reports cover exactly the other 49. Assets lacks application source even in Git HEAD. Email needs a real IMAP adapter; Meetings and Teamchat require service/participant-policy work. Do not mark these apps complete for merely serving a frontend.

For every converted app: red/green unit regressions; existing tests; both builds; real isolated backend and browser save/reopen/restart/fresh-context tests including binary assets, stale-client rejection, denied writes and old-worker migration; independent security/data-loss review; then scoped production activation, actual Tailscale identity verification, backup/restore test, and manifest/hub/desktop updates. Keep all unrelated routes, dirty files and receive-only mail intact. Build sequentially on the memory-constrained Jetson. No commits requested.
