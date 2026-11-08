# Contacts: explicit private storage

## Activation and scope

`VITE_PRIVATE_STORAGE=1` selects the private adapter and `dist-private` output. Otherwise the original Puter SDK, per-contact KV behavior, cloud authentication and default output remain separate. There is **no global Puter replacement**, browser-primary book, offline outbox, automatic cloud import or localStorage contact migration. Only existing cosmetic preferences (theme/sort) remain device-local.

The build still runs `npm run test && vite build`; do not bypass its pretest gate. Vitest defaults the application flag to `0` so original Puter tests also run during the private pretest. Dedicated private tests opt in explicitly. Builds, deployment, owner authorization, production data and backend policy changes belong to the parent rollout, not this implementation.

Boot awaits the shared browser preparation helper with the source-inspected cache prefix `contacts-shell-`, then an actual authenticated `GET /api/session` for app `contacts`, then the complete book read, **before mounting editing controls**. Preparation/session/read/validation failures fail closed. The shared network-only worker handshake does not force legacy editors to reload. Save/export old tabs and close them if preparation asks. Private HTML strips the SDK, analytics and headless window-hiding script, retains local assets, and replaces MCP discovery with an explicit unavailable notice.

## Native JSON schema

Exactly one KV resource: **`contacts:book:v1`**. No file resources or listing endpoint.

```json
{
  "version": 1,
  "contacts": [
    {
      "id": "literal-contact-id",
      "firstName": "Ada",
      "lastName": "Lovelace",
      "nickname": "",
      "company": "",
      "jobTitle": "",
      "emails": [{ "label": "Work", "value": "ada@example.org" }],
      "phones": [],
      "urls": [],
      "addresses": [],
      "birthday": "",
      "notes": "",
      "tags": [],
      "photo": "",
      "favorite": false,
      "createdAt": 1800000000000,
      "updatedAt": 1800000000000
    }
  ]
}
```

The example timestamps are illustrative, not production data. Addresses have all these string fields: `label`, `country`, `street`, `street2`, `city`, `state`, `postalCode`, `poBox`; no additional properties. Emails/phones/URLs are `{label,value}` string entries. Tags are canonical, nonempty, case-insensitively deduplicated strings. IDs are nonempty literal strings without ASCII control characters, unique across the book; they are not trimmed, rewritten or regenerated on hydration. Names and other normalized display fields must already be canonical. Timestamps are positive safe integer milliseconds, favorite is boolean. The existing contact identity/email/birthday validation applies; birthday retains the original format-only validation, including yearless `0000-MM-DD` (not a new calendar-date validator). Photo is empty, a base64 image data URI, or an HTTP(S) URL.

Validation rejects unknown versions, malformed/noncanonical records, duplicate IDs and fields that normalization would discard. Missing native state (`null`) alone initializes an empty book. Other failures are never treated as empty. The adapter passes **native objects** to the shared client; the wire format is the shared `{value: JSON.stringify(book)}` envelope, not a doubly serialized native document.

## Acknowledgement, conflicts and limits

- One hydrated in-memory book backs the local `get/set/del/list` interface. Listing is complete, with cloned records and no pagination/truncation. Listing/reload does not fetch a new revision to accommodate stale editors.
- Per-contact mutations are cloned at invocation, serialized, applied to the last acknowledged book, and saved through the shared client's sticky whole-book If-Match baseline. Committed store state is published only after acknowledgement. No timestamps win, merges, force-writes or automatic refresh/retry.
- Conflicts are deliberately **book-wide**: two tabs changing different people can conflict. Every mutation failure latches this adapter, including uncertain outcomes, and later queued work cannot silently clear it. Export/copy drafts, retain the import source file, then explicitly reload to reconcile. A reload may show an uncertain write that actually reached the server.
- Manual editor text remains after failure. Edits made while a save/delete acknowledgement is pending remain open and unsaved. Follow-up save reuses the same preassigned contact ID. Pending avatar decoding blocks both save and **Export draft**, with a visible processing warning and no premature download; export after decoding includes the chosen photo. Discard confirmation and beforeunload warnings cover drafts and queued/failed writes. Browser unload prompts remain subject to browser restrictions; this is not crash-proof local persistence.
- The visible status distinguishes saved, unsaved/pending and failure. Export all/selected exports acknowledged contacts; **Export draft** exports the currently open form, not the committed book. Do not treat an export as a successful server save. Wait for avatar processing before exporting.
- Each contact, including avatar, is capped at **400 KiB of UTF-8 JSON**. The whole escaped KV request body is capped at **8 MiB**, matching backend metadata framing. Inline photos consume the same shared budget; there is no separate blob storage. Existing local image resizing is retained (480px maximum dimension, JPEG compression). HTTP(S) avatar URLs remain URLs and may request an external image when displayed.
- Every individual update transmits the entire book. Large books/avatars and bulk jobs therefore have substantial memory, transfer and repeated-serialization costs. No sharding, paging or background reconciliation is implemented.
- Bulk imports/tag changes/deletes remain independent operations, not all-or-nothing batches. Only acknowledged records count as saved/deleted. Imports report written/skipped/failed counts; after the first latched failure subsequent queued records fail without writing. Keep the original source to recover the remainder.
- Private imports serialize deduplication together with their writes and committed-store publication. The same store-level FIFO covers manual saves, `saveMany` (including restore/tag paths), single deletes and bulk deletes. Overlapping file drops cannot overwrite a pending new UID or add a duplicate identity; a later delete cannot overtake an earlier queued tag update and then be resurrected by it. Contact values, delete IDs and progress options are captured at invocation; delete existence checks run only after preceding jobs publish their acknowledged state, including pending creations. Bulk workers call the adapter directly rather than recursively joining the store queue. Queued work remains continuously dirty through acknowledgement/publication. Progress starts when the job runs, excludes missing IDs/duplicate imports, and reaches its eligible total including failed records. Successful deletes clear matching selection/checks only after acknowledgement; failed deletes preserve them. A failed earlier insertion does not reserve an identity as a successful skip: later uncommitted imports report failure through the latched adapter, without another network write. Deleting an absent/uncommitted ID remains a no-op, not a successful deletion. Default Puter concurrency and result shapes remain unchanged. Private bulk failure messages direct users to export/manual reload rather than ineffective retry.

