# Explicit private Sudoku mode

This is an opt-in source integration, not a deployment. Normal `npm run build`
continues to use `dist/`, browser-local progress and optional Puter sync.
`VITE_PRIVATE_STORAGE=1 npm run build` selects `dist-private/` and the shared
private-storage plugin. Build/deployment and real authenticated browser rollout
checks belong to the parent rollout; do not serve a private build as a standalone
unauthenticated static site.

## Authority and startup

Private mode awaits `preparePrivateBrowser`, the actual `/api/session` for app
`sudoku`, and `GET /api/kv?key=sudoku%3Astate%3Av1`, in that order. Until hydration
validates, `#app` is inert; no game, timer, generation, editor or autosave starts.
Only a missing document (`null`) starts a new game. Failed authorization, worker
preparation, malformed state or failed reads leave the app blocked without
writing defaults over the server.

The original local module generation worker and inline engine fallback are
unchanged, including seeded daily generation. They compute puzzles, not storage.
No puzzle-generation service was added.

The source audit found **no legacy Sudoku service worker or cache prefix**.
Private preparation and the network-only replacement worker therefore own only
`sudoku-private-`. They do not clear other caches or force-reload old editors.
The shared worker lifecycle/readiness handshake is reused without modification.
The private HTML removes the eager Puter SDK and the inline localStorage theme
reader, retaining local fonts/icons/assets. Normal HTML keeps both original
behaviors. Private runtime does not import the local/Puter persistence adapter.

## Native JSON document

Exactly one KV resource is used; no files or list APIs:

```text
sudoku:state:v1 = {
  v: 1,
  snapshot: null | <original encode(game) snapshot, v: 2>,
  settings: {
    theme: "light" | "dark" | "system",
    highlightPeers: boolean, highlightSame: boolean,
    checkAsYouGo: boolean, autoClearNotes: boolean,
    showTimer: boolean, showRemaining: boolean
  },
  stats: {
    v: 1,
    byDifficulty: {
      easy|medium|hard|expert: {
        played: integer, solved: integer, flawless: integer,
        bestMs: positive integer | null, totalMs: integer
      }
    },
    daily: {current: integer, best: integer, lastDate: "YYYY-MM-DD" | null},
    ts: integer
  },
  gameId: nonempty literal safe identifier | null,
  settled: boolean
}
```

The snapshot retains `difficulty`, `seed`, `daily`, puzzle/solution/value strings,
notes, eliminated candidates, elapsed milliseconds, hints, mistakes and `ts`.
Validation rejects unknown fields, unsupported versions, invalid settings,
unsafe/negative counters, invalid calendar dates, noncanonical note tokens,
invalid boards and inconsistent settlement state rather than normalizing away
server corruption. The existing decoder validates the solution and givens;
canonical re-encoding additionally rejects its permissive parsing repairs.
Timestamps are metadata, never merge or overwrite authority.

A new puzzle gets a fresh game ID and increments played **in the same document**.
Completion stores the solved snapshot, sets `settled: true` and records the result
and daily streak together. Unlike normal mode, the completed board remains
visible after reopen and is read-only. Reopening or attempting settlement again
does not recount it. Explicitly starting another puzzle is another played game;
replaying a daily may add a solved game, while the original daily streak logic
counts the date only once. Resetting records is an explicit whole-document
mutation; it does not unset an already-completed game's settlement marker.

`clearGame()` writes `snapshot: null, gameId: null, settled: false` in the document
while retaining settings/stats. It does **not** DELETE the KV resource, which would
also destroy those records. Queue ordering prevents an earlier save from
resurrecting a cleared snapshot. The UI normally replaces a board with a newly
started puzzle, rather than exposing a separate clear-progress button.

## Saves and failure behavior

- Every mutation captures a validated, detached full document before awaiting I/O.
  Writes are serialized, and the shared client supplies its original-read CAS
  revision. There is no refresh-and-retry, timestamp merge or force save.
- Board edits, reading a hint, settings and results save immediately. Active
  elapsed time is dirty between periodic five-second captures; pause and
  visibility/pagehide also flush the current snapshot. Closed/hidden time and
  replacement-generation waiting time are not charged, including hidden/visible
  transitions while the worker is pending. A rejected generation restores the
  original timer and pause state; a successful replacement resets to zero and
  runs only when visible. Resume callbacks cannot restart a hidden or failed private timer.
  Pause and wait for **Saved to Jetson** before leaving deliberately.
- Saved means the corresponding generation was acknowledged. An old response
  cannot clear a newer draft, queued mutation or unsent timer change.
