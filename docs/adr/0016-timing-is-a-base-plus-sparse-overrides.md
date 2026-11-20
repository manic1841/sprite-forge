# Timing is a base duration plus sparse overrides

A per-frame `delaysMs` array was the artifact's only way to say how long a frame
lasts, and it was the wrong shape for what the pipeline actually produces. An mGBA
capture is not a constant frame rate: the sampled source runs 511 frames at 50 ms
and 12 at 60 ms, the 60 ms ones landing roughly every 44 frames where the emulator
dropped a frame. Copying that array verbatim (which `docs/research/mgba-gif-ingestion.md`
recommends, and which the tool did) put 138 numbers on disk for a 138-frame Clip to
describe two distinct values, made every timing edit an O(frameCount) rewrite, and
handed the consumer an array to expand before it could schedule anything.

Timing is now **one base duration plus the frames that deviate**:

```jsonc
{ "frameMs": 50, "overrideMs": { "21": 60, "65": 60 } }
```

A frame lasts `overrideMs[i] ?? frameMs`. `overrideMs` is omitted when every frame is
uniform, and a sparse map keyed by decimal frame index (not a `null`-padded array)
means the cost is the number of exceptions, not the frame count. Uniform timing is
therefore literally one number.

The contract stays in **milliseconds** (format-spec §0). A `fps` field was the
obvious rival and is rejected: it introduces a second time unit into a spec that is
deliberately single-unit, and `1000 / 17` rounds just as badly as the delay it would
replace — the quantisation only moves from the source to the author. Frames per
second is offered where it belongs, as a **readout** beside the millisecond input.

Collapsing is a **policy**, not a shape, so the tool has both: `extract` normalises
to the capture's modal delay unless `--keep-timing` is passed, and the Draft panel
can pin one rate (recording `uniformDelayMs`) or restore the source's cadence. What
reaches an artifact is therefore usually one value, while the hiccups remain
reproducible through the Recording.

A Sequence derives its timing rather than authoring it: the concatenated durations
collapse to their mode, ties going to the smallest (Rule 7.2). Two Clips at different
rates join honestly, and nothing is resampled to a common rate.

## Consequences

- `delaysMs` is **removed**, not deprecated. Rule 0.3 closes every object, so keeping
  both would need a "these must agree" rule to earn its keep (ADR-0010).
- The Manifest goes `1.0.0` → `2.0.0`. This is the one change in the contract that
  reaches the consumer, and a consumer still reading `delaysMs` sees `undefined`
  rather than an error — the only uncontrolled seam in the change.
- Store artifacts carry no version (ADR-0010), so the break is crossed by
  `forge migrate`, which is idempotent, has `--dry-run`, and rewrites nothing until
  every planned rewrite has been computed. Drafts are not a frozen format (§11) and
  keep their array; only the artifact boundary converts.
- `validate` rejects an override at or past `frameCount` and an empty override map, so
  the two remaining length-style mistakes are caught by a path pointing at the frame.
- Reproducibility compares the derived timing. A flat stored timing is compared to the
  Recording's mode, because *which* delays were blended away is the extract's chosen
  policy, not something provenance can re-derive.
