# mGBA GIF ingestion facts

Research for wayfinder ticket **#3 (mGBA GIF ingestion)** in the sprite-forge map.

Scope: what happens when we ingest the mGBA-recorded animated GIFs that feed the Pixel Pet
asset pipeline — how `sharp` decodes them, how frame timing/disposal survive, what the GIF
palette and 1-bit transparency mean for a de-backgrounded RGBA output, and what provenance we
can (and cannot) get at decode time.

Primary sources used: the `sharp` documentation and installed source, the `libvips` GIF loader
(`nsgifload.c`, which `sharp` calls through `libvips`), and the CompuServe GIF89a specification.
Every non-obvious claim below is cited inline; the raw numbers come from scripts run against our
own file.

**Test environment.** `sharp` **0.35.5** (libvips 1.3.4 prebuilt), installed at
`/workspace/one-piece.worktrees/feature-pixel-pet-tool/node_modules/sharp`. Source file
`/workspace/one-piece.worktrees/feature-pixel-pet-tool/examples/fat_walk.gif` (240x160, 523 pages,
390,262 bytes). Throwaway scripts: `/tmp/gifcheck.js`, `/tmp/gifcheck2.js`, `/tmp/gifcheck3.js`,
`/tmp/gifparse.js`.

---

## 1. How `sharp` decodes animated GIFs

### The options that matter

`sharp`'s constructor exposes three related input options, all mapped onto `libvips`' page
model (`node_modules/sharp/lib/index.d.ts:1018-1019,1038-1039`):

- `page` — zero-based page to start extracting from (default `0`).
- `pages` — number of pages to extract; `-1` means *all* pages (default `1`).
- `animated: true` — equivalent to `pages: -1`.

The installed source confirms the mapping literally:
`inputDescriptor.pages = inputOptions.animated ? -1 : 1;`
(`node_modules/sharp/dist/input.cjs:244-247`).

