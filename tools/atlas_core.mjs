/**
 * mc-art asset viewer — geometry + rasteriser.
 *
 * A JavaScript port of the two renderers that were already calibrated against
 * the game's own sources:
 *
 *   vanilla3d/tools/render_block_model.py   -> block models are DATA
 *   vanilla3d/tools/render_entity_model.py  -> entity models are CODE, transcribed
 *
 * Nothing here is remembered: every constant below is copied from those files,
 * which in turn were copied from `ModelBox` / `TexturedQuad` / `ModelRenderer` /
 * `RendererLivingEntity` / `RenderHelper` and from the wiki block-model spec.
 *
 * This module is deliberately pure: no DOM, no Node, no globals beyond Math.
 * That is what lets `tools/atlas_oracle.mjs` render the same scene in Node and
 * diff it against the Python renderer, so the copy in the plugin is proven
 * before a browser ever runs it.
 */

// ---------------------------------------------------------------------------
// small vector helpers
// ---------------------------------------------------------------------------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length = (a) => Math.sqrt(dot(a, a));
function unit(a) {
  const n = length(a);
  return n < 1e-12 ? [0, 0, 0] : mul(a, 1 / n);
}

// ---------------------------------------------------------------------------
// camera — render_block_model.Camera
// ---------------------------------------------------------------------------

export function makeCamera(position, target, width, height, fovY) {
  const fov = fovY === undefined ? Math.PI / 4 : fovY;
  const forward = unit(sub(target, position));
  const right = unit(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const focal = height / 2 / Math.tan(fov / 2);
  return {
    position,
    forward,
    right,
    up,
    width,
    height,
    project(point) {
      const offset = sub(point, position);
      const x = dot(offset, right);
      const y = dot(offset, up);
      const z = dot(offset, forward);
      if (z <= 0.02) return null;
      return [width / 2 + (x * focal) / z, height / 2 - (y * focal) / z, z];
    },
  };
}

/**
 * Orbit camera that frames a bounding box. yaw/pitch in radians, zoom 1 = fit.
 * The viewer only needs "somewhere sensible", so this is our own framing, not a
 * port: the model is what has to match the game, not the hand that holds it.
 */
export function orbitCamera(box, yaw, pitch, zoom, width, height, fovY) {
  const low = box.min;
  const high = box.max;
  const centre = mul(add(low, high), 0.5);
  const radius = Math.max(length(sub(high, low)) / 2, 0.05);
  const fov = fovY === undefined ? Math.PI / 4 : fovY;
  const fit = radius / Math.sin(fov / 2) / (zoom === undefined ? 1 : zoom);
  const cp = Math.cos(pitch);
  const dir = [Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp];
  const position = add(centre, mul(dir, fit * 1.05));
  return makeCamera(position, centre, width, height, fov);
}

export function boxOfQuads(quads) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const quad of quads) {
    for (const p of quad.p) {
      for (let i = 0; i < 3; i++) {
        if (p[i] < min[i]) min[i] = p[i];
        if (p[i] > max[i]) max[i] = p[i];
      }
    }
  }
  if (!isFinite(min[0])) return { min: [-1, -1, -1], max: [1, 1, 1] };
  return { min, max };
}

// ---------------------------------------------------------------------------
// rasteriser — render_block_model.raster and render_entity_model.raster_blend
// ---------------------------------------------------------------------------

