# sprite-forge

Turns emulator screen recordings into pixel-animation assets. One core, two thin
front ends (a web workbench and a CLI) over an external Asset store. See
[`CONTEXT.md`](./CONTEXT.md), [`GLOSSARY.md`](./GLOSSARY.md) and
[`docs/architecture.md`](./docs/architecture.md).

## Develop

```sh
pnpm install
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest
```

## Web workbench (dev-only)

The web UI is a docked workbench: a persistent rail (Library), stage, contextual
inspector and docked filmstrip. A mode switch swaps **only** the stage. It is a
thin adapter — the browser never touches `node:fs`; it talks to a Node-side
`/api` server that delegates to the core command surface, so the store stays the
single source of truth.

Run it against a store (the flag is the `SPRITE_FORGE_STORE` environment
variable; the default Vite port is **5173**):

```sh
SPRITE_FORGE_STORE=/path/to/store pnpm web
# then open http://localhost:5173/
```

This is a dev server (`vite`); it is not a production build and ships nothing.
The browser app lives in `src/web/client/`; the core-backed API middleware lives
in `src/web/server.ts` and is mounted by `vite.config.ts`.
