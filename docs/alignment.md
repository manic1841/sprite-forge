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

**The board holds its zoom.** The Alignment board is shown at one display rate (pixels
per Canvas pixel) and a resize keeps it, so a smaller Canvas appears as a smaller board
and the edges simply cut the pixels off — a crop, not a zoom-out, not a resample. The
rate is clamped to the stage, though: growing past the room lowers it. Only a window
resize clears it and refits. The board's `image-rendering: pixelated` keeps it honest at
every rate, and the Canvas' size is printed under the board so the number is readable
without measuring.

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

## Forking

A fork shares its Character's Canvas. A fork never carries its own Canvas — variants
differ in pixels and in their `placementOffset`, never in Canvas size.

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
