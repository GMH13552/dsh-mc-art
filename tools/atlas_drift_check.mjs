/**
 * Guard the hand-copied geometry against drifting from its oracle.
 *
 * The dynamic plugin cannot `import`, so `tools/atlas_core.mjs` is duplicated
 * inside it by hand -- across two files:
 *
 *   tools/mcart-plugin/host.js    block and entity geometry, quad building
 *   tools/mcart-plugin/client.js  the rasteriser
 *
 * That copying has already gone wrong once without anyone noticing: the `front`
 * entry of ENTITY_QUADS had its third parameter renamed to `d2` while its body
 * still read `w`, so every entity threw `w is not defined` and none could be
 * opened.  A comment asking people to keep the copies in step is not a guard.
 *
 * This compares **behaviour**, not text.  Comparing the source was tried first
 * and reported 15 mismatches out of 16 while nothing was wrong, because the
 * copies legitimately differ by `export` and by whitespace -- a check that
 * always fires teaches people to ignore it.
 *
 *   node tools/atlas_drift_check.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

const MIRRORS = [
  // Overridable so the SAME comparison can be pointed at the source that was
  // actually emitted.  Running it only against the working copy is how a
  // mistyped `faceCorners` corner reached a package twice: the check was green
  // because it never looked at what was emitted (AGENT.md #38).
  { file: process.env.MCART_HOST || join(HERE, 'mcart-plugin', 'host.js'), cut: '\nreturn {' },
  { file: process.env.MCART_CLIENT || join(HERE, 'mcart-plugin', 'client.js'), cut: 'const CSS = [' },
];

/** The shared names this check knows how to exercise. */
const SAMPLES = [
  'FACE_SHADE',
  'VANILLA_PARENTS',
  'ENTITY_QUADS',
  'faceCorners',
  'makeCamera',
  'renderScene',
];

const BOX = [0.8, 0, 0.8, 15.2, 16, 15.2];
const SIZE = 32;

const SYNTHETIC = {
  quads: [
    { p: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], uv: [[0, 0], [0, 1], [1, 1], [1, 0]], tex: 'a', shade: 1, mode: 'opaque' },
    { p: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], uv: [[0, 0], [0, 1], [1, 1], [1, 0]], tex: 'b', shade: 0.5, mode: 'opaque' },
  ],
  // One face whose depth ramps across the whole width, painted with four
  // different colours.  Both copies have to sample the SAME column at every
  // pixel: an orthographic camera interpolates texture coordinates linearly, and
  // one copy doing it with the perspective formula shows up here as a mismatch.
  slanted: [
    { p: [[0, 0, 0], [0, 1, 0], [1, 1, 1], [1, 0, 1]], uv: [[0, 0], [0, 1], [1, 1], [1, 0]], tex: 'c', shade: 1, mode: 'opaque' },
  ],
  ortho: {
    project: (point) => [SIZE / 2 + (point[0] - 0.5) * SIZE * 0.9,
      SIZE / 2 - (point[1] - 0.5) * SIZE * 0.9, 2 - point[2]],
  },
  textures: {
    a: { width: 1, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255]) },
    b: { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 255, 255]) },
    c: { width: 4, height: 1, data: new Uint8ClampedArray([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]) },
  },
  eye: [2.4, 2.0, 2.2],
  look: [0.5, 0.5, 0.5],
};

function describe(value) {
  return JSON.stringify(value, (key, item) => (typeof item === 'function' ? '[function]' : item));
}

/** Evaluate one mirror's prologue, exposing only what it actually defines. */
function evaluate(mirror) {
  const text = readFileSync(mirror.file, 'utf8');
  const at = text.indexOf(mirror.cut);
  if (at < 0) throw new Error('cannot find ' + JSON.stringify(mirror.cut) + ' to cut at');
  const prologue = text.slice(0, at);
  const present = SAMPLES.filter((name) =>
    new RegExp('(function|const)\\s+' + name + '\\s*[=(]').test(prologue));
  const label = mirror.file.split('/').slice(-2).join('/');
  if (present.length === 0) return { label, api: {}, present };
  return { label, api: new Function(prologue + '\nreturn { ' + present.join(', ') + ' };')(), present };
}

