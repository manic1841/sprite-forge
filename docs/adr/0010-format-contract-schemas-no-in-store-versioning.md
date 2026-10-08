# The format contract is normative prose plus JSON Schema, with no in-store versioning

The format contract for sprite-forge is frozen in two parts: a **normative
document** ([`docs/format-spec.md`](../format-spec.md)) and **JSON Schemas** under
[`schemas/`](../../schemas) at the repo root. The schemas are validated with draft
2020-12 and are **not vendored** into any store: a store is data, not a program,
and reading it needs no copy of the schemas.

Artifacts **inside** the store (`cuts.json`, `canvas.json`, `repair.json`,
`meta.json`, `provenance.json`) carry **no version field** and **no `$schema`
pointer**. The store is working data under its own version control, not a versioned
wire format, and it is discovered by scanning, not by an index
([ADR-0003](./0003-external-asset-store-discovered-by-scanning.md)). The tool
**validates on read** and treats a failed artifact as a hard error. A future
breaking change to a store format is handled by a **deliberate one-time migration**,
not by the tool sniffing versions it never recorded.

The **only** versioned artifact is the Export Manifest, which carries
`formatVersion` (semver). That single file is the consumer's contract; a major bump
is the only breaking change the consumer must track.

Rejected: a `schemaVersion` (and relative `$schema` pointer) on every store
artifact, as the earlier proposal had; vendoring the schemas into each store;
version-detection/back-compat code in the reader; and a separate versioned wire
format for the store. All of these are speculative for a single consumer — they buy
flexibility nothing has asked for, at the cost of a second thing to keep consistent
with the prose.

## Consequences

- One place defines the format: `format-spec.md`; one place encodes it: `schemas/`.
  They must be kept in step (a mismatch is a bug, not a fallback).
- Store formats evolve by migration; the consumer never sees anything but the
  Manifest, so producer-side churn is invisible to it.
- When — and only when — a second consumer appears, the versioning question
  reopens as a fresh effort (the map rules generic multi-consumer support *out of
  scope*).
