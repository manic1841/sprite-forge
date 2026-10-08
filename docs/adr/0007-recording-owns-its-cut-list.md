# A Recording owns its cut list; segments overlap freely

A Recording's Segments live in that Recording's own cut list
(`recordings/<recording-id>/cuts.json`), not scattered across the provenance of the
Clips that use them. Each Segment is a named, frame-accurate half-open range
(`[startFrame, endFrame)`) with an optional playback `speed`. A Clip's provenance
references the cut by id **and** snapshots the resolved range, so the committed Clip
stays self-contained and reproducible even if the cut is later re-cut.

Segments may overlap and may cover the same range. Overlap was considered a problem
because early files looked like duplicates, but the real cause was **identity
collision**, not overlapping ranges. Reusing frames across Segments is legitimate, so
the tool does not police overlap or duplication. The only enforced rule is identity:
cut ids are unique within a Recording, and Clip / Sequence ids within a Character.

Rejected: keeping Segments only inside Clip provenance (no single home for a shared
Recording; overlap work would mean scanning every Clip), and a store-level `cuts/`
directory (the cut belongs to the Recording, not the store).

## Consequences

- Re-cutting edits one file; new Clips adopt the new range while committed Clips keep
  their snapshot.
- There is no global registry of Segments.
