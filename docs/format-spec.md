# Format specification

> **Normative.** This document is the frozen format contract for
> `sprite-forge`. It defines every JSON artifact in the **Asset store** and the
> **Export Manifest**, and the rules that hold *across* artifacts. Where this
> document and a schema in [`schemas/`](../schemas) disagree, treat it as a bug
> and fix one — never guess.

The store artifacts are validated with **JSON Schema draft 2020-12**. The
schemas live at the repo root in [`schemas/`](../schemas) and are *not* vendored
into the store: a store is data, not a program, and needs no copy of the schemas
to be read.

Vocabulary for every term used here is in [`GLOSSARY.md`](../GLOSSARY.md).
Background: [`architecture.md`](./architecture.md), [`recordings.md`](./recordings.md),
[`repair.md`](./repair.md), [`alignment.md`](./alignment.md),
[`export-contract.md`](./export-contract.md).

## 0. Conventions

| Convention | Rule |
| --- | --- |
| **Id grammar** | `^[a-z][a-z0-9-]*$` — lowercase ASCII, kebab-case; no underscores, dots, or leading/trailing/double hyphens. |
| **Id scope** | `recording` and `character` ids are unique in the store; `character`/`clip`/`sequence` ids are unique within a Character; `cut` ids are unique within a Recording. |
| **Single asset namespace** | Within one Character, **Clip and Sequence ids share one namespace** — `clips/walk/` and `sequences/walk/` cannot both exist. |
| **Folder equals id** | A folder's name **must equal** the id it holds (`clips/walk/` ⇔ `"id": "walk"`). |
| **Time** | Always milliseconds, always suffixed `Ms`. Never seconds. |
| **Frames** | Frame indices and counts are integers. A *range* is half-open, `[start, end)`. |
| **Paths** | Always relative to the store root (manifest paths relative to the manifest), POSIX separators (`/`). No absolute paths, drive letters, or URLs. |
| **Colours** | `#rrggbb`, lowercase. |
| **Coordinates** | Origin top-left, `+y` down, pixels. |

**Rule 0.1 — no absolute or machine-specific paths.** No artifact may embed a
workspace root, home directory, or absolute path. Everything is relative and
reproducible.

**Rule 0.2 — no version field inside the store.** Store artifacts carry **no**
`schemaVersion` and **no** `$schema` pointer. The frozen contract is this
document plus the schemas; the store is working data under version control, not
a versioned wire format. The **only** versioned artifact is the Export Manifest
(`formatVersion`, see §9).

**Rule 0.3 — unknown fields are errors.** Every object is closed
(`additionalProperties: false`). An unrecognised key fails validation rather than
passing silently.

## 1. Store layout

```text
<store root>/
├─ recordings/<recording-id>/
│  ├─ source.gif                 # raw capture (read-only)
│  └─ cuts.json                  # §2  the Recording's cut list
├─ characters/<character-id>/
│  ├─ canvas.json                # §3  the shared Canvas / Anchor
│  ├─ repairs/<clip-id>/
│  │  └─ repair.json             # §4  the Clip's Repair script
│  ├─ clips/<clip-id>/
│  │  ├─ sheet.png               # baked strip, aligned to the Canvas
│  │  ├─ meta.json               # §5  Asset meta
│  │  └─ provenance.json         # §6  Clip provenance
│  └─ sequences/<sequence-id>/
│     ├─ sheet.png               # baked concatenation
│     ├─ meta.json               # §5  Asset meta (same shape as a Clip)
│     └─ provenance.json         # §7  Sequence provenance
└─ exports/<target>/
   ├─ manifest.json              # §9  the consumer contract
   └─ clips/<asset-id>.png       # one sheet per exported Asset
```

A committed Asset is a Clip or a Sequence. Beyond these, a store also holds
**Drafts** (uncommitted work) and the store root itself is discovered by
scanning, not by an index file — but neither drafts nor scanning are part of this
contract (see §10).

## 2. `cuts.json` — the Recording's cut list

Schema: [`schemas/cuts.schema.json`](../schemas/cuts.schema.json).

