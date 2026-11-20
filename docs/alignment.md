# Alignment and the Canvas

Every Asset of a Character is drawn on the **same Canvas**, so the consumer can swap
sheets without the subject jumping. Alignment is what places a Clip's frames on that
Canvas; it is a property of the **Character**, not of an individual Asset.

Vocabulary: [`GLOSSARY.md`](../GLOSSARY.md) — **Canvas**, **Anchor**, **Character**.

## Canvas and Anchor

A Character's Canvas and Anchor live in `characters/<id>/canvas.json`:

```jsonc
{
  "width": 60, "height": 84,
  "anchor": { "x": 30, "y": 84 }
}
```

- **Anchor** is the first frame's content-box **bottom-centre** — the foot base. It is
  the point every Clip is aligned to.
- The Canvas is **horizontally symmetric about the Anchor** (`anchor.x == width / 2`)
  and the Anchor sits on the bottom edge (`anchor.y == height`). Because of the
  symmetry, a `flipX` draw stays aligned and needs no extra offset.

## A blank Character

A Character is a level above Recordings: it can be created before any footage exists,
so a session can start from the subject rather than from a capture. Such a Character
starts on a **provisional Canvas** (32×32, Anchor at 16,32) that is obviously not
final.

Creating a Character normally asks for a **Segment** instead, and frames the Canvas from
it: the size then comes from the subject rather than a guess. Framing can also be redone
later, on the Alignment face (*frame canvas from frame*), which writes the Canvas the
open Recording's frame implies.

## Adding a Clip

A new Clip **adopts the Character's Canvas**. If the Clip does not fit — its content
would extend beyond the Canvas — the tool does not silently grow the Canvas; it offers
an explicit **resize canvas** action (below).

## Resize canvas

Resizing is an explicit, **Character-level** operation, in either direction
([ADR-0014](./adr/0014-canvas-is-resizable-down-to-content.md)):

1. The Canvas changes, still symmetric about the Anchor.
2. **Every** committed Clip and Sequence of that Character is re-baked to the new
   Canvas — pixels are re-placed, content unchanged. Growing adds margin; shrinking
   crops only what falls outside.
3. The change is recorded as one Character-level change.

