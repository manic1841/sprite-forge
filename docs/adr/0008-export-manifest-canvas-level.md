# The export Manifest is canvas-level, with array bindings

The Export Manifest carries the shared `canvas` (size + `anchor`) **once** at the top
level, and each animation carries only `{sheet, frameCount, delaysMs, loop,
flipsFacing?}`. This follows from the shared, per-Character Canvas (ADR-0006): since
every sheet is the same size, per-animation geometry would be repetition — and the
consumer should never infer geometry from the image.

`bindings` maps a Situation to a **list** of Asset ids, picked at random on entering
the Situation (honouring the chosen animation's `loop`), re-picked only on re-entry.
A list is used so one Situation can play a variety, without the consumer knowing why.

The Manifest carries **no hitbox** and **no per-animation mirror flag**: the clickable
area is the consumer's decision, and direction is handled by the consumer's Facing
(see ADR-0009).

Rejected: repeating `frameWidth`/`frameHeight`/`anchor` per animation (the earlier
shape); a separate `bindings` file; a hitbox field.

## Consequences

- The consumer reads one file and needs no image inspection to render.
- Adding a Situation to the consumer still only needs a bindings entry.