```jsonc
{
  "hash": "sha256:…",   // content hash of source.gif
  "frameCount": 523,     // frame count of source.gif
  "cuts": [
    { "id": "walk", "startFrame": 293, "endFrame": 327, "speed": 1 }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `hash` | ✅ | `sha256:` + 64 lowercase hex; detects a swapped source. |
| `frameCount` | ✅ | Frame count; detects a truncated/replaced file. |
| `cuts[].id` | ✅ | The Segment's name (cut id); unique within the Recording. |
| `cuts[].startFrame` | ✅ | Inclusive start. |
| `cuts[].endFrame` | ✅ | Exclusive end. Must be `> startFrame`. |
| `cuts[].speed` | ➖ | Playback multiplier; omitted when `1`. Does **not** change the range. |

**Rule 2.1 — overlap is allowed.** Cuts may overlap or repeat ranges; only
**identity** (unique cut ids) is enforced. Listed in frame order for readability
only.

**Rule 2.2 — per-frame delays are not stored.** They are read from `source.gif`
metadata when a Clip is generated. `cuts.json` records only what the source
cannot: the assigned `recording-id`, its hash, and the cuts.

## 3. `canvas.json` — the shared Canvas and Anchor

Schema: [`schemas/canvas.schema.json`](../schemas/canvas.schema.json).

```jsonc
{ "width": 60, "height": 84, "anchor": { "x": 30, "y": 84 } }
```

The Canvas and Anchor belong to the **Character**: every Asset of that Character
is drawn on this Canvas, so a consumer can swap sheets without the subject
jumping.

**Rule 3.1 — the Anchor invariant.** `anchor.x == width / 2` and
`anchor.y == height`. (The Anchor is the first frame's content-box bottom-centre —
the foot base — and the Canvas is symmetric about it.) JSON Schema cannot express
this; `validate` enforces it.

**Rule 3.2 — a Clip never carries its own frame size.** Frame size is **always**
`canvas.width × canvas.height`. It is never stored per Asset and never inferred
from a sheet's pixels.

## 4. `repair.json` — the Repair script

Schema: [`schemas/repair.schema.json`](../schemas/repair.schema.json).

```jsonc
{
  "operations": [
    { "tool": "erase-rect",  "frames": { "start": 0, "end": 24 },
      "geometry": { "x": 1, "y": 2, "width": 8, "height": 6 } },
    { "tool": "paint-brush", "frames": { "start": 5, "end": 6 },
      "geometry": { "points": [[3, 4], [5, 7]], "size": 2 },
      "color": "#f7a8c4" }
  ]
}
```

An ordered list of Repair operations; re-running replays them in order, so a
repaired Clip is reproducible from its inputs. The script is also the undo stack:
undo removes the last operation.

| Field | Required | Meaning |
| --- | --- | --- |
| `tool` | ✅ | One of `erase-rect`, `erase-brush`, `paint-brush`. |
| `frames` | ✅ | Half-open `{start, end}`; one frame (`end == start + 1`) or a span. |
| `geometry` | ✅ | Depends on `tool`: a **rect** for `erase-rect`, a **stroke** for the brushes. |
| `color` | ✳️ | `#rrggbb`; **required** for `paint-brush`, **forbidden** for the erase tools. |

`geometry` shapes:

- **rect** (`erase-rect`): `{ "x", "y", "width", "height" }` — position and size
  in pixels.
- **stroke** (`erase-brush`, `paint-brush`): `{ "points": [[x, y], …], "size" }`
  — a polyline of pixel coordinates at a brush size.

**Rule 4.1 — erase-rect is the same kind of operation as a brush.** It shares the
frame-range targeting, the undo stack, and the replay; it is a bulk-clear fast
path, not a separate mechanism.

**Rule 4.2 — alpha is binary.** Erasing writes alpha `0`; painting writes alpha
`255` with the given colour. Pixel art has no partial alpha, so a sampled colour
is painted opaque.

**Rule 4.3 — geometry is coordinate-valid only for the frames and Canvas it was
made for.** Changing a Clip's Segment or re-aligning the Canvas can invalidate a
Repair script; the tool must **warn**, never silently misapply.

## 5. `meta.json` — Asset meta (Clip or Sequence)

Schema: [`schemas/asset.meta.schema.json`](../schemas/asset.meta.schema.json).

