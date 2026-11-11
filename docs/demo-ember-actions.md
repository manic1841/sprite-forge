# Demo — `ember-actions` (a three-action clip made through the workbench)

This is a **record of a run**, not a design doc. Its purpose was to prove the
workbench's own tools can ship a real asset end to end: ingest, Segment, Draft,
Align, Repair, Commit, Export, Verify. Nothing was produced outside the tool's
surface; the two scripts under `tools/` only supply the *input* capture and
re-package the *output* Export.

Deliverable: [`assets/ember-actions.gif`](../assets/ember-actions.gif) — one loop
of idle → walk → jump, 252×360 display size, 18 frames.

## Conclusion

The tool surface holds up. Every stage that matters ran through the UI and every
check the store offers passes:

- All three committed Clips **re-bake byte-identically** (`Verify reproducible`).
- `forge validate --store ./store` → `OK: validated 17 artifact(s)`.
- The Export is closed: 3 animations, 3 declared Situations, every binding
  resolves, canvas 42×60 matches the Character.
- Repair is recorded as a two-operation script and is replayed on read, not baked
  by hand.
- Alignment offsets survive the commit and are carried in provenance.

The gaps below are real but narrow; none of them needed a workaround to finish.

## What was built

| Artifact | Where |
| --- | --- |
| Source capture (synthetic emulator recording) | `tools/emit-recording.mjs` → `store/recordings/ember-actions/source.gif`; copy at `site/media/ember-actions.gif` |
| Three Segments `idle [0,4)`, `walk [4,10)`, `jump [10,18)` | `store/recordings/ember-actions/cuts.json` |
| Character `ember`, Canvas 42×60, Anchor (21, 60) | `store/characters/ember/canvas.json` |
| Clips `idle`, `walk`, `jump` + provenance | `store/characters/ember/clips/` |
| Repair script for the walk NPC (2× `erase-rect`, frames [0,6)) | `store/characters/ember/repairs/walk/repair.json` |
| Export `pixel-pet` (manifest + sheets) | `store/exports/pixel-pet/` |

## How the capture was designed

The recording was authored *for the pipeline*, so each stage has something real
to bite on:

- 64×64 with a single flat backdrop (`#9421ce`) — corner sampling keys cleanly and
  alpha stays binary.
- One subject, one fixed foot baseline, one ground shadow in every frame — the
  derived Anchor is identical across all three Segments.
- Three contiguous, non-overlapping ranges with distinct silhouettes (breathe,
  stride, airborne).
- Frame 0 is the resting pose.
- A magenta NPC square sits in the walk range only. It survives keying, so it
  must be repaired away before commit.
- Delays 140/100/110 ms, all multiples of 10 so the GIF round-trip is exact.

## Steps actually taken

1. **Ingest** `ember-actions` (18 frames; delays read from the source).
2. **Segment** — dragged `idle`, `walk`, `jump` on the filmstrip, named each.
3. **Character** — created `ember` framed from the jump Segment, then *Fit to
   content* (24×57) and resized to 42×60 for headroom.
4. **Draft** — extracted all three Segments.
5. **Align** — checked the three ghosts on the shared Canvas; set walk's
   `placementOffset` to `-3, 0` against the NPC's pull.
6. **Repair** — `erase-rect` with `Whole Clip` scope, clearing the NPC on all six
   walk frames.
7. **Commit** — three Clips, then `Verify reproducible` on each.
8. **Export** — target `pixel-pet`, Situations/bindings `idle`, `walk`, `jump`.
9. **Validate** — whole store, clean.

## Keeping

`store/` is **not** saved to git. It stays a scratch store per
[ADR-0011](./adr/0011-store-path-defaults-to-store.md); the run is reproducible
from the scripts instead.

Checked in: the deliverable GIF, the capture it was cut from, and the two tools.

- `site/media/ember-actions.gif` — the raw capture, kept so the run does not
depend on re-running a generator. It is the 18-frame input, **not** the deliverable;
`assets/ember-actions.gif` is the 18-frame output built from the Export.
- `tools/emit-recording.mjs` — regenerates that capture deterministically.
- `tools/compose-demo-gif.mjs` — slices an Export's own sheets into the preview
  GIF. It copies no pixels from anywhere else, so the preview can never drift from
  the Export.

## Rebuilding from nothing

```sh
node tools/emit-recording.mjs /tmp/ember-actions.gif
npx tsx src/cli/index.ts ingest --store ./store --recording-file /tmp/ember-actions.gif --id ember-actions
npx tsx src/cli/index.ts cut --store ./store --recording ember-actions --action add --id idle --start 0 --end 4
npx tsx src/cli/index.ts cut --store ./store --recording ember-actions --action add --id walk --start 4 --end 10
npx tsx src/cli/index.ts cut --store ./store --recording ember-actions --action add --id jump --start 10 --end 18
npx tsx src/cli/index.ts create-character --store ./store --id ember --recording ember-actions --cut jump
# resize to 42x60 after framing, then per cut:
npx tsx src/cli/index.ts extract --store ./store --character ember --recording ember-actions --cut walk
npx tsx src/cli/index.ts repair  --store ./store --character ember --draft walk --action append \
  --tool erase-rect --start 0 --end 6 --x 1 --y 34 --width 7 --height 7
npx tsx src/cli/index.ts align --store ./store --character ember --action set-offset --draft walk --x -3 --y 0
npx tsx src/cli/index.ts commit --store ./store --character ember --draft walk --name walk
# ...same for idle and jump, then:
npx tsx src/cli/index.ts export --store ./store --character ember --target pixel-pet \
  --animations idle,walk,jump --situations idle,walk,jump \
  --bindings 'idle=idle;walk=walk;jump=jump'
node tools/compose-demo-gif.mjs store/exports/pixel-pet assets/ember-actions.gif 6
```

The UI path is the one that was exercised; the CLI above is the equivalent and
shares the same core verbs.

## Gaps found

- **No loop control in the Clip face.** All three Clips are `loop: true`, so jump
  repeats in the preview. Loop is only settable at Extract (`--no-loop` on the
  CLI); there is no UI toggle and no way to change it after the Draft exists.
- **The `+` on the Recordings rail needed a forced click** in automation; a plain
  Playwright click timed out waiting for stability. Not a store problem, but worth
  a look.
- **Resize is Character-wide and immediate.** Growing the Canvas for jump re-baked
  the already-committed Clips; a preview of the re-bake scale before writing would
  make that less abrupt.