function rasterTriangle(state, camera, texture, points, uvs, shade, mode, tint, orthographic) {
  const { colour, depth, width: W, height: H } = state;
  const screen = [];
  for (const point of points) {
    const projected = camera.project(point);
    if (projected === null) return;
    screen.push(projected);
  }
  const [s0, s1, s2] = screen;
  const minx = Math.max(0, Math.floor(Math.min(s0[0], s1[0], s2[0])));
  const maxx = Math.min(W - 1, Math.ceil(Math.max(s0[0], s1[0], s2[0])));
  const miny = Math.max(0, Math.floor(Math.min(s0[1], s1[1], s2[1])));
  const maxy = Math.min(H - 1, Math.ceil(Math.max(s0[1], s1[1], s2[1])));
  if (minx > maxx || miny > maxy) return;
  const area = (s1[0] - s0[0]) * (s2[1] - s0[1]) - (s2[0] - s0[0]) * (s1[1] - s0[1]);
  if (Math.abs(area) < 1e-9) return;

  const tw = texture.width;
  const th = texture.height;
  const data = texture.data;
  const blend = mode === 'blend';

  for (let y = miny; y <= maxy; y++) {
    const gy = y + 0.5;
    for (let x = minx; x <= maxx; x++) {
      const gx = x + 0.5;
      const w0 = ((s1[0] - gx) * (s2[1] - gy) - (s2[0] - gx) * (s1[1] - gy)) / area;
      const w1 = ((s2[0] - gx) * (s0[1] - gy) - (s0[0] - gx) * (s2[1] - gy)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
      // An orthographic camera does no perspective divide, so the texture
      // coordinate is interpolated linearly in screen space; the perspective
      // formula would stretch every face that has depth across it.
      let zs;
      let u;
      let v;
      if (orthographic === true) {
        zs = w0 * s0[2] + w1 * s1[2] + w2 * s2[2];
        if (!(zs > 1e-9)) continue;
        u = w0 * uvs[0][0] + w1 * uvs[1][0] + w2 * uvs[2][0];
        v = w0 * uvs[0][1] + w1 * uvs[1][1] + w2 * uvs[2][1];
      } else {
        const inv = w0 / s0[2] + w1 / s1[2] + w2 / s2[2];
        if (!(inv > 1e-9)) continue;
        zs = 1 / inv;
        u = (w0 * uvs[0][0] / s0[2] + w1 * uvs[1][0] / s1[2] + w2 * uvs[2][0] / s2[2]) / inv;
        v = (w0 * uvs[0][1] / s0[2] + w1 * uvs[1][1] / s1[2] + w2 * uvs[2][1] / s2[2]) / inv;
      }
      let tx = Math.trunc(u * tw);
      let ty = Math.trunc(v * th);
      if (tx < 0) tx = 0; else if (tx > tw - 1) tx = tw - 1;
      if (ty < 0) ty = 0; else if (ty > th - 1) ty = th - 1;
      const index = (ty * tw + tx) * 4;
      const alpha = data[index + 3] / 255;
      if (blend) {
        if (!(alpha > 0)) continue;
        if (!(zs <= depth[y * W + x])) continue;
      } else {
        if (!(alpha >= 0.5)) continue;
        if (!(zs < depth[y * W + x])) continue;
      }
      depth[y * W + x] = zs;
      const target = (y * W + x) * 4;
      const k = shade * (tint === undefined ? 1 : tint);
      const r = (data[index] / 255) * k;
      const g = (data[index + 1] / 255) * k;
      const b = (data[index + 2] / 255) * k;
      if (blend) {
        colour[target] = r * alpha + colour[target] * (1 - alpha);
        colour[target + 1] = g * alpha + colour[target + 1] * (1 - alpha);
        colour[target + 2] = b * alpha + colour[target + 2] * (1 - alpha);
      } else {
        colour[target] = r;
        colour[target + 1] = g;
        colour[target + 2] = b;
      }
      colour[target + 3] = 1;
    }
  }
}

/**
 * Render one scene into an RGBA buffer.
 *
 * @param quads     [{ p: [4 x [x,y,z]], uv: [4 x [u,v]], tex, shade, mode }]
 * @param textures  { id: { width, height, data: Uint8ClampedArray|Uint8Array } }
 */
export function renderScene(options) {
  const width = options.width;
  const height = options.height;
  const background = options.background || [28, 26, 30];
  const colour = new Float64Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    colour[i * 4] = background[0] / 255;
    colour[i * 4 + 1] = background[1] / 255;
    colour[i * 4 + 2] = background[2] / 255;
    colour[i * 4 + 3] = 1;
  }
  const depth = new Float64Array(width * height).fill(Infinity);
  const state = { colour, depth, width, height };
  const camera = options.camera;
  const orthographic = options.orthographic === true;
  for (const quad of options.quads) {
    const texture = options.textures[quad.tex];
    if (texture === undefined) continue;
    const mode = quad.mode || 'opaque';
    const shade = quad.shade === undefined ? 1 : quad.shade;
    const tint = quad.tint;
    for (const indices of [[0, 1, 2], [0, 2, 3]]) {
      rasterTriangle(
        state, camera, texture,
        [quad.p[indices[0]], quad.p[indices[1]], quad.p[indices[2]]],
        [quad.uv[indices[0]], quad.uv[indices[1]], quad.uv[indices[2]]],
        shade, mode, tint, orthographic,
      );
    }
  }
  const bytes = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.max(0, Math.min(255, Math.round(colour[i] * 255)));
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// block geometry — render_block_model.render
// ---------------------------------------------------------------------------

export const FACE_SHADE = { up: 1.0, down: 0.5, north: 0.8, south: 0.8, east: 0.6, west: 0.6 };

/** wiki vertex order per face; uv pattern is (u1,v1),(u1,v2),(u2,v2),(u2,v1). */
export function faceCorners(x1, y1, z1, x2, y2, z2, face) {
  if (face === 'down') return [[x1, y1, z2], [x1, y1, z1], [x2, y1, z1], [x2, y1, z2]];
  if (face === 'up') return [[x1, y2, z1], [x1, y2, z2], [x2, y2, z2], [x2, y2, z1]];
  if (face === 'north') return [[x2, y2, z1], [x2, y1, z1], [x1, y1, z1], [x1, y2, z1]];
  if (face === 'south') return [[x1, y2, z2], [x1, y1, z2], [x2, y1, z2], [x2, y2, z2]];
  if (face === 'west') return [[x1, y2, z1], [x1, y1, z1], [x1, y1, z2], [x1, y2, z2]];
  return [[x2, y2, z2], [x2, y1, z2], [x2, y1, z1], [x2, y2, z1]];
}

export function rotateAbout(point, origin, axis, degrees) {
  if (!degrees) return point;
  const angle = (degrees * Math.PI) / 180;
  const p = sub(point, origin);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  let rotated;
  if (axis === 'x') rotated = [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c];
  else if (axis === 'y') rotated = [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
  else rotated = [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]];
  return add(rotated, origin);
}

/**
 * Block elements -> quads. Each element face must already carry a resolved
 * texture id (`tex`) and a 16-unit `uv`.
 *
 * A plane with two faces (a cross plant is two crossed planes, each carrying a
 * north AND a south face) would otherwise be drawn twice at *identical* depth,
 * and the strict depth test then decides per pixel on floating-point noise --
 * which shows up as a horizontally mirrored speckle, because the two faces
 * wind opposite ways.  The game keeps the first and rejects the tie, so the
 * same duplicate is dropped here.  Nothing is lost: this rasteriser has no
 * back-face culling, so one quad is already visible from both sides.
 */
export function quadsFromElements(elements) {
  const quads = [];
  for (const element of elements) {
    const [x1, y1, z1] = element.from;
    const [x2, y2, z2] = element.to;
    const rotation = element.rotation;
    const emitted = {};
    for (const face of Object.keys(element.faces || {})) {
      const data = element.faces[face];
      if (data === undefined || data.tex === undefined) continue;
      let corners = faceCorners(x1, y1, z1, x2, y2, z2, face);
      if (rotation) {
        for (let i = 0; i < 4; i++) {
          corners[i] = rotateAbout(
            corners[i], rotation.origin || [0, 0, 0],
            rotation.axis || 'y', rotation.angle || 0,
          );
        }
      }
      corners = corners.map((p) => [p[0] / 16, p[1] / 16, p[2] / 16]);
      const uv = data.uv || [0, 0, 16, 16];
      const base = [[uv[0], uv[1]], [uv[0], uv[3]], [uv[2], uv[3]], [uv[2], uv[1]]];
      const steps = Math.trunc(data.rotation || 0) / 90;
      const uvs = [0, 1, 2, 3].map((index) => {
        const pick = base[((index - steps) % 4 + 4) % 4];
        return [pick[0] / 16, pick[1] / 16];
      });
      const fingerprint = corners
        .map((p) => p[0].toFixed(6) + ',' + p[1].toFixed(6) + ',' + p[2].toFixed(6))
        .sort()
        .join('|') + '#' + uvs.map((pair) => pair[0] + ',' + pair[1]).join('|')
        + '#' + data.tex;
      if (emitted[fingerprint] === true) continue;
      emitted[fingerprint] = true;
      const shade = element.shade === false ? 1.0 : FACE_SHADE[face];
      quads.push({ p: corners, uv: uvs, tex: data.tex, shade, mode: 'opaque' });
    }
  }
  return quads;
}

/** Translate a quad list — one block's geometry placed at a world cell. */
export function translateQuads(quads, offset) {
  if (!offset || (offset[0] === 0 && offset[1] === 0 && offset[2] === 0)) return quads;
  return quads.map((quad) => ({
    p: quad.p.map((p) => [p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]]),
    uv: quad.uv,
    tex: quad.tex,
    shade: quad.shade,
    mode: quad.mode,
    tint: quad.tint,
  }));
}

