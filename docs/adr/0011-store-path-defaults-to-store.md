# The store path defaults to `store/` under the working directory

The tool resolves its store root in this order: an explicit `--store` flag, then the
`SPRITE_FORGE_STORE` environment variable, then the default `store/` relative to the
**current working directory** (not the repo root). The resolved absolute path is
printed at startup and shown in the web UI, and an absent default store is created
empty on first use.

This is a **startup convenience**, not a move of the store into the tool repo. The
store is still an external data root discovered by scanning
([ADR-0003](./0003-external-asset-store-discovered-by-scanning.md)): pointing at a
different store stays a normal, first-class operation. The default exists because the
web UI has no argument list, so without it every session would begin with setup.

`store/` is ignored by the tool repo's version control. The store keeps its own
version control where it lives; check the default in only if you deliberately want
the data inside the tool repo.

## Considered Options

- **No default (store path required)** — rejected: every web-UI session needs a
  configuration step before anything can be opened.
- **Default inside the repo root regardless of cwd** — rejected: the CLI would behave
  differently depending on where it was launched.
- **Resolve the default relative to the tool installation** — rejected: an installed
  CLI would write data next to its own code.

## Consequences

- An unconfigured first run puts data inside the tool repo. Moving to a shared store
  later means moving the directory once.
- The resolved path must stay visible in both front ends so the default never becomes
  a hidden implicit choice.
- The dev container no longer needs to preset `SPRITE_FORGE_STORE`; the in-repo
  `store/` is on the bind mount and survives container rebuilds.
