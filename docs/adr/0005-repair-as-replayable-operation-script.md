# Repair is a replayable operation script, not a raster mask

Repair edits (erasing non-Character pixels, patching holes) are stored as an **ordered
list of operations** — the Repair script — rather than as a raster mask image. Each
operation is a tool (`erase-rect`, `erase-brush`, `paint-brush`) tied to a frame range
and its geometry. Re-running replays the list in order.

Alternatives rejected:

- **A single global bitmap overlay** — simplest, but it applies the same edit to every
  frame, so a moving NPC cannot be handled.
- **A per-frame bitmap mask** — full fidelity, but heavy, and a plain PNG cannot
  distinguish "erased to transparent" from "untouched".

The script unifies rectangular erase and freehand brush as the same kind of operation,
targets one frame or a whole span, keeps the undo stack for free (undo pops the last
operation), stays small and diffable, and feeds directly into provenance. Its one cost
is that it is valid only for the same frames and Canvas alignment it was authored
against — recorded here so the tool warns instead of misapplying.

## Consequences

- Rectangular region erase is an operation kind, not a separate mechanism.
- A Clip's Repair state is `repairs/<clip-id>/repair.json`; `commit` replays it.
