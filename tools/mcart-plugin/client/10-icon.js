/** One icon frame into a canvas.  `decoded` holds one entry per texture id:
 *  the pixels, and whatever else the decode step kept. */
function drawItemIcon(canvas, recipe, frameIndex, decoded) {
  const width = canvas.width, height = canvas.height
  const paint = canvas.getContext('2d')
  paint.clearRect(0, 0, width, height)
  if (recipe === null || recipe === undefined) return
  if (recipe.shape === 'iso') {
    // No `display` anywhere in the chain means the game does not transform it
    // either: `block/cross` (the flower/sapling shape) declares none, so its
    // item is drawn straight on.  Forcing the 30/225 GUI matrix there shows an
    // angle the game never shows.
    const hasDisplay = recipe.display !== null && recipe.display !== undefined
    const rotation = hasDisplay ? (recipe.display.rotation || [0, 0, 0]) : [0, 0, 0]
    const quads = guiItemRotation(recipe.quads || [], rotation,
      hasDisplay ? GUI_FACE_SHADE : GUI_FACE_SHADE_FLAT)
    if (quads.length === 0) return
    const bytes = renderScene({ width: width, height: height,
      background: [0, 0, 0], backgroundAlpha: 0, orthographic: true,
      camera: iconCamera(quads, width, height, 0.98), quads: quads,
      textures: decoded, animations: recipe.animations || {},
      timeMs: animTicks * 50 })
    const frame = paint.createImageData(width, height)
    frame.data.set(bytes)
    paint.putImageData(frame, 0, 0)
    return
  }
  const frames = recipe.frames && recipe.frames.length > 0 ? recipe.frames : null
  const layers = frames === null ? (recipe.layers || [])
    : (frames[((frameIndex || 0) % frames.length + frames.length) % frames.length].layers || [])
  // Every layer is blitted from the DECODED PIXELS, nearest neighbour, source
  // over.  It used to paste the live <img> with `drawImage`, and that is the whole
  // of "非方块没法显示": the panel removes that <img> as soon as the pixels are
  // decoded (the hidden list skips ids that are already decoded), so from that
  // moment a flat icon had nothing to paste and painted ZERO pixels -- measured,
  // while a cube next to it painted 2744.  Reading only `decoded` makes this path
  // a pure function of the same data the iso path uses, so nothing about the DOM
  // can blank an icon again.
  const out = new Uint8ClampedArray(width * height * 4)
  for (const id of layers) {
    const texture = decoded === undefined ? undefined : decoded[id]
    if (texture === undefined || texture.data === undefined) continue
    const sw = texture.width
    const sh = texture.height
    if (!(sw > 0 && sh > 0)) continue
    const animation = (recipe.animations || {})[id]
    const strip = stripOf({ width: sw, height: sh, animation: animation })
    // A strip sample stays inside one frame; a plain texture is the whole image.
    const top = strip === null ? 0 : animationRow(animation, animTicks * 50) * sw
    const rows = strip === null ? sh : sw
    for (let y = 0; y < height; y++) {
      const sy = top + Math.floor((y * rows) / height)
      if (sy < 0 || sy >= sh) continue
      for (let x = 0; x < width; x++) {
        const sx = Math.floor((x * sw) / width)
        const from = (sy * sw + sx) * 4
        const alpha = texture.data[from + 3] / 255
        if (alpha <= 0) continue
        const to = (y * width + x) * 4
        out[to] = texture.data[from] * alpha + out[to] * (1 - alpha)
        out[to + 1] = texture.data[from + 1] * alpha + out[to + 1] * (1 - alpha)
        out[to + 2] = texture.data[from + 2] * alpha + out[to + 2] * (1 - alpha)
        out[to + 3] = Math.max(out[to + 3], texture.data[from + 3])
      }
    }
  }
  const frame = paint.createImageData(width, height)
  frame.data.set(out)
  paint.putImageData(frame, 0, 0)
}

/** Blank the viewport for a size.  Setting `width`/`height` is what actually
 *  discards the old bitmap (and is why this is not just a `clearRect`): the
 *  canvas may have been sized for a different scene. */
function clearViewport(canvas, width, height) {
  canvas.width = width
  canvas.height = height
  const paint = canvas.getContext('2d')
  if (paint !== null && paint !== undefined) paint.clearRect(0, 0, width, height)
}

/** A data URL for one slot of the grid: the same recipe, frame 0, small. */
function itemIconUrl(recipe, decoded, size) {
  if (recipe === null || recipe === undefined) return null
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  drawItemIcon(canvas, recipe, 0, decoded)
  return canvas.toDataURL('image/png')
}

/** How far up the clicked face the pointer landed, as a 0..1 fraction. */
function faceHitY(quad, pixelX, pixelY, camera) {
  if (quad === undefined || camera === undefined || camera === null) return 0.5
  const screen = []
  for (const point of quad.p) {
    const projected = camera.project(point)
    if (projected === null) return 0.5
    screen.push(projected)
  }
  for (const triangle of [[0, 1, 2], [0, 2, 3]]) {
    const a = screen[triangle[0]], b = screen[triangle[1]], c = screen[triangle[2]]
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])
    if (Math.abs(area) < 1e-9) continue
    const w0 = ((b[0] - pixelX) * (c[1] - pixelY) - (c[0] - pixelX) * (b[1] - pixelY)) / area
    const w1 = ((c[0] - pixelX) * (a[1] - pixelY) - (a[0] - pixelX) * (c[1] - pixelY)) / area
    const w2 = 1 - w0 - w1
    if (w0 < -0.02 || w1 < -0.02 || w2 < -0.02) continue
    const weights = [w0, w1, w2]
    let y = 0
    for (let i = 0; i < 3; i++) y += quad.p[triangle[i]][1] * weights[i]
    const ys = quad.p.map((point) => point[1])
    const min = Math.min(ys[0], ys[1], ys[2], ys[3])
    const max = Math.max(ys[0], ys[1], ys[2], ys[3])
    return max - min < 1e-6 ? 0.5 : (y - min) / (max - min)
  }
  return 0.5
}

/** The derived properties in words, for the one-line summary. */
function variantSummary(axes, props) {
  const parts = []
  for (const axis of axes) {
    const value = props[axis.name]
    if (value === undefined) continue
    parts.push(labelOfAxis(axis.name) + ' ' + labelOfValue(value))
  }
  return parts.length === 0 ? '按方块默认' : parts.join(' · ')
}

