# A Segment may carry a source box

The pipeline had exactly one way to separate a subject from its frame: colour-key the
corner-sampled background. That assumes a flat backdrop. A capture with a busy scene, a
HUD, or a palette close to the subject leaves other colours behind, and every one of
them is "content" to the crop — so the union bounds inflate toward the whole frame and
the Canvas, Anchor and content floor are all measured against the wrong thing. There was
no way to say "only this part of the frame is the sprite".

A Segment may therefore carry a **box** (`rect` in `cuts.json`): one rectangle of the
source, in source pixels.

The box is a **window, not a mask**. It is applied to the raw frame before the key, so
nothing outside it is measured, keyed, cropped or placed, and the box's size is the most
an extraction can produce. Content is still cropped to what is actually drawn inside it,
so a loose box adds no margin; the key colour is still sampled from the whole frame's
corners, because a tight box would otherwise put the subject in its own corner and key
it away.

The box is **clipped** to the frame rather than validated against the source size, so a
box that outlives the frame it was drawn on still extracts. A frame that shows nothing
inside the box is a hard error naming the frame, because a fully transparent frame reads
as a flicker in an otherwise good Clip.

## Consequences

- The box belongs to the **Segment**, not the Draft or the Recording: the time range and
  the space range are one piece of footage, and re-cutting a range must not silently
  relocate it. Different Segments of one Recording can use different windows.
- It is part of the extraction snapshot (`DraftSegmentSnapshot`, `ClipProvenance.segment`)
  and therefore of reproducibility: a committed Clip re-runs through the same window. It
  is inherited by a fork like the range and speed are.
- One box covers the whole Segment's frames. A subject that leaves the box is cut by it;
  per-frame boxes are a later step that upgrades `rect` to an array without changing the
  single-box semantics.
- `contentFloor` needs no change: extraction already stores narrower frames, so the floor
  narrows with them.
- Without a box everything behaves exactly as before, so no `cuts.json` needs migrating
  (ADR-0010).
