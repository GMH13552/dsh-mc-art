/**
 * The overlay pass the placement ghost and the break highlight rely on.
 *
 * Two things must hold and neither is visible by eye until it is wrong:
 *   1. an overlay never writes depth or the pick buffer -- otherwise hovering
 *      would poison the next click's target, and
 *   2. an overlay is occluded by the scene -- a ghost behind a wall must not
 *      show through it.
 *
 * It also pins the initialisation rule: the client hands its colour and depth
 * buffers to the FIRST pass as well, so "did the caller pass a buffer" cannot
 * decide whether to initialise.  Getting that wrong renders a black screen.
 *
 *   node tools/mcart-overlay-test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(HERE, 'mcart-plugin', 'client.js'), 'utf8');
const api = new Function(source.slice(0, source.indexOf('const CSS = ['))
  + '\nreturn { renderScene, makeCamera };')();

const W = 32;
const H = 32;
const RED = { width: 1, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255]) };
const GREEN = { width: 1, height: 1, data: new Uint8ClampedArray([0, 255, 0, 255]) };
const PLATE = (z) => ({
  p: [[0, 0, z], [1, 0, z], [1, 1, z], [0, 1, z]],
  uv: [[0, 0], [0, 1], [1, 1], [1, 0]], tex: 'a', shade: 1, mode: 'opaque',
});

const camera = api.makeCamera([0.5, 0.5, 3], [0.5, 0.5, 0], W, H, Math.PI / 4);
let failures = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) failures += 1;
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (ok ? '' : '   got ' + got + ', wanted ' + want));
};
const pass = (quads, extra) => api.renderScene(Object.assign({
  quads, textures: { a: RED, g: GREEN }, width: W, height: H,
  background: [0, 0, 0], camera,
}, extra));

const colour = new Float64Array(W * H * 4);
const depth = new Float64Array(W * H);
const pick = new Int32Array(W * H);
pick.fill(-1);
pass([PLATE(0)], { colour, depth, pick });
const red = Array.from(colour).filter((v, i) => i % 4 === 0 && v > 0.9).length;
check('a first pass given buffers still initialises and draws', red > 100, true);

const depthBefore = Float64Array.from(depth);
const pickBefore = Int32Array.from(pick);

pass([{ ...PLATE(-2), tex: 'g' }], { colour, depth, pick, overlay: 0.5, tint: [0, 1, 0] });
check('an occluded ghost stays hidden', Array.from(colour).filter((v, i) => i % 4 === 0 && v > 0.9).length, red);
check('an overlay writes no depth', Array.from(depth).every((v, i) => Object.is(v, depthBefore[i])), true);
check('an overlay writes no pick', Array.from(pick).every((v, i) => v === pickBefore[i]), true);

const before = colour[(16 * W + 16) * 4];
pass([PLATE(0)], { colour, depth, pick, overlay: 0.5, tint: [0, 1, 0] });
check('a coplanar overlay still blends in', colour[(16 * W + 16) * 4] < before, true);
check('and it blends the tint channel', colour[(16 * W + 16) * 4 + 1] > 0.4, true);

console.log((failures === 0 ? 'OK  ' : 'BAD ') + 'overlay pass, ' + failures + ' failure(s)');
process.exit(failures === 0 ? 0 : 1);
