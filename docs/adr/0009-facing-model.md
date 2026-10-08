# Direction is the consumer's Facing; a turn animation flips it

Art is drawn in **one** direction (`authoredFacing`, always `right`). The consumer
holds a **Facing** and draws a sheet mirrored whenever Facing differs from
`authoredFacing`. An animation marked `flipsFacing: true` flips the consumer's Facing
when it finishes, so a `turn` animation switches the character's direction for
subsequent animations.

This keeps direction out of the asset (matching the rule that direction is not
identity) and lets one `turn` animation serve both directions: played while facing
right it ends facing left, and vice versa, because the consumer mirrors it like any
other animation. Direction changes are an explicit, authored event rather than a
side effect scattered across the art.

Rejected: a per-animation fixed mirror flag (can't express "flip after playing");
baking left-facing art (doubles the assets for a mirror); the consumer guessing
direction from animation names.

## Consequences

- No left-facing sheets exist; the consumer mirrors at draw time.
- `turn` (or any turner) is authored once and is direction-agnostic.
