// Build the demo Recording: a 64×64, flat-backdrop "emulator capture" of one
// character performing three distinct actions, in three separate frame ranges.
//
// The capture is authored for the pipeline, so it exercises every stage:
//
//   • a single flat corner-sampled backdrop (#9421ce) with no gradients, so the
//     colour key yields hard alpha;
//   • one subject, one foot baseline and one ground shadow in every frame, so the
//     derived Anchor is stable across all three Segments;
//   • three unambiguous actions with different silhouettes (idle / walk / jump)
//     laid out as contiguous, non-overlapping ranges;
//   • a stray magenta "NPC" blob in the walk range only, which survives keying and
//     is what the Repair brush removes before commit.
//
// GIF delays are centiseconds, so every delay is a multiple of 10 ms.
//
//   node tools/emit-recording.mjs <out.gif>

import sharp from 'sharp';

const W = 64;
const H = 64;

const BG = [0x94, 0x21, 0xce];
const SHADOW = [0x6e, 0x14, 0x9e];
const BODY = [0xff, 0x8a, 0x3d];
const BODY_DARK = [0xc9, 0x53, 0x22];
const LIGHT = [0xff, 0xc4, 0x7a];
const HORN = [0xff, 0xe0, 0x8a];
const EYE = [0x1b, 0x10, 0x35];
const NPC = [0xff, 0x2d, 0x78];

const FEET_Y = 60;

function frame() {
  const px = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i += 1) {
    px[i * 4] = BG[0];
    px[i * 4 + 1] = BG[1];
    px[i * 4 + 2] = BG[2];
    px[i * 4 + 3] = 0xff;
  }
  return px;
}

function put(px, x, y, [r, g, b]) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const at = (y * W + x) * 4;
  px[at] = r;
  px[at + 1] = g;
  px[at + 2] = b;
  px[at + 3] = 0xff;
}

function rect(px, x, y, w, h, color) {
  for (let yy = y; yy < y + h; yy += 1) {
    for (let xx = x; xx < x + w; xx += 1) put(px, xx, yy, color);
  }
}

function ellipse(px, cx, cy, rx, ry, color) {
  for (let y = cy - ry; y <= cy + ry; y += 1) {
    for (let x = cx - rx; x <= cx + rx; x += 1) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) put(px, x, y, color);
    }
  }
}

/** A 2px-tall, dark foot shadow fixed to the ground, so the Anchor never drifts. */
function shadow(px) {
  ellipse(px, 32, FEET_Y + 2, 11, 2, SHADOW);
}

/**
 * One drawn frame.
 *
 * `dy` lifts the whole body (negative = up), `squash` widens (+) or narrows (−)
 * the torso by whole pixels, `legs` is the walk phase (0–5, -1 = planted), and
 * `blink` closes the eyes. The feet stay on the ground unless `legs` lifts one.
 */
