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

## Adding a Clip

A new Clip **adopts the Character's Canvas**. If the Clip does not fit — its content
would extend beyond the Canvas — the tool does not silently grow the Canvas; it offers
an explicit **expand canvas** action (below).

## Expand canvas

Expanding is an explicit, **Character-level** operation:

1. The Canvas grows to fit the new content (still symmetric about the Anchor).
2. **Every** committed Clip and Sequence of that Character is re-baked to the new
   Canvas — pixels are re-placed, content unchanged.
3. The change is recorded as one Character-level change.

The store is working data, not a version history: old sheets are overwritten, and the
store's own version control (git) is the revision history. See
[ADR-0006](./adr/0006-per-character-fixed-canvas-and-explicit-rebake.md).

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

## Validity

Alignment is pixel-coordinate-valid only for the *same frames and the same Canvas*.
Changing a Clip's Segment or expanding/altering the Canvas can invalidate both a Clip's
`placementOffset` and its [Repair script](./repair.md); the tool must **warn** rather
than silently misapply them.
