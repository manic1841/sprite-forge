# Export contract

The consumer reads one **Manifest** and nothing else. It never sees Recordings, the
Canvas file, Repair scripts, or provenance. This document is the contract; the
app-side implementation is a separate effort.

Vocabulary: [`GLOSSARY.md`](../GLOSSARY.md) — **Export**, **Manifest**, **Bindings**,
**Situation**, **Facing**.

```text
exports/<target>/
├─ manifest.json
└─ clips/<asset-id>.png    # one sheet per exported Asset
```

## manifest.json

```jsonc
{
  "formatVersion": "1.0.0",
  "target": "pixel-pet",
  "character": "kirby",
  "authoredFacing": "right",
  "canvas": { "width": 60, "height": 84, "anchor": { "x": 30, "y": 76 } },
  "animations": {
    "idle": { "sheet": "clips/idle.png", "frameCount": 34, "delaysMs": [50], "loop": true },
    "turn": { "sheet": "clips/turn.png", "frameCount": 14, "delaysMs": [50], "loop": false, "flipsFacing": true }
  },
  "bindings": { "idle": ["idle"], "happy": ["award"], "nod": ["sleep"], "alert": ["call-out"] },
  "lock": { "spriteForgeVersion": "0.1.0", "exportedAt": "2026-10-08T00:00:00Z" }
}
```

### Top level

| Field | Meaning |
| --- | --- |
| `formatVersion` | semver of this contract |
| `target` | the consumer this Export is for |
| `character` | the Character exported |
| `authoredFacing` | the direction the art was drawn in (`right`); see Facing |
| `canvas` | the **shared** frame size and its `anchor` (all animations use it) |
| `animations` | the exported Assets, keyed by id |
| `bindings` | Situation → one or more Asset ids |
| `lock` | provenance for the consumer: tool version and export time |

### Per animation

| Field | Meaning |
| --- | --- |
| `sheet` | path to the strip, relative to the manifest |
| `frameCount` | number of frames (frames are `canvas.width` × `canvas.height`) |
| `delaysMs` | per-frame duration; a single value means uniform |
| `loop` | whether this animation loops when shown |
| `flipsFacing` | optional; when true, the animation flips the consumer's Facing on completion |

`sheet` fully determines the layout: the sheet is a strip of `frameCount` frames of
`canvas.width × canvas.height`, laid out along the **x axis** (left to right). The
frame size is **never inferred from the image** — it is `canvas`.

## Facing

The art is drawn in **one** direction (`authoredFacing`, today always `right`). The
consumer holds a **Facing** (`right` / `left`); it draws a sheet mirrored whenever
Facing ≠ `authoredFacing`.

- The consumer mirrors **every** animation by Facing, including a turn animation.
- An animation marked `flipsFacing: true` flips the consumer's Facing **when it
  finishes** — so `turn` played while facing right ends facing left, and the next
  animation is mirrored.

There is no per-animation mirror flag and no baked left-facing art.

## Bindings

`bindings` maps each consumer **Situation** to a **list** of Asset ids:

- **On entering a Situation**, the consumer picks one id **at random** and plays it,
  honouring that animation's `loop` (loop forever if true, play once otherwise).
- It re-picks only on the **next** entry to that Situation — not on each loop.
- A single-element list is a fixed choice.

Bindings live only in the Export; app vocabulary never enters an Asset.

## Hitbox

Not part of the contract. The consumer decides what area is clickable; the tool does
not export a hitbox (the Canvas may include space reserved for effects).

## Closed export

Every Situation the consumer declares must have a binding, and every bound id must
exist in `animations` whose `sheet` must exist. `forge export` fails otherwise.

## Consumer-side requirements

Not implemented in this map; the contract requires that the consumer:

1. reads the Manifest instead of inferring frame size and count from the image, and
   stops assuming a fixed 48 px;
2. renders at `canvas` size and drives timing from `delaysMs` (no fixed frame delay);
3. owns **Facing**, mirrors by it, and flips it when a `flipsFacing` animation ends;
4. picks a random binding on entering a Situation;
5. keeps **frame 0 as the resting pose**, so a reduced-motion rule can settle on it.
