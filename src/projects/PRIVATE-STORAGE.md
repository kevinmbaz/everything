# Private Projects on the Jetson

## What changes

The opt-in private build replaces Puter authentication and storage with an
owner-restricted Tailscale connection and a real SQLite backend on the Jetson.
The default build remains the original Puter application. No fake Puter object
or simulated login is installed.

Private address: `https://jetson-energy.tail274ca7.ts.net:18919/`.
Connect the accessing device to the same authorized Tailscale user account.
Tailscale supplies the login identity automatically; neither the mailbox
password nor a Puter account is used. Only the configured owner is accepted.
This is a single-owner workspace, not a multi-user collaboration server.

## Storage and access boundary

- Backend binds only `127.0.0.1:18719`; Tailscale Serve supplies private HTTPS.
- Owner identity: `~/.config/everything-projects/owner-login.txt`.
- Primary database: `~/.local/share/everything-projects/projects.sqlite3`.
- Project documents, settings, indexes, templates, saved views, attachment bytes
  and project restore points are stored in that database, outside the source
  tree and build output. Keep the entire data directory private.
- The browser holds the open editor in memory. Private mode does not use the
  old Puter IndexedDB mirror or offline write replay. Stay connected and wait
  for `Saved to Jetson` before closing the tab. On failure, keep the tab open,
  retry when connected or export your edits. Downloads go to the accessing
  device, not automatically into a Jetson directory.
- Same-origin mutations require a custom request header and revision. SQLite
  compares revisions atomically, retaining deletion tombstones. A conflict
  blocks further mutations until an explicit page reload; export unsaved edits
  first. Reads never silently adopt a newer write baseline.
- The service trusts local OS processes. Tailscale identity headers are not
  passwords and would be forgeable through a publicly exposed backend; never
  bind it outside loopback or enable Tailscale Funnel for this route.
- Old Projects shell caches are retired without automatically reloading an
  editor. Existing cloud browser data is not imported, deleted or replayed.

## Supported features and limits

Normal boards, tasks, progress, descriptions, checklists, comments, milestones,
settings, local attachment uploads/downloads and ZIP backup/import use the local
adapter. Puter Drive selection and links are unavailable in private mode; upload
original files instead. Imported web links still point to external websites.
A legacy Puter Drive link is not a copied attachment and cannot be retrieved
without Puter. Full ZIP export reports missing attachments rather than inventing
file contents.

No data is migrated automatically from a Puter account. Export a full ZIP from
the original app and use private Projects → Settings → Import. Import creates
new project identifiers, not overwrites of existing projects. Review any missing
attachment warnings. The normal `dist` build remains available for cloud use.

No SMTP, OTP delivery or outgoing mail is needed for this Tailscale login.
The separate working mail service is unchanged.

## Build and verification

From `src/projects`:

    LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 npm test -- --maxWorkers=1
    python3 -B -m unittest discover -s tests -p test_private_server.py -v
    npm run build
    VITE_PRIVATE_STORAGE=1 npm run build

The private output is `dist-private`, with no external SDK and no data caching
service worker. Its small `/sw.js?private=1` retirement worker replaces older
cache controllers. English locale is specified because existing date-format
tests assume English punctuation; production locale behavior is unchanged.

Real-browser harnesses and their JSON reports are outside the repo:

    ~/.local/share/everything-local/test-projects-private.mjs
    ~/.local/share/everything-local/projects-private-results.json
    ~/.local/share/everything-local/test-projects-production.mjs
    ~/.local/share/everything-local/projects-production-results.json

The isolated harness exercises actual UI edits and binary attachments against
an isolated backend, restarts it and opens a fresh browser profile, then tests
stale-device writes, failed saves and full ZIP exports. Synthetic identity
headers are used only in that loopback test. The production probe crosses the
actual Tailscale Serve proxy without fabricated credentials, tests a uniquely
named temporary attachment, briefly restarts only the Projects service to prove
persistence, and deletes the probe afterward. It also follows the private hub
link. It does not populate the owner's projects with demonstration tasks.

A host-side browser check is not a test from the user's laptop or mobile data.

## Service and backups

Deployment units:

    everything-projects.service
    everything-projects-backup.service
    everything-projects-backup.timer

Service commands:

    systemctl --user status everything-projects.service
    systemctl --user restart everything-projects.service
    systemctl --user start everything-projects-backup.service
    systemctl --user list-timers everything-projects-backup.timer

The timer is configured for 04:00 host-local time plus up to ten minutes random
delay, with missed jobs caught after downtime. The SQLite backup API creates
consistent standalone snapshots under `~/.local/share/everything-projects/backups`
without stopping the app. Seven completed snapshots are retained. Attachments
are included because they are stored in the database.

These are same-disk backups, not protection against losing the Jetson disk.
Copy a verified snapshot to a separate device for disaster recovery. Snapshots
are private by permissions, not encrypted at rest by this app.

To restore, stop the Projects service and preserve its current data directory.
Restore a verified snapshot into a fresh private directory as `projects.sqlite3`;
do not mix it with old `-wal` or `-shm` files. Check SQLite integrity, select that
directory in the service and restart. Never test restoration over live data.

## Deployment records and rollback

`~/.local/share/everything-local/projects-serve-before.json` records the old
Serve configuration. Only Projects port 18919 should switch from backend 8919
to 18719. Keep all other routes and the no-Funnel state unchanged.

Rolling the route back to 8919 restores the Puter frontend, not the private
workspace: these are separate stores. Preserve `everything-projects` data and
backups even when rolling back the UI. Do not blindly restore the entire old
Serve configuration over later unrelated route changes.