// ---------------------------------------------------------------------------
// block model resolution — parent chain, with the vanilla parents built in
// ---------------------------------------------------------------------------

const FACE_ORDER = ['down', 'up', 'north', 'south', 'west', 'east'];

function cubeElements(pick) {
  const faces = {};
  for (const face of FACE_ORDER) faces[face] = { texture: pick[face], uv: [0, 0, 16, 16] };
  return [{ from: [0, 0, 0], to: [16, 16, 16], faces }];
}

const CROSS_ELEMENTS = [
  {
    from: [0.8, 0, 8], to: [15.2, 16, 8],
    rotation: { origin: [8, 8, 8], axis: 'y', angle: 45, rescale: true }, shade: false,
    faces: {
      north: { uv: [0, 0, 16, 16], texture: '#cross' },
      south: { uv: [0, 0, 16, 16], texture: '#cross' },
    },
  },
  {
    from: [8, 0, 0.8], to: [8, 16, 15.2],
    rotation: { origin: [8, 8, 8], axis: 'y', angle: 45, rescale: true }, shade: false,
    faces: {
      west: { uv: [0, 0, 16, 16], texture: '#cross' },
      east: { uv: [0, 0, 16, 16], texture: '#cross' },
    },
  },
];

/**
 * The vanilla parents, written out. These five are fixed by the game, so having
 * them here is not a guess -- and it keeps the viewer working with nothing but
 * the project's own pack on disk.
 */
