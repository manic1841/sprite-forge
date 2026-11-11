// Assemble the deliverable preview GIF from an Export's own sheets.
//
// The Export is the contract (manifest + per-animation strips, `docs/export-contract.md`):
// there is no GIF in it, and the consumer never needs one. This script only
// re-packages what the Export already froze — it reads `manifest.json`, slices
// each sheet into `canvas`-sized frames, lays them over a flat backdrop and
// writes one loop. No pixel comes from anywhere but the committed sheets.
//
//   node tools/compose-demo-gif.mjs <export dir> <out.gif> [scale]

import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const [exportDir, out, scaleArg] = process.argv.slice(2);
if (!exportDir || !out) {
    console.error('usage: node tools/compose-demo-gif.mjs <export dir> <out.gif> [scale]');
    process.exit(1);
}
const scale = Number(scaleArg ?? 6);
const BACKDROP = { r: 0x1a, g: 0x1c, b: 0x2c, alpha: 1 };

const manifest = JSON.parse(readFileSync(path.join(exportDir, 'manifest.json'), 'utf8'));
const { width, height } = manifest.canvas;
// Play order is the reading order of the Situations; a GIF is a single strip, so
// there is no binding here beyond the sequence the demo wants to show.
const order = ['idle', 'walk', 'jump'];
const animations = order.map((id) => ({ id, ...manifest.animations[id] }));
if (animations.some((entry) => entry.frameCount === undefined)) {
    throw new Error('the manifest is missing one of idle/walk/jump');
}

const frames = [];
const delays = [];
for (const animation of animations) {
    const sheet = await sharp(path.join(exportDir, animation.sheet))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    for (let index = 0; index < animation.frameCount; index += 1) {
        const left = index * width;
        const cropped = await sharp(sheet.data, {
            raw: { width: sheet.info.width, height: sheet.info.height, channels: 4 },
        })
            .extract({ left, top: 0, width, height })
            .png()
            .toBuffer();
        const framed = await sharp({
            create: { width, height, channels: 4, background: BACKDROP },
        })
            .composite([{ input: cropped }])
            .resize(width * scale, height * scale, { kernel: 'nearest' })
            .raw()
            .toBuffer();
        frames.push(framed);
        delays.push(animation.delaysMs[index] ?? animation.delaysMs[0]);
    }
}

const scaledW = width * scale;
const scaledH = height * scale;
await sharp(Buffer.concat(frames), {
    raw: { width: scaledW, height: scaledH * frames.length, channels: 4, pageHeight: scaledH },
})
    .gif({ loop: 0, delay: delays })
    .toFile(out);

console.log(`${out}: ${frames.length} frames at ${scaledW}x${scaledH}`);
