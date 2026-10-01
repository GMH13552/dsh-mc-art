#!/usr/bin/env node
/**
 * Asset-graph self-check — the data half of the viewer, without a browser.
 *
 * Replays what the plugin's Host half does: discover every project's pack, scan
 * the blockstates, resolve each model's parent chain, and assemble the scene for
 * every block / entity / biome / structure. Then it asserts the two things that
 * actually go wrong in practice:
 *
 *   1. an asset that resolves to NO geometry (a model name that does not exist,
 *      a cell pointing at a block from a namespace that is not on disk), and
 *   2. a quad whose texture file is missing.
 *
 * The rasteriser is already proven by `atlas_oracle.mjs`; this proves the part
 * that reads the project.
 *
 *   node tools/atlas_selftest.mjs [root]
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  entityQuads, faceCorners, quadsFromElements, resolveBlockModel, translateQuads,
} from './atlas_core.mjs';

const ROOT = process.argv[2] || process.cwd();
const failures = [];
const rows = [];

// A face whose corners are not four distinct points is a broken face, not a
// small one.  The plugin carries its own copy of this geometry and a typo there
// once turned every north face into a triangle while the render still looked
// plausible -- so the property is pinned here, on the canonical side.
for (const face of ['down', 'up', 'north', 'south', 'west', 'east']) {
  const corners = faceCorners(0, 0, 0, 16, 16, 16, face);
  const distinct = new Set(corners.map((point) => point.join(',')));
  if (distinct.size !== 4) {
    failures.push('faceCorners(' + face + ') yields only ' + distinct.size + ' distinct corners');
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return [];
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return undefined;
  }
}

function preload(dir, namespace) {
  const assets = path.join(dir, 'pack', 'assets', namespace);
  const models = new Map();
  for (const entry of listDir(path.join(assets, 'models', 'block'))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const parsed = readJson(path.join(assets, 'models', 'block', entry.name));
    if (parsed !== undefined) models.set('block/' + entry.name.slice(0, -5), parsed);
  }
  const textures = new Map();
  for (const kind of ['block', 'blocks', 'entity', 'item']) {
    for (const entry of listDir(path.join(assets, 'textures', kind))) {
      if (!entry.isFile() || !entry.name.endsWith('.png')) continue;
      textures.set(namespace + ':' + kind + '/' + entry.name.slice(0, -4),
        path.join(assets, 'textures', kind, entry.name));
    }
  }
  return { dir, namespace, assets, models, textures };
}

const preloads = new Map();

function texturePath(load, reference) {
  let name = String(reference === undefined ? '' : reference);
  let namespace = load.namespace;
  const colon = name.indexOf(':');
  if (colon >= 0) { namespace = name.slice(0, colon); name = name.slice(colon + 1); }
  const own = load.textures.get(namespace + ':' + name);
  if (own !== undefined) return own;
  const other = preloads.get(namespace);
  return other === undefined ? undefined : other.textures.get(namespace + ':' + name);
}

function elementsOf(load, modelName) {
  let key = modelName;
  const colon = key.indexOf(':');
  if (colon >= 0) key = key.slice(colon + 1);
  const model = load.models.get(key);
  if (model === undefined) return undefined;
  return resolveBlockModel(model, (id) => {
    let parent = id;
    const c = parent.indexOf(':');
    if (c >= 0) parent = parent.slice(c + 1);
    return load.models.get(parent);
  }, (reference) => texturePath(load, reference));
}

function blockStates(load) {
  const out = [];
  for (const entry of listDir(path.join(load.assets, 'blockstates'))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const id = entry.name.slice(0, -5);
    const state = readJson(path.join(load.assets, 'blockstates', entry.name));
    let model = id;
    if (state !== undefined && state.variants !== undefined) {
      const keys = Object.keys(state.variants);
      if (keys.length > 0) {
        let value = state.variants[keys[0]];
        if (Array.isArray(value)) value = value[0];
        if (value !== undefined && typeof value.model === 'string') model = value.model;
      }
    }
    out.push({ id, model });
  }
  return out;
}

function audit(name, quads) {
  if (quads.length === 0) {
    failures.push(name + ': resolved to NO geometry');
    rows.push(['EMPTY', name, 0, 0]);
    return;
  }
  const wanted = new Set(quads.map((quad) => quad.tex));
  let missing = 0;
  for (const file of wanted) if (!fs.existsSync(file)) missing++;
  if (missing > 0) failures.push(name + ': ' + missing + ' missing texture file(s)');
  rows.push([missing > 0 ? 'MISS' : 'ok', name, quads.length, wanted.size]);
}

for (const entry of listDir(ROOT)) {
  if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
  const dir = path.join(ROOT, entry.name);
  const assetsRoot = path.join(dir, 'pack', 'assets');
  const namespaces = listDir(assetsRoot).filter((n) => n.isDirectory()).map((n) => n.name);
  const atlas = readJson(path.join(dir, 'mc-art.atlas.json'));
  if (namespaces.length === 0 && atlas === undefined) continue;
  const namespace = atlas && namespaces.includes(atlas.namespace) ? atlas.namespace : namespaces[0];
  if (namespace === undefined) continue;
  const load = preload(dir, namespace);
  preloads.set(namespace, load);

  for (const block of blockStates(load)) {
    const elements = elementsOf(load, block.model);
    audit(entry.name + ' block/' + block.id, elements === undefined ? [] : quadsFromElements(elements));
  }

  for (const entity of (atlas && atlas.entities) || []) {
    let quads = [];
    for (const layer of entity.layers || []) {
      const file = path.join(load.assets, 'textures', layer.texture);
      quads = quads.concat(entityQuads(layer.model, file, layer.mode || 'opaque'));
    }
    audit(entry.name + ' entity/' + entity.id, quads);
  }

  for (const [kind, list] of [['biome', (atlas && atlas.biomes) || []],
    ['structure', (atlas && atlas.structures) || []]]) {
    for (const item of list) {
      let quads = [];
      const cache = new Map();
      // Two cells at one coordinate put two blocks in the same space. The
      // depth test then hides whichever loses the tie, so the render disagrees
      // with the palette and nothing says why -- the blood-crystal vein spent a
      // while invisible exactly this way. Catch it here instead.
      const occupied = new Map();
      for (const cell of item.cells || []) {
        const key = cell.at.join(',');
        if (occupied.has(key)) {
          failures.push(entry.name + ' ' + kind + '/' + item.id + ': two blocks share cell '
            + key + ' (' + occupied.get(key) + ' and ' + cell.block + ')');
        }
        occupied.set(key, cell.block);
      }
      for (const cell of item.cells || []) {
        const reference = String(cell.block);
        const colon = reference.indexOf(':');
        const cellNamespace = colon >= 0 ? reference.slice(0, colon) : namespace;
        const cellBlock = colon >= 0 ? reference.slice(colon + 1) : reference;
        const full = cellNamespace + ':' + cellBlock;
        let cellQuads = cache.get(full);
        if (cellQuads === undefined) {
          const cellLoad = preloads.get(cellNamespace);
          if (cellLoad === undefined) {
            failures.push(entry.name + ' ' + kind + '/' + item.id + ': namespace ' + cellNamespace + ' not loaded');
            cellQuads = [];
          } else {
            const elements = elementsOf(cellLoad, 'block/' + cellBlock);
            if (elements === undefined) {
              failures.push(entry.name + ' ' + kind + '/' + item.id + ': no model for cell ' + full);
              cellQuads = [];
            } else {
              cellQuads = quadsFromElements(elements);
            }
          }
          cache.set(full, cellQuads);
        }
        quads = quads.concat(translateQuads(cellQuads, cell.at));
      }
      audit(entry.name + ' ' + kind + '/' + item.id, quads);
    }
  }
}

const width = rows.reduce((max, row) => Math.max(max, String(row[1]).length), 0);
for (const row of rows) {
  console.log('%s  %s  quads=%d textures=%d', row[0], String(row[1]).padEnd(width), row[2], row[3]);
}
console.log('---');
console.log('%d assets, %d failures', rows.length, failures.length);
for (const failure of failures) console.log('FAIL ' + failure);
process.exit(failures.length === 0 ? 0 : 1);