When more than one page is loaded, they are returned as a vertically stacked "toilet roll" image
whose overall height is `pageHeight * pages` (`node_modules/sharp/dist/constructor.cjs:29-32`).
`metadata()`'s reported `width`/`height` respect the `page`/`pages` options
([sharp API — Input metadata](https://sharp.pixelplumbing.com/api-input/#metadata)).

### The "known quirk": it is historical, not current

There **was** a real historical bug: [sharp issue #1566 "No `pages` metadata for animated
gif"](https://github.com/lovell/sharp/issues/1566) (opened Feb 2019, fixed in v0.22.0) — for
animated GIFs `metadata.pages` was `undefined` and non-`animated` operations silently acted on
only the first frame.

On the version we actually use (**0.35.5**) the frame-count discrepancy in the ticket **does not
reproduce** — the animated and page-by-page paths agree exactly. Measured on
`fat_walk.gif`:

| probe | frames |
| --- | --- |
| `metadata({animated:true}).pages` | **523** |
| `metadata({animated:true}).delay.length` | **523** |
| `raw({animated:true})` → `info.height / info.pageHeight` = `83680 / 160` | **523** |
| page-by-page `raw({page:p, pages:1})`, `p = 0..` | **523** (page 523 throws `bad page number`) |
| page-by-page vs stacked byte-compare | **0 / 523 frames differ** |

The *real* trap is the opposite direction, and it is worth stating precisely because the legacy
pipeline relies on it:

- A **plain** `metadata()` (no options, i.e. `pages: 1`) reports `height: 160` and
  `pageHeight: undefined`, but still reports `pages: 523` and `delay.length: 523`. If you derive
  the count from `height / pageHeight` you get **1**.
- A **plain** decode (`sharp(src).raw()`, no options) returns **one** page — 240x160x4
  (153,600 bytes) — even though the header's `pages` is 523.
- `{page: p}` **without** `{pages: 1}` still returned a single page in our tests, but relying on
  that default is fragile; pass `pages: 1` explicitly.

### Robust recipe

**(a) True frame count and per-frame delays** — read both from one animated `metadata()` call:

```js
const md = await sharp(src, { animated: true }).metadata();
const frameCount = md.pages;            // 523
const delaysMs = md.delay;              // number[523]
```

`pageHeight` is also only populated in the animated/`pages:-1` view (`160` here); the logical
single-frame size is `width x pageHeight` = `240 x 160`.

**(b) Every frame as raw RGBA** — two equivalent routes, both verified to produce byte-identical
frames:

- *One decode, slice the toilet roll* (fewer file opens):
  ```js
  const { data, info } = await sharp(src, { animated: true })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.pageHeight;      // 240, 160
  const bytesPerFrame = w * h * 4;                // 153,600
  // data.length === bytesPerFrame * info.pages    // 80,332,800 === 523 * 153,600
  for (let i = 0; i < info.pages; i++) {
    const frame = data.subarray(i * bytesPerFrame, (i + 1) * bytesPerFrame);
  }
  ```
- *Page-by-page* (true count discovery; index `p` must be `< frameCount` or libvips throws
  `Input file has corrupt header: gifload: bad page number`):
  ```js
  for (let p = 0; ; p++) {
    const { data, info } = await sharp(src, { page: p, pages: 1 })
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    // info.width === 240, info.height === 160, data.length === 153,600
  }
  ```

Decoding each page with `.ensureAlpha().raw()` yields exactly a **240x160x4** buffer
(`info.channels: 4`, `info.size: 153600`), confirmed for every page.

**Important:** per-frame delays are **not** exposed on `raw()` output. Page-by-page
`info.delay` was `undefined` for all 523 pages (`info` carries only `format/width/height/channels/...`).
The delay array only comes from `metadata().delay`. `sharp`'s `metadata` docs describe `delay` as
"Delay in ms between each page in an animated image, provided as an array of integers"
(`index.d.ts:1266-1267`; [sharp API — Input metadata](https://sharp.pixelplumbing.com/api-input/#metadata)).

---

## 2. Delays, disposal and blend modes

### What the GIF container actually stores

The GIF89a Graphic Control Extension (§23) stores, per frame
([GIF89a spec, W3C](https://www.w3.org/Graphics/GIF/spec-gif89a.txt)):

- **Delay Time** — "the number of hundredths (1/100) of a second to wait", i.e. **centiseconds**.
- **Disposal Method** — `0` unspecified, `1` *do not dispose*, `2` *restore to background*,
  `3` *restore to previous*.
- **Transparent Color Index** — a single palette index; pixels equal to it are "not modified".

### How libvips/`sharp` carries them through

`sharp` uses libvips' `gifload`, which since 2022 is `libvips/foreign/nsgifload.c` based on
`libnsgif` ([libvips `nsgifload.c`](https://github.com/libvips/libvips/blob/master/libvips/foreign/nsgifload.c)).
In `vips_foreign_load_nsgif_header` it:

- converts the centisecond delay to milliseconds: `gif->delay[i] = 10 * frame_info->delay;`
- sets `VIPS_META_N_PAGES` to `info->frame_count`, attaches the `delay` int array, the `loop`
  value, and the `background` array;
- writes `page-height` metadata **only when more than one page is loaded**, so a single frame
  does not accidentally look animated;
- renders each page via `nsgif_frame_decode(anim, page, &bitmap)`, which returns a
  **composited** RGBA bitmap — libnsgif applies disposal/blending internally. `sharp`'s stacked
  output is therefore the *fully composited* animation, not raw delta sub-rectangles.

### Measured on `fat_walk.gif` (raw parse of the Graph Control Extensions)

- Frames: **523**.
- **Disposal: `1` (do-not-dispose) for all 523 frames** — every frame is drawn on top of the
  running canvas.
- Transparent-colour flag: set on **522 / 523** frames (1 frame without it).
- Frame rectangles are small **delta sub-rectangles**, e.g. `0,69,9,16` (26 occurrences),
  `239,159,1,1` (8), etc. — not full 240x160 frames.
- Decoded pixels across the whole animation: **20,083,200**, of which **0 are non-opaque**
  (`0` transparent, `0` partial). So despite 522 frames carrying a transparent index, the
  composited output is *fully opaque*: transparent-index pixels mean "leave the previous canvas
  untouched", not "become alpha 0".

This is the key blend/disposal fact for the pipeline: **`sharp` hands you already-composited
opaque frames.** You cannot recover transparency from the GIF's transparent index; transparency
must be produced by colour-keying the flat background afterwards.

### Timing pattern → `delaysMs`

- GIF Graph Control delays (centiseconds): `{5: 511, 6: 12}`.
- `metadata().delay` (ms): `{50: 511, 60: 12}`; `delay.length: 523`; sum **26,270 ms**.
- The twelve 60 ms frames are at indices **21, 65, 109, 153, 197, 241, 284, 328, 372, 416, 460,
  504** — i.e. a 60 ms frame roughly every 44 frames (spacing is 44, with one 43 after index 241).

So the correct mapping is a **per-frame `delaysMs` array copied straight from
`metadata().delay`** — 511 entries of 50 and 12 entries of 60 — not a single fixed FPS. A uniform
frame rate would drop/telescope the periodic 60 ms hiccup. `loop` is `0` (infinite).

---

## 3. Palette / alpha limits and de-backgrounded RGBA

### GIF's hard limits

- Colours are **indexed into a palette** of at most **256** entries (global and/or per-frame
  local tables; each entry is an RGB triplet, 8 bits per channel) — GIF89a §§11, 19-22
  ([GIF89a spec](https://www.w3.org/Graphics/GIF/spec-gif89a.txt)).
- Transparency is a **single palette index**, i.e. **1-bit** alpha: a pixel is either drawn
  opaque or "not modified". There is no partial/feathered alpha (GIF89a §23).
- GIF was explicitly "not intended as a platform for animation" (GIF89a Appendix D), so timing
  and compositing semantics are loose — another reason to trust the decoded, composited result.

### Measured on our file

- `isPalette: true`, `bitsPerSample: 8`, global colour table = **256 entries**; **85 distinct RGB
  colours** are used across all 523 frames (well under the 256 limit).
- Decoded alpha is strictly binary in practice: every one of the 20,083,200 pixels is fully
  opaque — consistent with the "composited, no partial alpha" story above.

### Pitfalls for the `#9421ce` colour-key

1. **Don't trust the GIF background index or `metadata().background`.** The logical-screen
   background index is `31`, and `metadata().background` reports `{r:156, g:255, b:255}` (that is
   `GCT[31]`) — but the actual flat cover colour is `#9421ce = (148,33,206)`, which lives at
   **`GCT[29]`**. The GIF background index is *not* the visible backdrop here. Corners must be
   sampled (which the pipeline already does in
   `src/tools/pixel-pet-assets/background.ts` `sampleCornerColors`/`detectBackground`).

2. **The transparent index is not your transparency.** As shown in §2, the decode is opaque; the
   pipeline colour-keys the sampled corner colour with a per-channel tolerance
   (`background.ts` `applyBackgroundRemoval`, `DEFAULT_TOLERANCE = 24`). That is the right model.

3. **Antialiasing / halo.** Because GIF is indexed, if the palette contained near-background
   blend colours (from scaling or dithering at record time) a colour-key would leave a halo
   ring. On *our* file there is none: of 20,083,200 pixels, **19,174,150 are exactly `#9421ce`,
   0 are within ±24 per channel but different, and 909,050 are other colours** — a clean,
   hard-edged flat background, so the exact/tolerance key removes it perfectly. Keep the
   tolerance check for robustness on other recordings, but expect exact matches for mGBA output.

4. **Round-trip encoding can reintroduce palettes/halos.** `sharp`'s GIF *encoder* defaults to
   Floyd-Steinberg dithering (`dither: 1.0`) and inter-frame error tolerance, and "the first
   entry in the palette is reserved for transparency" ([sharp API — Output
   options](https://sharp.pixelplumbing.com/api-output/#gif)). For hard pixel art with
   transparency, encode with `dither: 0` and `interFrameMaxError: 0` to avoid palette error and
   halo creep. The existing encoder already passes `reuse: false` and
   `keepDuplicateFrames: true` (`src/tools/pixel-pet-assets/gif.ts` `encodeGif`).

5. **Single-bit alpha means RGBA alpha is always `0` or `255`.** Any downstream "soft edge" /
   anti-aliased scaling must be done knowingly, because the source can never carry feathered
   alpha.

---

## 4. Provenance at ingest

`sharp`'s `metadata()` result carries **no filename/path field**. Its documented keys are
geometric/format facts only (`format`, `width`, `height`, `pages`, `pageHeight`, `delay`, `loop`,
`isPalette`, `bitsPerSample`, `background`, `hasAlpha`, `space`, `channels`, ...) —
[sharp API — Input metadata](https://sharp.pixelplumbing.com/api-input/#metadata). The actual
keys returned for our file:
`autoOrient, background, bitsPerSample, channels, delay, depth, format, hasAlpha, hasProfile,
height, isPalette, isProgressive, loop, mediaType, pageHeight, pages, space, width` — **no
`filename`** (`metadata(file)` and `metadata(buffer)` key sets match).

`metadata().size` is only populated for Buffer/Stream input, not for a path. Measured:
`metadata(file).size === undefined`, while `metadata(buffer).size === 390262`. So even the byte
size is lost when you pass a filename and must be re-`stat`ed.

Therefore **the source path must be captured by the caller at ingest and threaded through
explicitly.** It cannot be recovered from the decoded image.

This matters because it is a known legacy defect: every generated `output/*/config.json` starts
with `"input": "<in-memory>"`
(e.g. `one-piece.worktrees/feature-pixel-pet-tool/output/fat_walk/config.json:2`), so the legacy
configs lost the source filename entirely — and there are multiple source recordings, so the
provenance is genuinely ambiguous. The new pipeline must record it first-class (map answer Q6).

**What ingest *can* capture**, in one `metadata({animated:true})` call plus the caller's path:

| field | value for `fat_walk.gif` |
| --- | --- |
| source path | caller-supplied (not in `sharp` metadata) |
| `format` | `gif` |
| logical frame size | `width` x `pageHeight` = 240 x 160 |
| stacked `height` | 83,680 (= 523 x 160) |
| `pages` | 523 |
| `delay` | 523 entries (511x50 ms, 12x60 ms) |
| `loop` | 0 (infinite) |
| `isPalette` / `bitsPerSample` | true / 8 |
| `hasAlpha` | true (but decoded alpha is all-opaque) |
| `background` | `{156,255,255}` — **untrusted**, use corner sampling |
| byte size | requires `fs.stat(path)` (`metadata(file).size` is `undefined`) |

---

## Sources

- **sharp API docs**: [Input metadata](https://sharp.pixelplumbing.com/api-input/#metadata),
  [Output options (`gif`)](https://sharp.pixelplumbing.com/api-output/#gif),
  [Constructor](https://sharp.pixelplumbing.com/api-constructor/).
- **sharp installed source (v0.35.5)**: `node_modules/sharp/dist/input.cjs:244-247`
  (`animated`/`pages`/`page` → libvips descriptor); `node_modules/sharp/dist/constructor.cjs:29-32`
  (toilet-roll stacking); `node_modules/sharp/lib/index.d.ts:1018-1019,1038-1039,1260-1290`
  (option and metadata docs); `node_modules/sharp/src/metadata.cc:70-71,250-256` (`delay`
  array extraction).
- **sharp issue #1566** — "No `pages` metadata for animated gif" (fixed v0.22.0):
  https://github.com/lovell/sharp/issues/1566
- **libvips GIF loader** — `libvips/foreign/nsgifload.c` (`vips_foreign_load_nsgif_header`,
  `vips_foreign_load_nsgif_set_header`, `vips_foreign_load_nsgif_generate`; centisecond→ms delay
  conversion, `page-height`/`n-pages`/`delay`/`loop` metadata, per-page `nsgif_frame_decode`):
  https://github.com/libvips/libvips/blob/master/libvips/foreign/nsgifload.c
- **GIF89a specification** (CompuServe, 31 July 1990), §19-22 colour tables/image descriptor,
  §23 Graphic Control Extension (Disposal Method, Delay Time in 1/100 s, Transparent Color
  Index), Appendix D: https://www.w3.org/Graphics/GIF/spec-gif89a.txt
- **Empirical scripts** (throwaway, `/tmp`): `/tmp/gifcheck.js`, `/tmp/gifcheck2.js`,
  `/tmp/gifcheck3.js`, `/tmp/gifparse.js`, run against
  `one-piece.worktrees/feature-pixel-pet-tool/examples/fat_walk.gif`.
- **Repo cross-references**: `src/tools/pixel-pet-assets/gif.ts` (`decodeGif`),
  `src/tools/pixel-pet-assets/background.ts` (`sampleCornerColors`, `detectBackground`,
  `applyBackgroundRemoval`), `output/*/config.json:2` (`"input": "<in-memory>"` provenance defect).
