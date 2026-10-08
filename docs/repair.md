# Repair

Repair is the hand-editing stage: removing things that are not the Character
(NPCs, chests, noise) and patching holes in the de-backgrounded frames. It runs on the
RGBA frames after de-backgrounding, so painting **transparent** erases and painting a
**picked colour** patches.

The glossary defines the vocabulary — see [`GLOSSARY.md`](../GLOSSARY.md) for
**Repair** and **Repair script**.

## The Repair script

Repair edits are stored as a **Repair script**: an ordered list of operations, one per
editable Clip state, at `characters/<id>/repairs/<clip-id>/repair.json`. Re-running
replays the operations in order, so a repaired Clip is reproducible from its inputs.

Each operation is:

```jsonc
{
  "tool": "erase-rect" | "erase-brush" | "paint-brush",
  "frames": { "start": 12, "end": 13 },   // half-open; one frame or a span
  "geometry": { },                         // rect {x,y,width,height} for erase-rect;
                                           // stroke {points,size} for the brushes
  "color": "#rrggbb"                       // paint-brush only
}
```

The exact shapes (and the schema) are frozen in
[`format-spec.md`](./format-spec.md#4-repairjson--the-repair-script) —
[`schemas/repair.schema.json`](../schemas/repair.schema.json).

- **erase-rect** — clears a rectangle; the bulk-clear fast path. It is the *same kind
  of operation* as the brush, not a separate mechanism, so it shares the frame-range
  targeting, the undo stack, and the replay.
- **erase-brush** / **paint-brush** — freehand strokes at a chosen brush size.

The script is the single source of truth for a Clip's Repair; it is the undo stack
(undo removes the last operation) and it is written on every operation, so a reload
loses nothing and both front ends resume from the same state.

## Tools and rules

- **Brush** — a chosen size; erasing paints transparent (alpha `0`).
- **Eyedropper** — samples the colour at a pixel of the **current frame's**
  de-backgrounded image. Painting with it writes **opaque** (alpha `255`); pixel art
  has hard edges and no partial alpha (see the mGBA GIF findings), so sampled alpha is
  never carried through.
- Painting the background colour back over the subject needs no extra tool: sample it
  and paint.

## Scope of an edit

An edit targets the **current frame** by default. Applying it to a span (or every
frame) is an explicit action, so a moving NPC is erased frame-by-frame while a
stationary one is cleared once across the whole Clip.

## Commit

Committing **replays** the Repair script and bakes the repaired frames into the
Asset's `sheet.png`. The script stays in `repairs/<clip-id>/` and the Asset's
provenance points at it; the committed Asset is immutable. Repairing further means
**forking** the Asset, which copies the script as the new branch's starting point.
See [ADR-0002](./adr/0002-immutable-assets-fork-to-edit.md) and
[ADR-0005](./adr/0005-repair-as-replayable-operation-script.md).

## Validity

Repair geometry is pixel-coordinate-valid only for the *same frames and the same
Canvas alignment*. Changing a Clip's Segment or re-aligning the Canvas can invalidate
a Repair script; the tool must **warn** rather than silently misapply it. (Alignment is
settled in ticket #6.)

## Non-goals

- No fill-bucket.
- No paint layers.
- No whole-Character palette / recolour sets.

A rough interaction prototype is out of this design ticket: it belongs to ticket #10
(Prototype the web tool surface).
