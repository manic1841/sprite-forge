# Deep region sessions, narrow ports, and a layered stylesheet

The workbench had one module per region but shared a single wide
`WorkbenchContext` (whole state, whole API, every render verb). Rules that
belonged to one idea were split across regions — the filmstrip owned marking,
`stageCut` owned saving and extracting, and the two imported each other — while
the inspector imported every face to re-mount their editors.

A split by file therefore did not hide anything. We refactor by **depth**: a
module owns an invariant and the state slice it writes, and exposes a small verb
set.

## Decision

- **`cutSession`** owns a Recording's playhead, mark, selection, playback and
  Extract. The filmstrip and the cut face build DOM and call its verbs.
- **`draftEditor`** owns a Draft's frame, zoom, brush settings, Repair gestures,
  log, Commit and Discard. The clip stage and the Draft inspector mount parts of
  it.
- **`state.ts`** is composed of named slices (`ShellState`, `CutState`,
  `DraftState`, `AlignState`, `AssetState`, `ExportState`), each with one owning
  writer; `WorkbenchState` is their intersection.
- **`ports.ts`** gives each view a narrow capability (`LibraryPort`,
  `FilmstripPort`, `CutStagePort`, …) carrying only the session its region
  drives. Views no longer import each other; the two multi-part regions
  (`library`, `inspector`) are routers over their own part modules, and
  `context.ts` is the composed shape the shell itself builds.
- **The inspector is a router** over one section module per target. A section
  never reaches into another face.
- **The app sheet is split** by layer and region under `site/styles/`, in
  cascade order, with `.wb-shell` kept as the scoping prefix. The dead
  `src/web/client/{main.ts,index.html,style.css}` entry is removed.

## Consequences

- Range and Repair invariants have one owner, so a rule cannot be half-applied
  by a sibling. The former `filmstrip ↔ stageCut` import cycle is gone.
- A view's dependencies are visible in its parameter type; adding a capability
  is a deliberate edit to `ports.ts`, not another reach into `ctx.state`.
- `cutSession`/`draftEditor` are testable without mounting the whole shell, and
  the existing black-box workbench tests keep passing unchanged.
- Adding a region now means a port entry, a module, and one CSS file in the
  ordered list — the list is the cascade contract, so it must not be reordered.