export const VANILLA_PARENTS = {
  // Kept in step with the copy inside `mcart-plugin/host.js`; the drift check
  // compares the two as data.  Both follow the 1.18.2 jar, and the shape matters:
  // `block/cube_all` ships no `elements` of its own, it maps keys onto
  // `block/cube`, and `block/block` is where `display.gui` lives -- which is what
  // tells the item icon which way a block item is drawn.
  'block/block': { textures: {}, gui_light: 'side', display: { gui: {
    rotation: [30, 225, 0], translation: [0, 0, 0], scale: [0.625, 0.625, 0.625] } } },
  'block/cube': { parent: 'block/block', textures: { particle: '#north' },
    elements: cubeElements({ down: '#down', up: '#up', north: '#north',
      south: '#south', west: '#west', east: '#east' }) },
  'block/cube_all': { parent: 'block/cube', textures: { particle: '#all', down: '#all', up: '#all',
    north: '#all', south: '#all', west: '#all', east: '#all' } },
  'block/cube_column': { parent: 'block/cube', textures: { particle: '#side', end: '#end', side: '#side',
    down: '#end', up: '#end', north: '#side', south: '#side', west: '#side', east: '#side' } },
  'block/cube_bottom_top': { parent: 'block/cube', textures: { particle: '#side', bottom: '#bottom',
    top: '#top', side: '#side', down: '#bottom', up: '#top', north: '#side',
    south: '#side', west: '#side', east: '#side' } },
  'block/cross': { textures: { particle: '#cross' }, elements: CROSS_ELEMENTS },
  'block/tinted_cross': { parent: 'block/cross', textures: {} },
};

const EMPTY_PARENT = { textures: {} };

/**
 * Resolve one block model JSON into concrete elements.
 *
 * @param model        the parsed `models/block/<id>.json`
 * @param loadParent   (parentId) => parsed JSON | undefined
 * @param resolveTexture (reference) => texture id | undefined
 */
export function resolveBlockModel(model, loadParent, resolveTexture) {
  const chain = [];
  let node = model;
  const seen = {};
  for (let depth = 0; depth < 8 && node !== undefined; depth++) {
    chain.push(node);
    const parent = node.parent;
    if (typeof parent !== 'string' || seen[parent] === true) break;
    seen[parent] = true;
    node = loadParent(parent) || VANILLA_PARENTS[parent] || EMPTY_PARENT;
  }
  // textures merge parent-first, child wins
  const textures = {};
  for (let i = chain.length - 1; i >= 0; i--) {
    const table = chain[i].textures;
    if (table) for (const key of Object.keys(table)) textures[key] = table[key];
  }
  // the nearest node that declares elements owns the geometry
  let elements;
  for (const node2 of chain) {
    if (Array.isArray(node2.elements) && node2.elements.length > 0) {
      elements = node2.elements;
      break;
    }
  }
  if (elements === undefined) return undefined;

  const dereference = (reference) => {
    let name = String(reference === undefined ? '' : reference);
    for (let i = 0; i < 8 && name.charAt(0) === '#'; i++) {
      const next = textures[name.slice(1)];
      if (next === undefined) break;
      name = String(next);
    }
    return resolveTexture(name);
  };

  const out = elements.map((element) => {
    const faces = {};
    for (const face of Object.keys(element.faces || {})) {
      const data = element.faces[face];
      const tex = dereference(data.texture);
      if (tex === undefined) continue;
      faces[face] = { tex, uv: data.uv || [0, 0, 16, 16], rotation: data.rotation || 0 };
    }
    return {
      from: element.from,
      to: element.to,
      rotation: element.rotation,
      shade: element.shade,
      faces,
    };
  });
  return out;
}

