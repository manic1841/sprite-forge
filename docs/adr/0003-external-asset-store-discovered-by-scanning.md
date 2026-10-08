# The asset store is an external data root with no catalog

The tool operates on an asset store that lives **outside** the tool repo, at a path
the tool is pointed at. The store's contents are **discovered by scanning the
directory tree**; there is no central catalog or index file.

This keeps the tree as the single source of truth: a catalog would be a second
source that drifts from the files it describes. It also keeps the tool separate from
its data — one tool can point at any store.

## Considered Options

- **Store inside the tool repo** — rejected: mixes data with code and forces the tool
  to be about one store.
- **An explicit catalog file** — rejected: a second source of truth to keep in sync,
  for a scale that does not need it.

## Consequences

- Opening the store costs a directory scan; acceptable at this scale.
- There is no single file listing every Asset.
