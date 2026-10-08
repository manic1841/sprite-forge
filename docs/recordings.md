# Recordings and segmentation

Segmentation is the tool's front door: opening a Recording, marking the Segments, and
leaving provenance that makes every later step reproducible.

Vocabulary: [`GLOSSARY.md`](../GLOSSARY.md) — **Recording**, **Segment**.

## Opening a Recording

A Recording lives at `recordings/<recording-id>/` with its raw file and its cut list:

```text
recordings/<recording-id>/
├─ source.gif     # the raw capture (read-only)
└─ cuts.json      # the Recording's Segments
```

The tool reads frame count and per-frame delays from the file's metadata. Because
`sharp` metadata carries **no filename**, the `recording-id` is assigned by the caller
on ingest and recorded — it is never recovered from the file. The Recording's content
**hash** is recorded too, so a swapped source is detected.

## Cutting

The UI is a frame-accurate scrubber over the Recording:

- **frame is the unit** — scrubbing and prev/next-frame snapping move by frame index;
  time (ms) is shown as an aid, but a Segment is defined in frames.
- a Segment is the half-open range `[startFrame, endFrame)`.
- each Segment gets a **name (cut id)** when it is cut; names are unique within the
  Recording.

```jsonc
// recordings/<recording-id>/cuts.json
{
  "cuts": [
    { "id": "walk", "startFrame": 293, "endFrame": 327, "speed": 1 },
    { "id": "jump", "startFrame": 580, "endFrame": 607, "speed": 1 }
  ]
}
```

`speed` is a playback multiplier applied when a Clip is generated; it does **not**
change the Segment's frame range.

## Overlap is not policed

Cuts may overlap or even cover the same range: each cut is an independent selection,
and reusing a stretch of frames is legitimate (e.g. a `jump` and a shorter
`jump-takeoff` that shares its opening frames). The tool does **not** check for
overlap or duplication.

The only enforced rule is **identity**: cut ids are unique within a Recording, and
Clip / Sequence ids are unique within a Character. (The legacy trouble — files that
looked like duplicates — came from identity collisions, not from overlapping ranges.)

Segments are listed in frame order for readability; this is presentation, not a check.

## Recording and re-cutting

Editing `cuts.json` changes what future Clips can be generated from; it does not
disturb Clips already committed. A committed Clip is **self-contained**: its
provenance records both the `cutId` it came from and a **snapshot** of the resolved
range, so it still reproduces even if the cut is later re-cut. To adopt a changed
range, cut and generate a new Clip.

## Provenance

A Clip's provenance records:

```jsonc
{
  "recordingId": "mgba-2026-09",   // assigned at ingest
  "recordingHash": "sha256:…",     // detects a swapped source
  "segment": { "cutId": "walk", "startFrame": 293, "endFrame": 327, "speed": 1 },
  "background": { "hex": "#9421ce", "source": "sampled", "tolerance": 24 },
  "repair": "repairs/<clip-id>/repair.json",
  "placementOffset": { "x": 0, "y": 0 },
  "derivedFrom": null,
  "spriteForgeVersion": "0.1.0"
}
```

The decode mode (whole-file vs page-by-page) is not recorded: it is a deterministic
implementation detail. What can change a result — the source and the tool version — is
recorded instead.
