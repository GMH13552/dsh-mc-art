#!/usr/bin/env node
/**
 * Offline oracle for the JS port.
 *
 * Renders a fixture with `atlas_core.mjs` and diffs it against a PNG produced by
 * the Python renderer for the *same* scene and the *same* camera. If the port
 * drifted, this fails -- which is the only reason the plugin's copy of the
 * rasteriser is allowed to be trusted before a browser ever runs it.
 *
 *   node tools/atlas_oracle.mjs /tmp/oracle/cow.json
 */

import fs from 'node:fs';
import path from 'node:path';

import { decodePng, encodePng } from './png.mjs';
import {
  entityQuads, makeCamera, quadsFromElements, renderScene, resolveBlockModel,
} from './atlas_core.mjs';

function loadTexture(file) {
  const image = decodePng(fs.readFileSync(file));
  return { width: image.width, height: image.height, data: image.data };
}

function main() {
  const fixturePath = process.argv[2];
  if (!fixturePath) {
    console.error('usage: atlas_oracle.mjs <fixture.json>');
    return 2;
  }
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const cameraSpec = fixture.camera;
  const camera = makeCamera(
    cameraSpec.position, cameraSpec.target,
    cameraSpec.width, cameraSpec.height, cameraSpec.fovY,
  );

  const textures = {};
  for (const id of Object.keys(fixture.textures)) {
    textures[id] = loadTexture(fixture.textures[id]);
  }

  let quads = [];
  if (fixture.kind === 'entity') {
    for (const layer of fixture.layers) {
      quads = quads.concat(entityQuads(layer.spec, layer.texture, layer.mode));
    }
  } else if (fixture.kind === 'block') {
    const parents = fixture.parents || {};
    const elements = resolveBlockModel(
      fixture.model,
      (id) => parents[id],
      (name) => fixture.textureIds[name],
    );
    if (elements === undefined) throw new Error('block model resolved to no elements');
    quads = quadsFromElements(elements);
  } else {
    throw new Error('unknown fixture kind ' + fixture.kind);
  }

  const pixels = renderScene({
    quads, textures,
    width: cameraSpec.width, height: cameraSpec.height,
    background: fixture.background || [28, 26, 30],
    camera,
  });

  const out = fixturePath.replace(/\.json$/, '.js.png');
  fs.writeFileSync(out, encodePng(cameraSpec.width, cameraSpec.height, pixels));

  const reference = decodePng(fs.readFileSync(fixture.reference));
  if (reference.width !== cameraSpec.width || reference.height !== cameraSpec.height) {
    console.error('reference size mismatch: %dx%d vs %dx%d',
      reference.width, reference.height, cameraSpec.width, cameraSpec.height);
    return 1;
  }

  let differing = 0;
  let worst = 0;
  let sum = 0;
  let opaque = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    let delta = 0;
    for (let c = 0; c < 3; c++) {
      delta = Math.max(delta, Math.abs(pixels[i + c] - reference.data[i + c]));
    }
    sum += delta;
    if (delta > worst) worst = delta;
    if (delta > 2) differing++;
    if (reference.data[i + 3] > 0) opaque++;
  }
  const total = pixels.length / 4;
  const fraction = (differing / total) * 100;
  const verdict = differing / total <= 0.002 ? 'PASS' : 'FAIL';
  console.log(
    verdict + ' ' + String(fixture.name || fixturePath).padEnd(14) +
    ' quads=' + String(quads.length).padEnd(5) +
    ' differing=' + String(differing).padEnd(6) +
    ' (' + fraction.toFixed(4) + '%)' +
    ' max_delta=' + worst + ' mean=' + (sum / total).toFixed(4) +
    ' -> ' + out,
  );
  return verdict === 'PASS' ? 0 : 1;
}

process.exit(main());
