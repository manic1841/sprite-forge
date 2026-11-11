# The Canvas is resizable in both directions, never below the drawn content

A Character's Canvas was grow-only (ADR-0006). A guessed Canvas could therefore never
be corrected downwards: a Character created at the wrong size had to be rebuilt, and
the 32×32 placeholder made the wrong size the common case rather than the exception.

The Canvas is now **resizable in either direction at any time**, including after Assets
are committed. A resize is still one explicit, Character-level re-bake: the new Canvas
stays symmetric about the Anchor, every committed Clip sheet and Draft frame is
translated by the same delta, and every Sequence is re-concatenated. Growing leaves the
content untouched; shrinking crops only what lies outside.

The guard is the **content floor**: the smallest symmetric Canvas the drawn pixels
(plus each Draft's `placementOffset`) still fit on. A resize below it is refused with
the floor named, so shrinking never silently trims a sprite. `fit canvas to content`
is the one-click way down to the floor.

Creation changes with it: a new Character is framed **from a Segment** by default, so
its Canvas comes from the subject. A blank Character on the placeholder remains for the
CLI and as an explicit choice.

## Consequences

- ADR-0006's "fixed once established / expand only" rule is superseded; its
  immutability reasoning still holds in the sense that a resize is deliberate and
  Character-wide, never a side effect of extracting one Clip.
- The re-bake is arithmetic already: `placeOnCanvas` already drops out-of-canvas
  pixels, so a negative delta is a crop.
- Repair scripts and placement offsets authored against the old Canvas still warn
  (`framing-changed`, `alignment-framing-changed`) — a resize does not make them
  valid, it only keeps the pixels that survive.
- A variant still never has its own Canvas (ADR-0002, ADR-0006).