// ---------------------------------------------------------------------------
// entity geometry — render_entity_model.iter_quads
// ---------------------------------------------------------------------------

/** RendererLivingEntity translates by this after scale(-1,-1,1). */
export const FOOT_OFFSET = 1.5078125;

const LIGHT0 = unit([0.2, 1.0, -0.7]);
const LIGHT1 = unit([-0.2, 1.0, 0.7]);

/** model units -> game blocks (x east, y up, z south). */
export function toWorld(point) {
  return [point[0] / 16, FOOT_OFFSET - point[1] / 16, -point[2] / 16];
}

export function entityShade(normal) {
  const d0 = Math.max(0, dot(normal, LIGHT0));
  const d1 = Math.max(0, dot(normal, LIGHT1));
  return 0.4 + 0.6 * (d0 + d1);
}

/** ModelRenderer.render: pivot + Rz*Ry*Rx*point. */
export function place(point, pivot, rotation) {
  let p = point;
  for (const axis of ['z', 'y', 'x']) {
    const degrees = rotation === undefined ? 0 : (rotation[axis] || 0);
    if (degrees) p = rotateAbout(p, [0, 0, 0], axis, degrees);
  }
  return add(p, pivot);
}

export function modelCorners(x1, y1, z1, x2, y2, z2) {
  return {
    A: [x1, y1, z1], B: [x2, y1, z1], C: [x2, y2, z1], D: [x1, y2, z1],
    E: [x1, y1, z2], F: [x2, y1, z2], G: [x2, y2, z2], H: [x1, y2, z2],
  };
}

/** name, corner keys in ModelBox's quadList order, texture rect relative to (u,v). */
export const ENTITY_QUADS = [
  ['right', 'FBCG', (u, v, w, h, d) => [u + d + w, v + d, u + d + w + d, v + d + h]],
  ['left', 'AEHD', (u, v, w, h, d) => [u, v + d, u + d, v + d + h]],
  ['top', 'FEAB', (u, v, w, h, d) => [u + d, v, u + d + w, v + d]],
  ['bottom', 'CDHG', (u, v, w, h, d) => [u + d + w, v + d, u + d + w + w, v]],
  ['front', 'BADC', (u, v, w, h, d) => [u + d, v + d, u + d + w, v + d + h]],
  ['back', 'EFGH', (u, v, w, h, d) => [u + 2 * d + w, v + d, u + 2 * d + w + w, v + d + h]],
];

/**
 * One entity model spec -> quads, in world space and already posed.
 * @param spec  { tex: [w,h], parts: [{ name, pivot, rot, boxes }] }
 */
export function entityQuads(spec, texId, mode) {
  const quads = [];
  const texW = (spec.tex && spec.tex[0]) || 64;
  const texH = (spec.tex && spec.tex[1]) || 32;
  for (const part of spec.parts) {
    const pivot = part.pivot || [0, 0, 0];
    const rotation = part.rot || {};
    for (const box of part.boxes) {
      const [ox, oy, oz] = box.at;
      const w = box.w;
      const h = box.h;
      const d = box.d;
      const inflate = box.inflate || 0;
      const table = modelCorners(
        ox - inflate, oy - inflate, oz - inflate,
        ox + w + inflate, oy + h + inflate, oz + d + inflate,
      );
      for (const entry of ENTITY_QUADS) {
        const name = entry[0];
        const keys = entry[1];
        const rect = entry[2](box.u, box.v, w, h, d);
        const modelPts = [0, 1, 2, 3].map((i) => place(table[keys.charAt(i)], pivot, rotation));
        const world = modelPts.map(toWorld);
        // TexturedQuad.draw: normal = (p2 - p1) x (p0 - p1)
        const normal = unit(toWorld(cross(sub(modelPts[2], modelPts[1]), sub(modelPts[0], modelPts[1]))));
        // TexturedQuad ctor: [0]=(u2,v1) [1]=(u1,v1) [2]=(u1,v2) [3]=(u2,v2)
        const u1 = rect[0], v1 = rect[1], u2 = rect[2], v2 = rect[3];
        const pairs = [[u2, v1], [u1, v1], [u1, v2], [u2, v2]];
        const uvs = pairs.map((pair) => [pair[0] / texW, pair[1] / texH]);
        quads.push({ p: world, uv: uvs, tex: texId, shade: entityShade(normal), mode, name });
      }
    }
  }
  return quads;
}