function drawCreature(px, { dy = 0, squash = 0, legs = -1, arms = 0, blink = false } = {}) {
  shadow(px);

  const torsoX = 25 - squash;
  const torsoW = 15 + squash * 2;
  const torsoY = 33 + dy;
  const legTop = torsoY + 16;

  // Legs first (behind the torso).
  if (legs < 0) {
    rect(px, 28, legTop, 3, FEET_Y - legTop, BODY_DARK);
    rect(px, 34, legTop, 3, FEET_Y - legTop, BODY_DARK);
  } else {
    // Six-phase cycle: contact, down, pass, up, contact (mirror), pass.
    const stride = [0, 3, 1, -3, 0, -1][legs];
    const lift = [0, 0, 2, 4, 0, 0][legs];
    rect(px, 28 + stride, legTop, 3, FEET_Y - legTop - lift, BODY_DARK);
    rect(px, 34 - stride, legTop, 3, FEET_Y - legTop - Math.max(0, lift - 2), BODY_DARK);
  }

  // Arms (behind the torso), swinging with the walk and thrown up in the air.
  rect(px, torsoX - 3, 38 + dy - arms, 3, 8, BODY_DARK);
  rect(px, torsoX + torsoW, 38 + dy + arms, 3, 8, BODY_DARK);

  // Torso and head.
  rect(px, torsoX, torsoY, torsoW, 18, BODY);
  rect(px, torsoX, torsoY, 3, 18, BODY_DARK);
  rect(px, torsoX + torsoW - 3, torsoY, 3, 18, LIGHT);
  rect(px, torsoX + 2, torsoY - 9, torsoW - 4, 10, BODY);
  rect(px, torsoX + 2, torsoY - 9, 3, 10, BODY_DARK);
  rect(px, torsoX + torsoW - 5, torsoY - 9, 3, 10, LIGHT);

  // Horns and a forehead tuft.
  rect(px, torsoX + 1, torsoY - 14, 2, 6, HORN);
  rect(px, torsoX + torsoW - 3, torsoY - 14, 2, 6, HORN);
  rect(px, torsoX + Math.floor(torsoW / 2), torsoY - 12, 2, 4, LIGHT);

  // Eyes, shifted right: the art is authored facing right.
  const eyeY = torsoY - 3;
  if (blink) {
    rect(px, torsoX + 5, eyeY + 1, 2, 1, EYE);
    rect(px, torsoX + 9, eyeY + 1, 2, 1, EYE);
  } else {
    rect(px, torsoX + 5, eyeY, 2, 2, EYE);
    rect(px, torsoX + 9, eyeY, 2, 2, EYE);
  }

  // Mouth.
  rect(px, torsoX + 7, eyeY + 4, 3, 1, EYE);
}

/** The stray NPC that survives keying and has to be repaired away. */
function drawNpc(px) {
  rect(px, 8, 40, 4, 4, NPC);
  rect(px, 9, 39, 2, 1, NPC);
}

// --- the three actions ------------------------------------------------------

const idleFrames = [
  { dy: 0 },
  { dy: -1, blink: true },
  { dy: 0 },
  { dy: -1 },
];

const walkFrames = [0, 1, 2, 3, 4, 5].map((phase) => ({
  dy: phase === 2 || phase === 3 ? -1 : 0,
  legs: phase,
  arms: [1, 0, -1, 0, 1, 0][phase],
}));

const jumpFrames = [
  { dy: 0 }, // rest
  { dy: 4, squash: 1 }, // crouch
  { dy: -2, squash: -1, arms: 4 }, // launch
  { dy: -9, squash: -1, arms: 5 }, // rise
  { dy: -12, arms: 5 }, // apex
  { dy: -9, arms: 4 }, // fall
  { dy: -2, squash: -1 }, // brace
  { dy: 3, squash: 1 }, // land
];

const plan = [
  ...idleFrames.map((pose) => ({ pose, delay: 140, npc: false })),
  ...walkFrames.map((pose) => ({ pose, delay: 100, npc: true })),
  ...jumpFrames.map((pose) => ({ pose, delay: 110, npc: false })),
];

const stacked = Buffer.alloc(W * H * plan.length * 4);
for (let index = 0; index < plan.length; index += 1) {
  const px = frame();
  drawCreature(px, plan[index].pose);
  if (plan[index].npc) drawNpc(px);
  px.copy(stacked, index * W * H * 4);
}

const out = process.argv[2];
if (!out) {
  console.error('usage: node tools/emit-recording.mjs <out.gif>');
  process.exit(1);
}

await sharp(stacked, { raw: { width: W, height: H * plan.length, channels: 4, pageHeight: H } })
  .gif({ loop: 0, delay: plan.map((entry) => entry.delay), keepDuplicateFrames: true })
  .toFile(out);

console.log(
  `${out}: ${plan.length} frames ` +
    `(idle 0-${idleFrames.length - 1}, walk ${idleFrames.length}-` +
    `${idleFrames.length + walkFrames.length - 1}, jump ` +
    `${idleFrames.length + walkFrames.length}-${plan.length - 1})`,
);
