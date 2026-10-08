# sprite-forge — shared context

Orientation for anyone (human or agent) working in this repo: what it is, the shape
already settled, and where the vocabulary and decisions live.

## What it is

sprite-forge is the **producer** in a three-role split: this repo owns the tool and
the format contract; **material libraries are data** that live elsewhere; the
**consumer** (today `one-piece`'s Pixel Pet) depends only on an export.

It turns emulator (mGBA) screen recordings into reusable pixel-animation assets,
worked web-first and re-runnable from disk.

## The model in one line

`Recording → Segment → Clip → Sequence → Asset → Export`, with a `Character` owning
the shared `Canvas` / `Anchor`, and `Draft → commit → Asset` (edit by `fork`).

## Settled shape

- Tailored to Pixel Pet, **not** a generic multi-consumer tool (revisit only when a
  second consumer appears).
- TypeScript on Node with `sharp`.
- Web UI is the primary working surface; a CLI re-runs from the on-disk store; the
  store is the single source of truth, and UI and CLI share one core.
- Sequences only (no layers); the tool bakes action chaining; the consumer holds no
  transition graph — it reads an Export `Manifest` and its `Bindings`.
- Action segmentation is manual and frame-accurate.
- Transparency comes from colour-keying a corner-sampled background, not the GIF
  transparent index.

## Where things live

- **Vocabulary:** [`GLOSSARY.md`](./GLOSSARY.md)
- **Format contract (frozen):** [`docs/format-spec.md`](./docs/format-spec.md) +
  [`schemas/`](./schemas)
- **Decisions:** [`docs/adr/`](./docs/adr/)
- **Open design work:** the wayfinder map, issue #1.