async function main() {
  const oracle = await import(pathToFileURL(join(HERE, 'atlas_core.mjs')).href);

  const loaded = [];
  for (const mirror of MIRRORS) {
    try {
      loaded.push(evaluate(mirror));
    } catch (error) {
      console.log('FAIL ' + mirror.file + ' does not evaluate: ' + error.message);
      return 1;
    }
  }
  for (const item of loaded) {
    console.log('  ' + item.label + ': defines ' + (item.present.join(', ') || '(nothing shared)'));
  }

  let failures = 0;
  for (const name of SAMPLES) {
    const owner = loaded.find((item) => item.present.includes(name));
    if (owner === undefined) { console.log('FAIL ' + name + ' is in no mirror'); failures += 1; continue; }
    if (!(name in oracle)) { console.log('FAIL ' + name + ' is not exported by atlas_core.mjs'); failures += 1; continue; }

    const mine = owner.api[name];
    let left;
    let right;
    if (name === 'ENTITY_QUADS') {
      // The entries are callables, so comparing them as data proves nothing.
      // Call every one: this is what the `d2` rename broke, and a throw here
      // must read as a failure rather than crashing the check.
      const sample = (entry) => {
        try {
          return [entry[0], entry[1], entry[2](3, 5, 7, 9, 11)];
        } catch (error) {
          return [entry[0], entry[1], 'THREW ' + error.message];
        }
      };
      left = oracle[name].map(sample);
      right = mine.map(sample);
    } else if (name === 'faceCorners') {
      const faces = ['down', 'up', 'north', 'south', 'west', 'east'];
      left = faces.map((face) => oracle.faceCorners(...BOX, face));
      right = faces.map((face) => mine(...BOX, face));
    } else if (name === 'renderScene') {
      // Compared through a real render: two rasterisers that disagree draw a
      // different picture from the same quads.  BOTH projections are compared --
      // the orthographic pass is the item icon's, and a copy that only learned
      // about it in one of the two files is exactly the drift this guards.
      const run = (render, makeCamera) => {
        const camera = makeCamera(SYNTHETIC.eye, SYNTHETIC.look, SIZE, SIZE, Math.PI / 4);
        const perspective = render({ quads: SYNTHETIC.quads, textures: SYNTHETIC.textures,
          width: SIZE, height: SIZE, background: [0, 0, 0], camera });
        const orthographic = render({ quads: SYNTHETIC.slanted, textures: SYNTHETIC.textures,
          width: SIZE, height: SIZE, background: [0, 0, 0], camera: SYNTHETIC.ortho,
          orthographic: true });
        return { perspective: Array.from(perspective), orthographic: Array.from(orthographic) };
      };
      left = run(oracle.renderScene, oracle.makeCamera);
      right = run(owner.api.renderScene, owner.api.makeCamera);
    } else {
      left = oracle[name];
      right = mine;
    }

    if (describe(left) === describe(right)) continue;
    failures += 1;
    console.log('FAIL ' + name + ' behaves differently (in ' + owner.label + ')');
    console.log('       oracle: ' + describe(left).slice(0, 200));
    console.log('       mirror: ' + describe(right).slice(0, 200));
  }

  // The pick buffer drives click-to-place and nothing else checks it: the oracle
  // has no equivalent.  Every picked pixel must agree with the colour that
  // actually won there, or a click places a block somewhere else.
  const client = loaded.find((item) => item.present.includes('renderScene'));
  if (client !== undefined) {
    const camera = client.api.makeCamera(SYNTHETIC.eye, SYNTHETIC.look, SIZE, SIZE, Math.PI / 4);
    const pick = new Int32Array(SIZE * SIZE);
    pick.fill(-1);
    const bytes = client.api.renderScene({ quads: SYNTHETIC.quads, textures: SYNTHETIC.textures,
      width: SIZE, height: SIZE, background: [0, 0, 0], camera, pick });
    let covered = 0;
    let wrong = 0;
    let outside = 0;
    for (let i = 0; i < pick.length; i++) {
      if (pick[i] < 0) continue;
      covered += 1;
      if (pick[i] >= SYNTHETIC.quads.length) { outside += 1; continue; }
      // Quad 0 is red at shade 1, quad 1 is blue at shade 0.5.  The lit
      // channel is 255 * shade in both cases -- only which channel differs.
      const shade = pick[i] === 0 ? 1 : 0.5;
      const got = pick[i] === 0 ? bytes[i * 4] : bytes[i * 4 + 2];
      if (Math.abs(got - 255 * shade) > 1.5) wrong += 1;
    }
    if (covered === 0 || outside > 0 || wrong > 0) {
      failures += 1;
      console.log('FAIL pick buffer disagrees with the picture (covered=' + covered + ', outside=' + outside + ', wrong=' + wrong + ')');
    } else {
      console.log('  pick buffer: ' + covered + ' covered pixel(s), every one matches the quad that drew it');
    }
  }

  console.log((failures === 0 ? 'OK  ' : 'BAD ') + SAMPLES.length + ' shared definition(s) compared, ' + failures + ' mismatch(es)');
  return failures === 0 ? 0 : 1;
}

process.exit(await main());
