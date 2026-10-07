# Tailored vocabulary, not a generic Library/Composition/Machine

sprite-forge has a single consumer and a single character today. Rather than build a
generic, multi-consumer contract up front — a top-level `library.json`,
`clip` + `composition` + `machine` (states/transitions), multi-target exports, schema
versioning, and vendored schemas — we adopt a vocabulary shaped to the tool's actual
work: a `Recording` yields a `Segment`, which becomes a `Clip`; Clips concatenate into
a `Sequence`; both are `Asset`s in an `Asset store`; a `Character` owns the shared
`Canvas`/`Anchor`; an `Export` + `Manifest` + `Bindings` delivers to the consumer.

The generic apparatus is unverified speculation at this scale and would ossify before
a second consumer exists. Rejected words: `composition` (too broad — we only
concatenate), `machine` (the consumer holds no transition graph), `library` (kept
only as "material library" for the data role, never for the tool's own model).

**Revisit only when a second consumer appears.**

## Considered Options

- **A generic multi-consumer contract** — rejected: untested, and its machinery would
  ossify before a second consumer exists.
- **No umbrella noun** (clips and sequences only) — rejected: the editing operations
  (Draft, commit, fork, Export) need a common noun to attach to.

## Consequences

- Generalization (multi-target export, schema versioning) stays out of scope until a
  second consumer exists.
