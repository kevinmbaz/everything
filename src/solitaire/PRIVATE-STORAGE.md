# Private Solitaire storage

## Selection and authority

`VITE_PRIVATE_STORAGE=1 npm run build` selects the opt-in private build in
`dist-private`. The shell, runtime flag and network-only worker share that exact
process-environment switch; a `.env` file alone does not select this mode.
`npm run build` remains the original Puter/browser-storage build in `dist`.
This implementation does not deploy either build.

Private startup awaits shared browser preparation, authenticated Solitaire
session verification, and validated server hydration **before mounting play**.
Only a successful missing-document read (`null`) creates a fresh private game;
its first save must be acknowledged before play. Preparation/read/validation or
initial-write failures do not fall back to localStorage, Puter, or a new board.
Startup is single-use: no later hydration can replace a board being played.

The sole resource is native JSON KV **`solitaire:state:v1`**; no files or lists.
All seven existing modes retain the real engine: `klondike-1`, `klondike-3`,
`vegas-1`, `vegas-3`, `spider-1`, `spider-2`, `spider-4`.

## Version 1 document

```text
{
  v: 1,
  mode: one of the seven mode keys,
  game: {
    id: stable opaque ID (cryptographic UUID for new private games),
    started: boolean,
    won: boolean,
    board: existing compact Klondike/Spider serializer snapshot, ts: 0
  },
  stats: {
    v: 1, played, won, bestMoves: integer|null, ts,
    modes: { modeKey: { played, won, bestMoves } },
    vegas: {
      devices: { deviceId: { bank: signed integer, ts } },
      settled: [gameId, ...]
    }
  },
  settlements: [{ gameId, deviceId, score, outcome: "won"|"abandoned" }, ...]
}
```

The top-level stats counters represent `klondike-1`, matching the original
stats adapter; other played modes have their own entries. `board` retains the
original serializer's v1/v2 discriminator, piles, moves, draw/suit variant,
Vegas score/redeals and Vegas game ID. It intentionally has no timestamp winner
semantics. Stats/device timestamps are descriptive only, never merge criteria.

Validation rejects unknown document fields, malformed/coerced counters,
unknown/mismatched modes, impossible win/start flags, invalid card multiplicity,
invalid foundation/face orientation, impossible Vegas score/redeals, duplicate
settlements, and device banks not equal to their ledger totals. Private Spider
snapshots require numeric suit counts `1`, `2`, or `4` matching the mode and
stock sizes `0`, `10`, `20`, `30`, `40`, or `50` (whole remaining deal rows).
These checks do not change the default serializer's legacy tolerance. IDs are
preserved literally, never repaired. Hydration and every outgoing capture are
validated.

## Atomicity, accounting, undo

Each committed move/undo/new deal captures one immutable document, synchronously
including board, mode, statistics, bank and settlement changes. Writes are
serialized through the shared conditional-revision client; no timestamp merge,
fresh-baseline retry, force-save, or local outbox exists. Queued captures cannot
observe later mutable board/stat objects. Dirty includes local captures before
transport starts, queued/in-flight writes, conflicts and uncertain failures.
Only an acknowledgement matching the latest generation produces **Saved to
Jetson**. An older acknowledgement cannot save a newer move.

A game is counted once on first play. Undo back to zero moves does not uncount
it or charge it twice. Untouched deals cost nothing. Win accounting/settlement
occurs with the winning move, before celebration; animation callbacks are
presentation only. Completed boards persist and reopen as completed. Undo or
further moves after a win are prohibited. New/mode-change settles an actually
played abandoned Vegas game and captures the replacement board atomically.

The settling browser receives the credit/debit in its own bank entry; the shown
bank is the sum across devices, plus the current unsettled score as in the
original app. Both settlement records and the mirrored settled-ID list are
retained without the legacy 100-game truncation. A bank must equal the sum of
its device's settlements. Ledger growth has no compaction UI: an eventual server
size-limit rejection remains visibly unsaved rather than dropping history.

The original compact serializer does **not** contain undo history. In-tab undo
works; reopening starts with empty undo history but retains `started`/`won`
accounting flags. Standard Klondike's unlimited-redeal counter is also not part
of its original v1 snapshot; this does not change its unlimited-redeal rules.

## Migration, device identity, recovery

Private state starts new. There is **no automatic or manual legacy import** and
no silent merging of existing localStorage/Puter boards, stats or Vegas banks.
Legacy data is neither read nor deleted in private mode. A future import must
explicitly validate IDs and accounting and describe whole-document replacement.

Only `solitaire.private.device.v1` is kept in localStorage, as non-primary device
attribution, separate from legacy `solitaire.device`. Clearing it creates a new
attribution bucket, not a new bank total. Storage-denied browsers use a
page-lifetime identity. No game/progress/preferences/outbox mirror is stored
locally; mode preference is authoritative server data. There are no persisted
private cosmetic preferences in this implementation.

On write failure/conflict, the visible board is retained, further play is locked,
and beforeunload warns. **Export draft** downloads the captured document (not an
acknowledged backup, not undo history; a validation-failed draft can be invalid).
There is no import UI. **Reload server state** requires confirmation while dirty
and discards the local draft. There is deliberately no retry/refresh-and-save
button. For a lost response, reload discovers whether the atomic write landed;
its persisted flags/ledger prevent duplicate wins or settlements. Export first
if newer local moves need to be retained for manual recovery.

## Browser/build checks and limits

The inspected legacy worker uses `CACHE = 'solitaire-v2'`; preparation and the
shared Vite plugin use **`['solitaire-v']`**, not an invented prefix or all-cache
clear. Private HTML removes the Puter SDK, keeps local card art/icons, and emits
the shared network-only worker. Old tabs must be saved/closed when safe worker
handoff cannot complete; the app does not force their reload. Private play is
online-only, despite the default app's offline/PWA metadata.

Useful selectors: `#private-storage-status[data-state]` (`loading`, `unsaved`,
`saved`, `error`, `conflict`), `#private-export`, `#private-reload`, `#board`,
`#newgame`, `#undo`, `#mode`, `#modeMenu [data-mode="vegas-3"]`,
`.pile[data-kind="stock"]`, `#moves`, `#score`, `#bank`, `#winNew`.

Unit coverage exercises all mode serializers/real final moves, one-shot gated
startup, coherent captured writes/newer mutations, failures/conflicts/uncertain
responses, bank/undo/reopen invariants, strict validation, DOM wiring seams,
and private/default Vite plugin configuration. Transport tests use the real
shared client with an in-memory fetch fixture; UI rendering is stubbed in unit
tests. These are **not** live browser/backend/deployment results. Parent gates
remain: both builds and artifact inspection, real HTTPS authenticated browser
startup/reopen/restart/fresh-device/CAS/failure checks, legacy-worker migration,
mobile layout and drag/celebration checks, backup/restore and independent review.