```jsonc
{ "id": "walk", "frameCount": 24, "delaysMs": [50], "loop": true }
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | ✅ | The Asset id; must equal the folder name. |
| `frameCount` | ✅ | Number of frames. |
| `delaysMs` | ✅ | Per-frame duration; **one** value (uniform) or exactly `frameCount` values. |
| `loop` | ✅ | Whether the Asset loops. |

A Clip and a Sequence use the **same** meta shape. Neither stores frame size
(§3 Rule 3.2) or Anchor.

**Rule 5.1 — `delaysMs` length.** It is either `1` (uniform, expanded to
`frameCount`) or exactly `frameCount`. Anything else is invalid; `validate`
enforces it.

## 6. `provenance.json` — Clip

Schema: [`schemas/clip.provenance.schema.json`](../schemas/clip.provenance.schema.json).

```jsonc
{
  "recordingId": "mgba-2026-09",
  "recordingHash": "sha256:…",
  "segment": { "cutId": "walk", "startFrame": 293, "endFrame": 327, "speed": 1 },
  "background": { "hex": "#9421ce", "source": "sampled", "tolerance": 24 },
  "repair": "repairs/walk/repair.json",
  "placementOffset": { "x": 0, "y": -2 },
  "derivedFrom": null,
  "spriteForgeVersion": "0.1.0"
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `recordingId` | ✅ | The source Recording (assigned at ingest). |
| `recordingHash` | ✅ | `sha256:` + 64 hex. |
| `segment` | ✅ | A **snapshot** of the resolved cut; later re-cutting does not change it. |
| `background` | ✅ | `{hex, source: "sampled"\|"override", tolerance}`. |
| `repair` | ➖ | Path to the Repair script, relative to the store root. Omitted or `null` when there is no Repair. |
| `placementOffset` | ➖ | Manual placement on top of the automatic Anchor; **omitted when `{0,0}`**. |
| `derivedFrom` | ➖ | `{kind, id}` of the forked-from Asset, or `null`. |
| `spriteForgeVersion` | ✅ | Tool version that produced the Asset. |

**Rule 6.1 — provenance is a snapshot, not a pointer.** `segment` records the
range *as it was when the Clip was cut*, so the Clip still reproduces after the
cut is edited.

**Rule 6.2 — provenance carries no `kind`.** Whether it is a Clip or a Sequence
is determined by its directory; the file does not repeat it.

## 7. `provenance.json` — Sequence

Schema: [`schemas/sequence.provenance.schema.json`](../schemas/sequence.provenance.schema.json).

```jsonc
{ "clips": ["walk", "jump", "call-land"], "derivedFrom": null, "spriteForgeVersion": "0.1.0" }
```

| Field | Required | Meaning |
| --- | --- | --- |
| `clips` | ✅ | The **ordered** source Clip ids, concatenated end to end. |
| `derivedFrom` | ➖ | `{kind, id}` or `null`. |
| `spriteForgeVersion` | ✅ | Tool version. |

**Rule 7.1 — a Sequence is pure concatenation.** Clips play back to back in the
order listed. There is no per-clip offset (`at`) and no repeat count; a Sequence
that needs a clip twice lists it twice. (This is the "ordered concatenation" of
§GLOSSARY *Sequence*.)

**Rule 7.2 — no separate recipe file.** Like a Clip, a Sequence keeps its recipe
in provenance and its baked result in `sheet.png`. Because Clips are immutable,
the concatenation is deterministic and reproducible. `sheet.png` and `meta.json`
may be regenerated from provenance at any time.

## 8. Asset references

`derivedFrom` is `null` or an **Asset reference**:

```jsonc
{ "kind": "clip" | "sequence", "id": "walk" }
```

The `kind` is required because a Clip and a Sequence share one id namespace, so
an id alone would be ambiguous.

## 9. `manifest.json` — the Export Manifest

Schema: [`schemas/export.manifest.schema.json`](../schemas/export.manifest.schema.json).
Full field semantics: [`export-contract.md`](./export-contract.md). This section
fixes only the parts that touch the contract as a whole.

The Manifest is the **one** artifact the consumer reads. It is canvas-level: the
shared `canvas` and `anchor` appear once, and each animation carries only
`{sheet, frameCount, delaysMs, loop, flipsFacing?}`. Frame size is the `canvas`
(§3 Rule 3.2). There is no hitbox and no per-animation mirror flag; direction is
the consumer's **Facing** (§GLOSSARY), and a `flipsFacing` animation flips it on
completion.

**Rule 9.1 — `formatVersion` is semver and is the consumer's contract.** A
**major** bump is breaking for the consumer; minor/patch are compatible. This is
the only versioned artifact in the contract (§0 Rule 0.2).

**Rule 9.2 — bindings keys are consumer vocabulary.** `bindings` maps a
Situation to one or more animation ids. Situation ids follow the id grammar but
are *not* store ids; store vocabulary never appears in bindings, and consumer
vocabulary never appears in the asset layer.

### Cross-artifact rules of a closed Export

JSON Schema validates one file at a time; these hold **across** files and are
enforced by `validate`:

- **MUST** — every `animations` key resolves to an exported `clips/<id>.png`.
- **MUST** — every id in every `bindings` value exists in `animations`.
- **MUST** — every Situation the consumer knows is bound: a *closed* Export has a
  binding for each declared Situation (no Situation may be missing).
- **MUST** — `canvas` in the manifest equals the Character's `canvas.json`.
- **MUST** — a `flipsFacing` animation exists only where a turn is intended;
  this is a design check, not a structural one.

## 10. Validation and versioning

- **Validate on read.** The tool validates every store artifact against its
  schema when loading, and the Manifest when exporting. A store that fails
  validation is a hard error, never a warning-and-continue.
- **No internal version detection.** Because store artifacts carry no version
  (§0 Rule 0.2), a future breaking change to a store format is handled by a
  **one-time migration** invoked deliberately, not by the tool sniffing versions
  it does not record. Until a second consumer exists, no versioning machinery is
  built (map *Out of scope*).
- **The Manifest is the sole external contract.** Producers may rewrite the
  store freely; consumers depend only on `manifest.json` and its
  `formatVersion`.

## 11. Not part of this contract

- **Drafts.** Uncommitted working state under `characters/<id>/drafts/` is an
  implementation detail, not a frozen format. Emitting, resuming and committing
  drafts are the tool's business.
- **The commit / promote workflow and the store's directory scan.** Both are
  architecture ([ADR-0003](./adr/0003-external-asset-store-discovered-by-scanning.md),
  [ADR-0004](./adr/0004-baked-assets-with-provenance-sidecars.md)), not format.
- **Consumer-side rendering.** The player that reads the Manifest, its tick loop,
  and its own Facing state are the consumer's, not this contract's.
