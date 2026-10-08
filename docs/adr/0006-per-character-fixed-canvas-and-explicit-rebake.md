# One fixed Canvas per Character; expanding it is an explicit Character-level rebake

A Character has a single Canvas and Anchor (`characters/<id>/canvas.json`), shared by
every Clip, Sequence, and fork of that Character. The Anchor is the first frame's
foot base, and the Canvas is horizontally symmetric about it so `flipX` stays aligned.

The Canvas is **fixed once established**. The alternative — letting each new Clip grow
the Canvas automatically — would silently invalidate every already-committed sheet,
contradicting the rule that committed Assets are immutable snapshots. Instead, when a
Clip does not fit, the tool offers an explicit **expand canvas** action that grows the
Canvas and **re-bakes every sheet of the Character** as one Character-level change. Old
sheets are overwritten: the store is working data, and the store's version control is
the revision history, so the tool does not keep Canvas revisions of its own.

## Consequences

- A variant can never have its own Canvas — variants differ only in pixels (and in
  their per-Clip `placementOffset`).
- Expanding is a deliberate, Character-wide operation, never a side effect of adding a
  Clip.
