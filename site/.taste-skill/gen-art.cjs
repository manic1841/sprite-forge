// Stand-in sprite art for the demo store: a 40x30 hero, four walk frames,
// drawn pixel by pixel. Two sizes per frame so no picture is served far larger
// than it is shown: -s at 2x for the strips, -l at 14x for the canvas.
const sharp = require('sharp');
const W = 40, H = 30, OX = 4, OY = 3;

const INK = Buffer.from([22, 28, 26, 255]);
const CREAM = Buffer.from([232, 227, 214, 255]);
const ACCENT = Buffer.from([159, 199, 184, 255]);
const SHADE = Buffer.from([196, 190, 176, 255]);
const BG = Buffer.from([62, 70, 66, 255]);

// [y, xStart, xEnd, colour] per frame; legs and arms move, the rest holds
const base = [
  [4, 13, 18, INK], [5, 12, 19, INK], [5, 13, 18, CREAM],
  [6, 12, 19, INK], [6, 13, 18, CREAM], [7, 12, 19, INK], [7, 13, 18, CREAM],
  [8, 12, 19, INK], [8, 13, 18, CREAM], [9, 12, 19, INK],
  [10, 12, 19, INK], [10, 13, 18, ACCENT],
  [11, 12, 19, INK], [11, 13, 18, ACCENT],
  [12, 11, 20, INK], [12, 12, 19, ACCENT],
  [13, 11, 20, INK], [13, 12, 19, ACCENT],
  [14, 11, 20, INK], [14, 12, 19, ACCENT],
];
const eyes = [[6, 14, 14, INK], [6, 17, 17, INK], [7, 14, 14, INK], [7, 17, 17, INK]];
const arms = {
  0: [[12, 10, 10, INK], [12, 21, 21, INK], [13, 10, 10, SHADE], [13, 21, 21, SHADE]],
  1: [[12, 10, 10, INK], [12, 21, 21, INK], [13, 10, 10, SHADE], [13, 21, 21, SHADE]],
  2: [[12, 10, 10, INK], [12, 21, 21, INK], [13, 10, 10, SHADE], [13, 21, 21, SHADE]],
  3: [[12, 10, 10, INK], [12, 21, 21, INK], [13, 10, 10, SHADE], [13, 21, 21, SHADE]],
};
// legs: [y, xStart, xEnd] pairs per frame (two legs)
const legs = {
  0: [[15, 13, 15], [15, 17, 18], [16, 13, 15], [16, 17, 18], [17, 13, 15], [17, 17, 18], [18, 13, 15], [18, 17, 18], [19, 12, 15], [19, 17, 18]],
  1: [[15, 13, 14], [15, 17, 18], [16, 13, 14], [16, 17, 18], [17, 13, 14], [17, 17, 18], [18, 13, 14], [18, 17, 18], [19, 12, 14], [19, 17, 19]],
  2: [[15, 13, 15], [15, 17, 18], [16, 13, 15], [16, 17, 18], [17, 14, 15], [17, 16, 18], [18, 14, 15], [18, 16, 18], [19, 14, 15], [19, 16, 18]],
  3: [[15, 13, 14], [15, 17, 18], [16, 13, 14], [16, 17, 18], [17, 13, 14], [17, 17, 18], [18, 13, 14], [18, 17, 18], [19, 12, 16], [19, 18, 19]],
};

function frame(n, withBg) {
  const px = Buffer.alloc(W * H * 4);
  if (withBg) for (let i = 0; i < W * H; i++) BG.copy(px, i * 4);
  const put = (y, x, c) => { const X = x + OX, Y = y + OY; if (X < 0 || X >= W || Y < 0 || Y >= H) return; c.copy(px, (Y * W + X) * 4); };
  const fill = (y, x0, x1, c) => { for (let x = x0; x <= x1; x++) put(y, x, c); };
  for (const [y, x0, x1, c] of base) fill(y, x0, x1, c);
  for (const [y, x0, x1, c] of eyes) fill(y, x0, x1, c);
  for (const [y, x0, x1, c] of arms[n]) fill(y, x0, x1, c);
  for (const [y, x0, x1] of legs[n]) fill(y, x0, x1, INK);
  return sharp(px, { raw: { width: W, height: H, channels: 4 } });
}

(async () => {
  const dir = 'media';
  for (let n = 0; n < 4; n++) {
    const withBg = n < 2; // the first two still sit on the Recording's ground
    const src = frame(n, withBg);
    await src.clone().resize({ width: W * 2, kernel: 'nearest' }).png().toFile(`${dir}/frame-${n}-s.png`);
    await src.clone().resize({ width: W * 14, kernel: 'nearest' }).png().toFile(`${dir}/frame-${n}-l.png`);
  }
  // the idle strip the nav card shows: four frames side by side, keyed out
  const parts = [];
  for (let n = 0; n < 4; n++) parts.push(await frame(n, false).png().toBuffer());
  const sheet = await sharp({ create: { width: W * 4, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(parts.map((input, i) => ({ input, left: i * W, top: 0 })))
    .png()
    .toBuffer();
  await sharp(sheet).toFile(`${dir}/idle-sheet.png`);
  await sharp(sheet).resize({ width: W * 4 * 2, kernel: 'nearest' }).png().toFile(`${dir}/idle-sheet-2x.png`);
  console.log('frames written');
})();