It cannot shrink past the **content floor**: the smallest symmetric Canvas the drawn
pixels (plus any Draft's `placementOffset`) still fit on. A size below it is refused
with the floor named. *Fit to content* resizes straight down to it.

### Dragging the Canvas frame

The Canvas' own border is the resize handle: each edge of the board is a grab, and
dragging it resizes. Because the Canvas is symmetric about the Anchor, a width drag
moves **both** sides — one Canvas column dragged is two columns of width — and the
content shifts with it; a height drag adds rows above the Anchor, which is why the
top edge grows upward as well. Corners are not separate handles, for the same
reason: an edge already moves the pair it belongs to.

The drag is a **preview of the store's own arithmetic**: the frame's edge moves, the
Anchor follows it, and every ghost is translated by the delta a re-bake would apply.
The picture keeps the pixel size it was drawn at and is shifted by the same delta, so
it stays still on screen while the area around it grows; shrinking lets the frame clip
it. Nothing is written until release, and exactly one resize is written then — the
preview and the write share one formula, so letting go never jumps.

The pointer is read at the held rate, so one screen pixel of movement is always the
same fraction of a Canvas pixel and the edge tracks the pointer exactly.

Frames and sheets are rewritten **in place**, so their URLs are versioned with a
counter the client bumps on every pixel mutation. Without it the browser reuses the
bitmap it has already decoded and draws the old pixels — a cropped box of the old,
smaller frame — into the new, larger one, which reads exactly like a stretch.

A drag **cannot ask for a size the store would refuse**: it clamps at the content
floor and keeps the width even, so an odd drag lands on whole columns instead of a
rejected save. A drag that ends where it began writes nothing.

Each edge is a real button, so the same resize is on the keyboard: arrow keys move
the edge (a whole column of width, or a row of height; `shift` takes eight), and the
keyboard offers the same clamps. The handles appear only where the Canvas is
editable — a committed Clip's Align face has none, since its framing is read-only
and a fork inherits the Character's Canvas anyway.

## Actions the tool will refuse are disabled

An Alignment action that the store would reject is greyed out **before** the click, and
the reason is on screen in its place — never a save that fails afterwards. *Resize
canvas* is disabled while the typed size is below the floor, has an odd width, is not a
whole positive number, or is already the Canvas size; *Fit to content* is disabled when
nothing is drawn or the Canvas is already at the floor; *Frame canvas from frame* is
disabled while the frame is still being measured, and afterwards when the framing is
already in place or would crop what is drawn. The store still validates — the checks
here only keep the common case out of its error path.

**A resize changes the Canvas' area, not the picture's size.** The board is drawn at
one display rate (pixels per Canvas pixel) and the rate is **held**, so a resize moves
the frame's edges while the sprite stays exactly as big as it was: growing reveals
empty margin, shrinking cuts pixels away. Refitting on every resize would rescale the
sprite under the pointer instead. The rate is always a **whole number of screen pixels**
(never below 1) and the board is drawn with `image-rendering: pixelated`, so a Canvas
pixel is always the same square block. A Canvas that outgrows the stage therefore keeps
its rate and **scrolls** rather than shrinking to a fraction; only a window resize
refits it to the new room. The Canvas' size is printed under the board so the number is
readable without measuring, and the readout counts through the drag.

The store is working data, not a version history: old sheets are overwritten, and the
store's own version control (git) is the revision history.

A Blank Character's provisional Canvas starts at 32×32; framing it from footage
replaces it outright, and once drawn on the floor governs like any other resize.

## Manual placement offset

The automatic Anchor can be slightly off (a first frame in a different pose, a weapon
or cape hanging below the feet). A Clip may carry a manual **placement offset** in its
provenance:

```jsonc
// clips/<clip-id>/provenance.json
{ "placementOffset": { "x": 0, "y": -2 } }
```

- It is a per-Clip property, added on top of the automatic placement; `{0,0}` is not
  recorded.
- It travels with the Clip: re-running reads it back and re-applies it, and **forking
  copies it**.

## Mirroring

A capture is authored facing one way; a Clip that needs the other way carries
`flipX: true` beside its offset:

```jsonc
// clips/<clip-id>/provenance.json
{ "flipX": true, "placementOffset": { "x": 0, "y": -2 } }
```

- Only `true` is recorded; clearing the box drops the field.
- It is applied **after** the Repair replay and before the offset, so Repair geometry
  stays authored on the unflipped frame and a mirror never invalidates a script.
- Mirroring bakes into the sheet at commit. A committed Clip shows *mirror: mirrored*
  and is not re-flipped; fork it to toggle the flag again.
- The Clip face previews the mirror too: the frame is shown turned (sheet and
  footprint overlay together) and Repair clicks are un-turned, so the script still
  lands on the stored, unflipped pixel.
- On the Canvas it previews as a flipped ghost image, never a flipped box, so dragging
  still reads in Canvas space.

## Forking

A fork shares its Character's Canvas. A fork never carries its own Canvas — variants
differ in pixels and in their `placementOffset`, never in Canvas size.

A fork of a mirrored Clip starts from unflipped frames with `flipX: true` retained, so
it reapplies the same mirror on commit rather than baking it twice.

## Committed Clips and Placement

Alignment is edited on a **Draft**. A committed Clip's Align face is read-only: it
shows the baked `placementOffset` and offers *Fork to move*, because a fork is the
only way back to an editable Draft ([ADR-0002](./adr/0002-immutable-assets-fork-to-edit.md)).
Canvas resize is Character-level, so it lives on the Draft/Character Placement face,
not on an immutable Asset.

Read-only or not, a ghost is **one Canvas**, never a whole sheet: a Clip's sheet is
`frameCount` Canvases wide, so its ghost is cropped to the first frame and placed by
the recorded offset. Playback is the only place a sheet is addressed whole, and there
too the frame is a crop of one frame's size rather than the strip squashed into a
plate.

## Validity

Alignment is pixel-coordinate-valid only for the *same frames and the same Canvas*.
Changing a Clip's Segment or expanding/altering the Canvas can invalidate both a Clip's
`placementOffset` and its [Repair script](./repair.md); the tool must **warn** rather
than silently misapply them.
