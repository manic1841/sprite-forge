GATE: DONE (不繼續跑，我已經說不跑手機畫面了，收尾寫報告)

Build closed at the user's word after round 5. The page is built desktop-first and the user
scoped the site to desktop use, so the last phone-width FAILs are waived rather than fixed.

## Open FAILs

None on desktop. At 1440 every checker line passes except the WARNs listed below.

Waived (both phone-only, 390px):

| check | target | reason |
|---|---|---|
| `screen-height` | `#pipeline` | desktop-only tool site: at 390 the pipeline section runs a few px past two screens; at 1440 it is one screen |
| `section-height` | `section#controls` | desktop-only tool site: at 390 the four control cards run ~45px past one screen; at 1440 they fit |

Both are recorded in `.taste-skill/waivers.json`. The last gate run printed the `#pipeline`
one as an open FAIL because the waiver was written afterwards; `#controls` surfaced in a
follow-up 390 pass. No waiver covers `kit-edited` or `checker-gaming`, and neither tripped:
the page loads byte-identical copies of the kit's `assets/`, never minified.

## Kind and deal

Kind: `software` (developer tool). Name **sprite-forge**, taken from the repository and its
`package.json`, so not coined and not searched; `names.json` records that.

- **Palette** — near-black green-black ground `#161c1a` with bone text `#e3e2da` and a muted
  mint accent `#9fc7b8`. It answers the dim room an emulator workbench is used in and the
  pixel grid behind it; the accent is a phosphor pale green, not a brand hue, so the warm red
  of the sprite frames stays the only warm colour on the page. Light panels (the code panel,
  the checklist) invert to bone-on-ink for contrast.
- **Pairing** — Instrument Sans (variable width) for display and text, DM Mono for every
  filename, command, hash and frame index. The mono is doing work, not decoration: the product
  speaks in paths and JSON.
- **Hero** — centred, one app window the hero hands the eye to, and it is the only entrance
  animation on the page.
- **Grounds** — `sage`: a pale sage band under the pipeline and the reproduce sections so the
  two long-form sections are paper, and the tool sections stay dark.
- **Effect** — `fluted-glass`, one `[data-visual]` frame in `#pipeline`, behind the hand-built
  pipeline diagram. One effect, one place.
- **Moments** — one: `word-highlight` in `#reproduce`, marking the words of the reproducible
  claim. No scene, no second moment.
- Rhythm `space`, buttons `pill`, marks `dots`, radius `sharp`, close `close-type`, footer
  `footer-dark`.

## Voice card

Technical-dry, second person for what you get, the tool as subject; 8–16 word sentences, real
commands and file names, house words Recording / Segment / Clip / Sequence / Canvas / Anchor /
Commit / Fork / Provenance, no virtue words and no pun on "forge".

copy-lint: 0 FAIL, 0 WARN, 644 words. No copy WARN was kept, so nothing to justify here.

## Results

- **Checker (consistency), 1440**: 0 FAIL, 23 WARN. Kept WARNs, all judged and left:
  `cut-text` (terminal lines end in an ellipsis on purpose: they are a terminal),
  `scroll-linked` / `scroll-reveal` (the `#reproduce` word highlight is scroll-driven),
  `card-layout` (the four control cards are a 2×2, not a row),
  `same-action` / `action-repeat` / `copy-buttons` (two nav links and the same "Run the
  workbench" action twice: the close and the hero),
  `text-contrast` inside the drawn mocks, `label-centre`, `nav-labels`, `nav-current`,
  `links`, `photo-set` (the frames are upscaled pixel art, upscaling is the point),
  `loop-cycle`, `effect-kind`, `section-air`, `section-gaps`, `copy-length`, `button-contrast`.
- **Layout pass**: 0 FAIL at 1440x900. 320px walk: no overflow, no collide, no tap-size FAIL.
- **Checker, 390**: 1 FAIL, waived (above), 27 WARN.
- **Perf**: 0 FAIL. CSS fell from 274.6 KiB to ~207 KiB by deleting 68 KiB of unused kit
  sheets (the backgrounds sheet, 42 KiB, and the diagrams sheet, 26 KiB, whose diagram is now
  hand-written markup). Two harmless WARNs remain (picture upscale, one style count).
- **Copy-lint**: 0 FAIL, 0 WARN.
- **Gl / shader lint**: pass, no WebGL context failures.

## What could not be checked

- Phone layout as a product decision: 390 was measured, but the user scoped the site to
  desktop, so phone tallies were taken as advisory and the last two FAILs waived.
- Real GPU shader timings: Chrome ran headless on CPU (`chrome-nosandbox`), so the
  fluted-glass frame was verified visually, not for frame cost.

## Assumed facts

The page states, without a source in the repo, that the tool needs Node 20+ and pnpm, that the
workbench dev server writes only inside the store passed to it, that Extract samples the
corner pixel at tolerance 24, that delays come from the GIF and snap to 10 ms, that Commit
refuses an anchor outside the Canvas / a taken id / frames that overrun it, and that the
export writes a manifest that inlines every Clip and the Bindings. The 32×24 canvas, anchor
16,24, delays 50–60 ms and the `verify-reproducible` name come from the repo's own docs.

## Slots for the client

- No form on the page. The closing call is a link to `#run`.
- Canonical domain: none yet; the footer's "Contact" link points at the footer itself and the
  socials row is empty. Both need real values.
- Footer credits name the icon sets already used (vscode-icons MIT, Lucide ISC).

## Footprint

`site/` ships at 1.3 MB: the page, the kit files it actually loads (system, layout, motion, one
moment, one effect, six UI fragments, the icon sheet), `media/`, the share image and favicon,
the report and the gate record. Pruned after the gate closed: the kit's whole photo / object /
scene / backgrounds / diagrams sets, every effect save `fluted-glass`, every moment save
`word-highlight`, the unused UI fragments, and the kit's demo and lab pages (~124 MB → 1.3 MB).
Nothing pruned was referenced by `index.html` or by the kept scripts' dynamic imports, and the
page was re-shot at 1440 afterwards: hero, mocks, terminals and diagram all still render.
Gate run artifacts (Chrome profiles, screenshot tiles, per-run crop folders) are gitignored and
regenerate on a rerun.

## Stand-ins

- **All sprite art is drawn stand-in art**, generated for this page with `sharp`
  (`.taste-skill/gen-art.cjs`): `media/frame-0..3-{s,l}.png`, `media/idle-sheet*.png`,
  `share.jpg`, `favicon.svg`. It is a pixel hero on a green ground, not the client's own
  character. Replace it with real frames from a Recording before launch.
- Every `img alt` describes what the frame shows, so a replacement does not need new alt text
  as long as the subject holds.
- The `#run` terminal, the toggle panel, the checklist, the code panel and the file-writer are
  drawn UI (`data-ui`), not screenshots of the real workbench; they carry real command and
  file names and should be swapped for real captures when available.
- `store/` in the page copy is the repo's example store, not a client directory.
