# Committed Assets are immutable; editing forks

An Asset is a named, on-disk, re-openable unit — but a *committed* Asset is a
snapshot: editing never mutates it in place. Opening an Asset for editing produces a
`Draft`; committing that Draft creates a **new** Asset, which records the Asset it was
forked from (its lineage). The original is always kept.

It was chosen over a mutable store (where "commit" just saves and marks) because the
tool's whole point is re-editing produced assets into new ones — a re-cut landing, a
tweaked walk. In-place mutation would silently rewrite art that earlier exports or
variants already depend on.

## Consequences

- "Derive a variant" means fork + commit; there is no edit-in-place path.
- The Asset store grows by lineage and never overwrites, so it can be discovered by
  scanning rather than by an index.
