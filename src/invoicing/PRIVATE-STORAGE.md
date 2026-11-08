# Private Jetson storage

This optional deployment replaces Puter authentication and storage with a small Python/SQLite server on the Jetson. It does not fake a Puter login or use a browser-only persistence shim. The ordinary `npm run build` still produces the upstream Puter deployment; the private build is separate.

## Use the installed app

Open Invoicing (Jetson storage) from the local or Tailscale app launcher, or open:

https://jetson-energy.tail274ca7.ts.net:18923/

The Everything Invoicing desktop entry also opens this address. Keep the Jetson running and connect the laptop to Tailscale under the same account as the Jetson. No additional Invoicing/Puter password is required. On first use, choose **Set up my business** or **Skip for now**. A business email is printed on documents; it does not connect a mailbox.

Refresh an already-open tab to load the private build. Preserve any unsaved work first. If an old installed service worker still shows the Puter landing page, close the old tab and reopen it, or perform a hard reload. Existing Puter records are not automatically copied, deleted, or migrated.

Invoices, clients, settings, saved items, schedules, payments and attachments are stored in:

`/home/nadir/.local/share/everything-invoicing/invoicing.sqlite3`

They are available to another authorized device after reopening or reloading the app. This is not live collaborative editing. A stale save is refused rather than overwriting a newer save; copy any unsaved edits before pressing Reload in the conflict warning.

The optional offline copy remains browser-local, read-only and opt-in. Its keys are separate from the old Puter snapshot. Service workers never cache `/api/` responses. Nextcloud is not needed by this deployment and has not been connected to it.

## Available features and limits

Invoice/estimate editing, clients, payments, attachments, reports, CSV/JSON export and local PDF generation use the private server. The existing 10 MiB per-attachment and 20 attachments per-document UI limits still apply.

Puter public share pages and paid outbound email are disabled. Download a PDF and attach it to Gmail or another mail client yourself. **Send by email** can compose/copy text or open a mail application; that does not confirm delivery and cannot attach files automatically. The private Tailscale URL is not a public customer invoice link. Existing payment-link templates can still point to an external payment provider when the user chooses one.

The Settings JSON backup contains records and attachment metadata, not the attachment bytes. Importing a Puter JSON backup does not fetch its attachments or remove any previously published Puter pages. Retire old public pages in the original account separately.

## Access boundary

The backend listens only on `127.0.0.1:18723`. Tailscale Serve proxies the HTTPS origin above to it; Funnel is off. The server requires the exact configured Host and the owner's `Tailscale-User-Login` header, which Serve supplies. Other tailnet owners and tagged devices without that identity are refused. Do not expose this backend directly on a LAN/public interface or trust arbitrary client-supplied identity headers through another proxy. Local processes running on the Jetson are trusted.

The owner identifier is in `/home/nadir/.config/everything-invoicing/owner-login.txt`. This is a Tailscale login identifier, not a password or token. File permissions are private to the Linux user; the data is not application-encrypted at rest. The private build loads no Puter SDK, and the server's CSP restricts network connections to the same origin.

Mutations require the exact browser Origin, a custom request header, and a quoted resource revision (`If-Match`). SQLite compares that revision and writes within one transaction. Tombstones retain revisions after deletion. A conflict locks further client mutations until an explicit reload; there is no automatic overwrite/retry. Host paths, arbitrary KV keys, directory traversal, and public share folders are not exposed by the API.

## Backups and recovery

`everything-invoicing-backup.timer` runs daily around 03:45 in the Jetson's local time (up to ten minutes of randomized delay), with missed runs caught up when the timer resumes. The newest seven completed snapshots are retained under:

`/home/nadir/.local/share/everything-invoicing/backups/`

These consistent SQLite snapshots include attachments and record data. They stay on the same Jetson, so they do not protect against loss of its disk. Copy a completed snapshot to another device periodically for an off-device backup. Do not copy only the live SQLite file while the server is writing: it can have an associated WAL.

Run a snapshot now:

```sh
systemctl --user start everything-invoicing-backup.service
systemctl --user show everything-invoicing-backup.service -p Result -p ExecMainStatus
```

To restore a SQLite snapshot, stop the Invoicing service, preserve the existing data directory, and copy the completed snapshot into a fresh private directory as `invoicing.sqlite3`. Never mix a restored file with a previous database's `-wal`/`-shm` files. Point the service's `--data-dir` at the restored directory (or put that directory at the original location), then restart and verify the records and attachments. Leave the old directory intact until recovery is confirmed. Do not import a SQLite snapshot through the JSON restore button.

## Build and operate

From `src/invoicing`:

```sh
VITE_PRIVATE_STORAGE=1 npm run build
python3 private_server.py --host 127.0.0.1 --port 18723 \
  --dist dist-private \
  --data-dir "$HOME/.local/share/everything-invoicing" \
  --origin https://jetson-energy.tail274ca7.ts.net:18923 \
  --allowed-login-file "$HOME/.config/everything-invoicing/owner-login.txt"
```

Use the installed user service rather than starting a second listener on the same port:

```sh
systemctl --user status everything-invoicing.service
systemctl --user restart everything-invoicing.service
systemctl --user list-timers everything-invoicing-backup.timer
```

The Python backend uses the standard library (Python 3.10+) and SQLite WAL with FULL synchronous commits. Build artifacts are in `dist-private`; data is deliberately outside that directory and the Git repository. Do not change the Serve route back to the old static-only port 8923 for this private deployment. Other apps and the original Spreadsheet LAN route are unchanged.

## Verification

```sh
LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 npm test -- --maxWorkers=1
python3 -m unittest discover -s tests -p test_private_server.py -v
```

The English test locale is explicit because existing date/money assertions assume English punctuation; production still follows the browser's locale.

Installed browser checks:

- `/home/nadir/.local/share/everything-local/test-invoicing-private.mjs`: real UI, isolated temporary database, no mocked Puter login. Creates a client/invoice, uploads and downloads an attachment byte-for-byte, records a payment, downloads a PDF, restarts the server, opens a fresh browser profile, rejects a stale second-device edit, and tests a network-denied save.
- `/home/nadir/.local/share/everything-local/test-invoicing-production.mjs`: actual HTTPS/Tailscale identity, fresh browser load/reload, same-origin file write/read/delete probe with cleanup; does not create invoice/client records. No fabricated identity headers are supplied in this production check.
- Results: `invoicing-private-results.json` and `invoicing-production-results.json` in the same directory.

These browser tests run on the Jetson. They do not establish a successful connection from a laptop on an outside network; that last network-path check must be made from the laptop.
