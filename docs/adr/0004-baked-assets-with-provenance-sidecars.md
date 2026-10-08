# Assets are baked snapshots; reproducibility lives in provenance sidecars

A committed Asset stores its **baked** result — `sheet.png` + `meta.json` — and is
authoritative. *How* it was made (its Recording, Segment, processing settings, and
Mask) is recorded in a **provenance** sidecar beside it, and the Mask is kept as an
input sidecar in the store.

The alternative — storing only a recipe and regenerating the sheet on demand — was
rejected because Repair is a human edit (brush strokes and eyedropper patches) that
cannot be expressed as a recipe. The edited pixels must be stored. Keeping provenance
anyway makes each Asset reproducible and traceable (and gives `fork` a lineage to
record), while the stored sheet remains the thing that is actually delivered.

## Consequences

- The store carries both inputs (recordings, Masks) and outputs (sheets).
- Re-running reproduces the pipeline but does not overwrite a committed Asset.
