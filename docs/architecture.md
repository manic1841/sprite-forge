# Architecture

sprite-forge is one program with **one core and two front ends** (a web UI and a CLI)
operating on an **external asset store**. It turns emulator screen recordings into
pixel-animation assets and owns the format contract the consumer reads.

This document describes the **stage-level** architecture and the on-disk model.
Function boundaries *inside* the pipeline are deliberately deferred to implementation:
the stages below are the design contract, not a module map.

## Pipeline

```text
Recording ─▶ (extract Segment) ─▶ Clip ─▶ (concatenate) ─▶ Sequence ─▶ commit ─▶ Asset ─▶ Export
                    de-background · crop · align · repair
```

| # | Stage | What it does |
| --- | --- | --- |
| 1 | **Ingest** | Read a Recording; take frame count and per-frame delays from its metadata; capture the source path (the decode loses it). |
| 2 | **Extract** | Select a Segment — a half-open frame range — by hand, frame-accurately. |
| 3 | **De-background** | Colour-key the corner-sampled background colour to RGBA. |
| 4 | **Crop + align** | Crop to the union bounds, then place the frames on the Character's shared Canvas via the Anchor. |
| 5 | **Repair** | Replay the Clip's Repair script (brush/eyedropper edits). |
| 6 | **Compose** | Concatenate Clips into a Sequence. |
| 7 | **Commit** | Promote a Draft into an immutable, named Asset. |
| 8 | **Export** | Gather an Asset subset for a `(Character, target)` into a Manifest plus sheets. |

Stages 1–6 are deterministic given their inputs, so results are reproducible. Repair
(stage 5) is the exception: it carries human edits, which is why its output is stored
rather than recomputed (see below).

## Asset store

The store is an **external data root** the tool points at; it is not part of the tool
repo. It has no catalog or index file — the tree *is* the truth, discovered by
scanning. See [ADR-0003](./adr/0003-external-asset-store-discovered-by-scanning.md).

```text
<store root>/
├─ recordings/<recording-id>/   # raw inputs (read-only): source.gif + cuts.json
├─ characters/
│  └─ <character-id>/
│     ├─ canvas.json            # the shared Canvas / Anchor
│     ├─ drafts/<draft-id>/     # editable, not-yet-committed work
│     ├─ repairs/<clip-id>/     # Repair scripts (input, not asset content)
│     ├─ clips/<clip-id>/       # committed Clip assets
│     └─ sequences/<seq-id>/    # committed Sequence assets
└─ exports/<target>/            # manifest.json + clips/<asset-id>.png (see docs/export-contract.md)
```

A committed Asset folder holds the **contract artifacts** plus its **provenance**:

```text
clips/<clip-id>/
├─ sheet.png        # baked strip, already aligned to the Character's Canvas
├─ meta.json        # frameWidth, frameHeight, frameCount, delaysMs, loop, anchor
└─ provenance.json  # recordingId+hash, segment{cutId,start,end,speed}, background, repair ref, placementOffset, derivedFrom?, toolVersion
```

`sheet.png` + `meta.json` are what the consumer ultimately sees (via the Manifest).
`provenance.json` makes the Asset reproducible and traceable.

## Draft, commit, fork

- A **Draft** lives on disk under `characters/<id>/drafts/<draft-id>/`, so it survives
  a reload and both front ends can resume it.
- **Commit** bakes the Draft into `clips/<id>/` (or `sequences/<id>/`), writes its
  provenance, requires a name, and removes the Draft. The Asset is then immutable.
- **Fork** opens an existing Asset as a new Draft. On commit, the new Asset's
  provenance records `derivedFrom` pointing at the Asset it came from. The original is
  kept. See [ADR-0002](./adr/0002-immutable-assets-fork-to-edit.md).

## Repair script

- There is **one Repair script per editable Clip state** — the ordered accumulation
  of that Clip's Repair operations. Forking copies the parent's script so the new
  branch starts from it.
- A Repair script is a list of operations (`erase-rect`, `erase-brush`, `paint-brush`),
  each tied to a frame range, so the same edit can target one frame or a whole span;
  re-running replays them. Rectangular erase is one operation kind, not a separate
  mechanism. It lives under `characters/<id>/repairs/<clip-id>/repair.json` as an
  **input sidecar**, not part of a committed Asset; the Asset's provenance points at it.
- ⚠️ **Validity.** Repair operations are pixel-coordinate-valid only for the *same
  frames and the same Canvas alignment*. Changing a Clip's Segment or re-aligning the
  Canvas can invalidate an existing Repair script; the tool must warn rather than
  silently misapply it. (Alignment itself is settled in ticket #6.)

## Reproducibility

A committed Asset is a **baked snapshot**: the stored `sheet.png` is authoritative,
and re-running does not replace it. Reproducibility is carried by the provenance
sidecar (Recording + Segment + settings + Repair-script reference), so any run can be
re-executed and traced — but because Repair is human, the edited result must be
stored, not regenerated. See
[ADR-0004](./adr/0004-baked-assets-with-provenance-sidecars.md).

## Web tool surface

The web UI is the primary working surface, and its shape is a **docked
workbench**, not a wizard: one persistent shell, with a single region swapping per
task so the working context is never lost.

- **Rail (left, persistent)** — the Library: Recordings and committed Assets,
  always present; click one to load it.
- **Stage (centre)** — the active view, chosen by a **mode** switch: *Clip editor*
  (the frame, segmentation scrub, and the Repair brush), *Alignment* (Clips ghosted
  on the shared Canvas against the Anchor), or *Export* (Situation bindings and the
  resulting Manifest).
- **Inspector (right, contextual)** — whatever the active mode needs: brush colour /
  size and the Repair operations in the editor; per-Clip placement offsets in
  alignment; the live `manifest.json` in export.
- **Filmstrip (bottom, docked)** — the current Segment frame-by-frame, plus the
  Recording's timeline with its draggable cut ranges.

Switching modes swaps only the stage; the rail, inspector and filmstrip stay put.

This shape was chosen against two alternatives prototyped at equal fidelity — a
**linear stepper** (one task per screen, heavy Next/Back) and a **timeline-first**
layout (the Recording timeline as the hero). The full three-variant prototype,
including the losing variants, is kept as a primary source on the throwaway branch
`prototype/web-tool-surface` (`prototype/web-tool-surface/index.html`).

## Core and front ends

- **core** — pure functions (decode, de-background, crop, align, Repair application,
  sequence baking, validation, schema) plus a **store** module that is the single
  filesystem boundary.
- **front ends** — a CLI and a web adapter (dev-only, not shipped in a production
  build), each a thin shell over the core.
- **dependency direction** — front ends depend on core; core never imports UI or HTTP
  types. Details of enforcement are an implementation concern; this is the direction
  the architecture fixes.