- Any denied/conflicting/uncertain/malformed write latches an error. Further
  queued writes stop; the board and local draft remain visible, controls freeze,
  the timer stops, and dialogs close so recovery controls stay accessible.
  A delayed puzzle-generation result cannot replace that failed draft.
- Dirty drafts, queued writes and failures trigger `beforeunload`. There is no
  guarantee that an asynchronous pagehide request finishes; the warning and
  matching acknowledgement are the safeguard, not a claimed unload save.
- **Download draft (not a server save)** exports a JSON recovery copy to the
  accessing device. It neither marks work saved nor writes to Jetson. Inspect and
  keep that copy before manually reloading after an error. There is no automatic
  retry/recovery, and no import UI in this batch.

## Deliberate limitations

No automatic migration of `sudoku.save.v2`, `sudoku.settings.v1`,
`sudoku.stats.v1`, or Puter records. No localStorage/IndexedDB primary store,
offline writes, durable browser outbox or automatic replay. A private session
must load successfully online before play; a storage failure freezes play.

The original serializer does **not** preserve undo/redo history. A reload restores
values, pencil marks, eliminations and counters, but not the move history,
selection, notes-entry mode, open hint card or pause UI state. Private mode does
not claim otherwise. Restored difficulty comes from the saved puzzle, not an
unsaved next-puzzle selector choice.

## Browser verification selectors

- `#private-storage-panel`, `#private-save-status` (`role=status`)
- `#private-export` (available after successful hydration, including failed writes)
- `#app` (`inert` while loading or after an error)
- `#board [data-index="0"]` through `80`, `#keypad`, `#clock`
- `#new-game-btn`, `#daily-btn`, `#difficulty-select`, `#pause-btn`
- `#notes-btn`, `#undo-btn`, `#redo-btn`, `#hint-btn`, `#hint-apply`
- `[data-theme-choice="dark"]`, `#settings-btn`,
  `input[aria-label="Show the clock"]`
- `#stats-btn`, `#stats-reset`, `#confirm-yes`, `#solved-dialog`

## Test scope and rollout gates

Executed result: **405 tests passed across 20 files** with Vitest 4.1.11,
`--maxWorkers=1` and the shared flock. This includes all 333 original tests and
72 added checks: 37 private-document/transport, 32 main-module UI/default-mode,
2 build-config/HTML and 1 actual worker-thread test. `git diff --check` passed.
The focused `tests/private-main.test.js tests/timer.test.js` run passed all
46 tests. No actual builds or deployment were run by this app agent.

Timer regressions use fake time and deferred generation/cloud responses. They
cover both normal and private mode: 1000 ms of play stays exactly 1000 ms during
replacement generation across hidden/visible transitions; success and rejection
settle correctly whether hidden, visible or previously paused. An eligible new
puzzle runs from zero; rejected work resumes only when visible and not paused.
Incremental RED/GREEN runs reproduced 6000 ms instead of 1000 ms for generation
visibility, hidden resume and a late resume callback after storage failure.
A normal-mode late cloud adoption also reproduced 5000 ms instead of 1000 ms
while paused/generating; the adoption guard now preserves the veiled board,
while a separate playing case confirms ordinary cloud adoption still works.
Only four lifecycle guards changed; generation-success/rejection clock starts
already checked visibility and the private failure latch.

Tests use the actual shared transport with controlled HTTP responses, plus the
real main module in jsdom. They cover startup gates, strict validation, captured
writes/CAS, stale clients, denied/network/malformed responses, lost responses
after commit, newer-draft protection, ordered clear-save, atomic completion and
reopen, notes/settings/timer/hints, export, modal recovery and normal-mode local
saving. The separate worker-thread bridge executes the **actual unchanged**
generator worker and compares its daily puzzle to the real inline generator;
existing worker failure/inline fallback tests remain intact.

This is not a claim of browser/service-worker or deployed HTTP verification.
Parent gates still include both actual builds and bundle inspection, real browser
module-worker operation, authenticated backend restart/fresh-profile persistence,
concurrent tabs, denial, worker migration/readiness, backup/restore and independent
review. No deployment, service, production data, dependency or shared-helper
changes are part of this app patch.

Run from the repository root, serially on this host:

```sh
flock /home/nadir/.hermes/cache/scratch/everything-private-tests.lock \
  env LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 \
  node src/sudoku/node_modules/vitest/vitest.mjs run \
  --root src/sudoku --maxWorkers=1
```

New behavior was developed in incremental executed RED/GREEN cycles; existing
engine/worker regressions are retained. Vitest 4 rejects `--minWorkers` here.