## Features and migration

Manual contacts, favorites, tags, search, avatar editing, local picker/drop vCard import, and local single/all/selected vCard export remain available. Private vCards include UID and preserve supplied UID literally; blank/control-character/repeated UID properties are rejected. Quoted-printable UID soft continuations are accumulated as untrimmed raw values before decoding, preserving the complete identifier, literal spaces and escaped punctuation instead of a continuation suffix. A vCard without UID gets a newly generated ID. Import is **additive, never replacement**: existing IDs and identity duplicates are skipped, including duplicates within and across overlapping imports.

No automatic Puter/localStorage migration exists. Export vCards from the original application and deliberately import into the new private book. The original vCard format is not a lossless database backup: favorite flags, creation/update timestamps and unsupported vCard extensions are not round-tripped; native private JSON backup/restore is an operator/backend responsibility, with no native JSON import UI. Preserve a backend backup before any operational replacement. Do not hand-edit schema versions or normalize identifiers to force an import.

Private Smart Add/AI, Drive/SDK file-open imports, Calendar, cloud sharing, headless service and MCP/app-to-app bridges are explicitly unavailable. Their runtime entry points are gated, not fake successes. The visible feature notice explains this. `mailto:` is an external mail-client handoff only; this app does not send mail or change mail infrastructure. Local clipboard/downloads remain local browser actions.

## Verification and selectors

Run from `src/contacts`:

```sh
flock -w300 /home/nadir/.hermes/cache/scratch/everything-private-tests.lock env LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 npm test -- --maxWorkers=1 --minWorkers=1
```

Latest executed correction gate: **380 tests passed in 29 files**, both normally and with `VITE_PRIVATE_STORAGE=1` in the invoking environment (the test config retains default-mode isolation for original suites). The new focused delete-order suite passed **14 tests**. Incremental expected-behavior RED/GREEN steps separately reproduced single-delete FIFO failure (1 failed → 1 passed), bulk-delete FIFO failure (1 failed/1 passed → 2 passed), and single-delete checked-state cleanup (3 failed/5 passed → 8 passed); further missing-ID, partial/latched-failure and drain coverage passed without additional production changes. The earlier import race, pending-avatar export and quoted-printable UID fixes remain covered by the full suite. No builds, deployment, lint commands, scanners or blocked staging were run for this correction pass.

New suites:
- `src/private-delete-order.test.js`: actual store/adapter/shared client with controlled HTTP acknowledgements; single/bulk delete FIFO after queued tag updates, pending save/saveMany/import creation, captured IDs/options, acknowledged selection/check cleanup, missing/already-deleted IDs, partial failure with serial/default concurrency, latched rejection drain and continuous dirty state.
- `src/private-storage.test.js`: actual shared client with controlled HTTP responses; worker/session sequencing, session denial/mismatch, schema/size validation, full listing, captured serial native JSON saves, stale edits/deletes and uncertain timeout.
- `src/private-ui.test.js`: actual DOM editor/store/import paths; overlapping drops (same UID and different UID/duplicate identity), sibling pending inserts, invocation snapshots/progress, failed-first/queued-later import results, delayed/rejected saves and deletes, generation preservation/stable IDs, draft export/status/unload, pending-avatar export protection, partial imports, private bulk recovery wording and feature gates.
- `src/private-boot.test.js`: actual entrypoint, no editing before preparation/session/hydration; denied session fails closed.
- `src/private-config.test.js`: default/private config, HTML/worker/MCP transformation and unchanged build pretest script; does not execute a build.
- `src/private-vcard.test.js`: optional private UID/inline-avatar round-trip and invalid UID rejection; long, short and multiple quoted-printable UID continuations with literal spaces/escapes; default UID ignoring and display-field decoding unchanged.

Selectors for parent browser checks:
- `[data-private-status]`: saved/unsaved/error text (`role=alert` on error).
- `[data-private-features]`: unavailable features and additive import explanation.
- `[data-action="new"]`, `[data-action="smart-add"]` (disabled privately).
- `.overlay--editor`, `[data-form]`, `[name="firstName"]`, `[name="notes"]`, `[data-error]`.
- `[data-action="save"]`, `[data-action="delete"]`, `[data-action="export-draft"]`, `[data-action="close"]`.
- `[data-confirm="ok"]`, `[data-confirm="cancel"]`; avatar `[data-action="pick-photo"]`, modal `input[type="file"]`.
- `[data-action="list-options"]` opens local import/export options; `.contact-item[data-id]` selects a literal record; `[data-list]` and `[data-count]` report the acknowledged book.

The implementation tests do not establish real Tailscale authorization, real-browser worker migration, durable backend restart/backup/restore, browser file/image codecs or deployment readiness. The parent must run default/private builds and isolated real backend/browser checks (fresh profiles, denied writes, stale tabs, restart, migration and backup/restore) before activation. Existing tests emit their pre-existing Node localStorage warning and expected mocked Calendar failure diagnostics.
