// Draw the 2D inventory icons the CLIENT would draw, into one PNG sheet, so the
// thing under discussion can be looked at instead of argued about.
//
//   node tools/mcart-plugin/icon-sheet.js [--out /tmp/icons.png] [--size 64]
//        [--project fleshland] [--root /home/gmh/mc-art]
//        [--source project|reference] [--namespace minecraft] [--items a,b] [--limit 40]
//
// It runs the REAL host handlers (one extractor process for the page) and the
// REAL client drawing code, sliced out of client.js -- a re-implementation here
// would be able to disagree with what actually runs.
//
// The textures arrive from the host as `data:image/png;base64,...`; they are
// decoded with the small PNG codec below (zlib + unfilter, colour types
// grey/RGB/palette/grey+alpha/RGBA at 8 bits -- everything vanilla and these
// packs use).
const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')

const { handlers } = require(process.env.MCART_RUN || './run.js')
const CLIENT = process.env.MCART_CLIENT || path.join(__dirname, 'client.js')

// --------------------------------------------------------------------------
// a canvas stand-in with real pixels (the browser gives the client one)
function fakeCanvas(width, height) {
  const data = new Uint8ClampedArray(width * height * 4)
  function blit(node, args) {
    const src = node._pixels
    if (src === undefined) return
    const sw0 = node.naturalWidth
    const sh0 = node.naturalHeight
    let sx = 0, sy = 0, sw = sw0, sh = sh0, dx = 0, dy = 0, dw = width, dh = height
    if (args.length >= 8) { sx = args[0]; sy = args[1]; sw = args[2]; sh = args[3]; dx = args[4]; dy = args[5]; dw = args[6]; dh = args[7] }
    else if (args.length === 4) { dx = args[0]; dy = args[1]; dw = args[2]; dh = args[3] }
    for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
      const px = Math.round(dx + x), py = Math.round(dy + y)
      if (px < 0 || py < 0 || px >= width || py >= height) continue
      const u = Math.floor(sx + ((x + 0.5) * sw) / dw)
      const v = Math.floor(sy + ((y + 0.5) * sh) / dh)
      if (u < 0 || v < 0 || u >= sw0 || v >= sh0) continue
      const from = (v * sw0 + u) * 4
      const to = (py * width + px) * 4
      const alpha = src[from + 3] / 255
      if (alpha <= 0) continue
      for (let c = 0; c < 3; c++) data[to + c] = Math.round(src[from + c] * alpha + data[to + c] * (1 - alpha))
      data[to + 3] = Math.max(data[to + 3], src[from + 3])
    }
  }
  const context = {
    imageSmoothingEnabled: true,
    clearRect: () => { data.fill(0) },
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (frame) => { data.set(frame.data.subarray(0, data.length)) },
    drawImage: function (node) { blit(node, Array.prototype.slice.call(arguments, 1)) },
  }
  return { width: width, height: height, _data: data,
    getContext: () => context, toDataURL: () => 'data:image/png;base64,' }
}

function loadClient(patches) {
  let source = fs.readFileSync(CLIENT, 'utf8')
  for (const patch of patches || []) source = source.replace(patch[0], patch[1])
  const start = source.indexOf('const sub =')
  const end = source.indexOf('const CSS = [')
  const failureAt = source.indexOf('function failureOf(')
  const commentAt = source.lastIndexOf('/**', failureAt)
  const commentEnd = commentAt < 0 ? -1 : source.indexOf('*/', commentAt)
  const counts = source.slice(commentEnd >= 0 && commentEnd < failureAt ? commentAt : failureAt,
    source.indexOf('function cssColour'))
  const body = 'let animTicks = 0\n' + source.slice(start, end) + counts
  return new Function('document', body + `
    return { drawItemIcon: drawItemIcon, itemIconUrl: itemIconUrl, GUI_FACE_SHADE: GUI_FACE_SHADE,
      setTicks: function (value) { animTicks = value } }`)({ createElement: () => fakeCanvas(32, 32) })
}

// --------------------------------------------------------------------------
// PNG in / out (8-bit, non-interlaced: grey, RGB, palette, grey+alpha, RGBA)
function readPng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG')
  let at = 8
  let width = 0, height = 0, depth = 8, colour = 6, interlace = 0
  let palette = null, transparency = null
  const parts = []
  while (at + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(at)
    const kind = buffer.toString('latin1', at + 4, at + 8)
    const body = buffer.subarray(at + 8, at + 8 + length)
    if (kind === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4)
      depth = body[8]; colour = body[9]; interlace = body[12]
    } else if (kind === 'PLTE') palette = Buffer.from(body)
    else if (kind === 'tRNS') transparency = Buffer.from(body)
    else if (kind === 'IDAT') parts.push(Buffer.from(body))
    else if (kind === 'IEND') break
    at += 12 + length
  }
  if (interlace !== 0) throw new Error('隔行 PNG 未支持')
  if (depth !== 8) throw new Error('位深 ' + depth + ' 未支持')
  const raw = zlib.inflateSync(Buffer.concat(parts))
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colour]
  if (channels === undefined) throw new Error('颜色类型 ' + colour + ' 未支持')
  const stride = width * channels
  const out = new Uint8ClampedArray(width * height * 4)
  const prior = new Uint8Array(stride)
  const line = new Uint8Array(stride)
  let cursor = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[cursor++]
    for (let i = 0; i < stride; i++) {
      const value = raw[cursor + i]
      const left = i >= channels ? line[i - channels] : 0
      const up = prior[i]
      const upLeft = i >= channels ? prior[i - channels] : 0
      let add = 0
      if (filter === 1) add = left
      else if (filter === 2) add = up
      else if (filter === 3) add = (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft)
        add = pa <= pb && pa <= pc ? left : (pb <= pc ? up : upLeft)
      }
      line[i] = (value + add) & 255
    }
    cursor += stride
    for (let x = 0; x < width; x++) {
      const to = (y * width + x) * 4
      if (colour === 6) { out[to] = line[x * 4]; out[to + 1] = line[x * 4 + 1]; out[to + 2] = line[x * 4 + 2]; out[to + 3] = line[x * 4 + 3] }
      else if (colour === 2) { out[to] = line[x * 3]; out[to + 1] = line[x * 3 + 1]; out[to + 2] = line[x * 3 + 2]; out[to + 3] = 255 }
      else if (colour === 4) { out[to] = out[to + 1] = out[to + 2] = line[x * 2]; out[to + 3] = line[x * 2 + 1] }
      else if (colour === 0) { out[to] = out[to + 1] = out[to + 2] = line[x]; out[to + 3] = 255 }
      else {
        const index = line[x]
        out[to] = palette[index * 3]; out[to + 1] = palette[index * 3 + 1]; out[to + 2] = palette[index * 3 + 2]
        out[to + 3] = transparency !== null && index < transparency.length ? transparency[index] : 255
      }
    }
    prior.set(line)
  }
  return { width: width, height: height, data: out }
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(kind, body) {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(body.length, 0)
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(kind, 'latin1'), body])), 0)
  return Buffer.concat([head, Buffer.from(kind, 'latin1'), body, tail])
}

function writePng(width, height, data) {
  const raw = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    for (let x = 0; x < width * 4; x++) raw[y * (width * 4 + 1) + 1 + x] = data[y * width * 4 + x]
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

// --------------------------------------------------------------------------
// `--pair`: each item gets TWO cells -- its first texture scaled to the cell
// size, then the icon the client draws.  "The icon does not look like the
// texture" is the actual complaint this is for, so both pictures sit side by
// side instead of one being remembered.
function scaleNearest(image, size) {
  const out = new Uint8ClampedArray(size * size * 4)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = Math.floor((x * image.width) / size)
    const v = Math.floor((y * image.height) / size)
    const from = (v * image.width + u) * 4
    const to = (y * size + x) * 4
    out[to] = image.data[from]; out[to + 1] = image.data[from + 1]
    out[to + 2] = image.data[from + 2]; out[to + 3] = image.data[from + 3]
  }
  return out
}

// A coarse text picture of one cell: for each block of the cell, the mean of its
// opaque pixels as a luminance bucket, or `.` when the block is transparent.
// This is how a drawn icon gets READ instead of squinted at -- a checker painted
// behind transparency would otherwise dominate the read.
function asciiOf(pixels, size, cells, x0) {
  const step = size / cells
  const rows = []
  for (let gy = 0; gy < cells; gy++) {
    let line = ''
    for (let gx = 0; gx < cells; gx++) {
      let r = 0, g = 0, b = 0, opaque = 0, total = 0
      for (let y = Math.floor(gy * step); y < Math.floor((gy + 1) * step); y++) {
        for (let x = Math.floor(gx * step); x < Math.floor((gx + 1) * step); x++) {
          const at = (y * size + x) * 4
          total += 1
          if (pixels[at + 3] <= 127) continue
          r += pixels[at]; g += pixels[at + 1]; b += pixels[at + 2]; opaque += 1
        }
      }
      if (opaque < total / 2) { line += '.'; continue }
      const lum = Math.round((r * 299 + g * 587 + b * 114) / (1000 * opaque))
      line += lum < 60 ? '#' : lum < 110 ? '+' : lum < 170 ? 'o' : lum < 215 ? 'O' : '@'
    }
    rows.push(line)
  }
  return rows
}

function parseArgs(argv) {
  const out = { out: path.join(os.tmpdir(), 'mcart-icons.png'), size: 64, project: 'fleshland',
    root: '/home/gmh/mc-art', source: 'project', namespace: '', items: '', limit: 40,
    pair: false, plain: false, ascii: false, patch: [] }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--out') out.out = argv[++i]
    else if (token === '--size') out.size = Number(argv[++i])
    else if (token === '--project') out.project = argv[++i]
    else if (token === '--root') out.root = argv[++i]
    else if (token === '--source') out.source = argv[++i]
    else if (token === '--namespace') out.namespace = argv[++i]
    else if (token === '--items') out.items = argv[++i]
    else if (token === '--limit') out.limit = Number(argv[++i])
    else if (token === '--pair') out.pair = true
    else if (token === '--plain') out.plain = true
    else if (token === '--ascii') out.ascii = true
    else if (token === '--patch') out.patch.push([argv[++i], argv[++i]])
  }
  return out
}



async function main() {
  const args = parseArgs(process.argv.slice(2))
  const root = args.root
  // `atlas.refItems` needs the namespace; the project's own namespace comes from
  // the index, which is what the picker reads too.
  let namespace = args.namespace
  if (namespace === '') {
    const scan = await handlers['atlas.scan']({ root: root })
    const found = (scan.projects || []).filter((project) => project.id === args.project)[0]
    if (found === undefined) { console.error('项目里没有 ' + args.project); return 2 }
    namespace = found.namespace
  }
  const list = await handlers['atlas.refItems']({ root: root, project: args.project,
    source: args.source, namespace: namespace })
  if (list.error !== undefined) { console.error('refItems:', list.error); return 2 }
  let items = (list.items || []).filter((entry) => entry.parentOnly !== true)
  if (args.items !== '') {
    const wanted = args.items.split(',')
    items = items.filter((entry) => wanted.indexOf(entry.id) >= 0)
  } else {
    items = items.slice(0, args.limit)
  }
  if (items.length === 0) { console.error('没有物品'); return 2 }

  const page = await handlers['atlas.itemIcons']({ root: root, project: args.project,
    source: args.source, namespace: list.namespace, items: items.map((entry) => entry.id) })
  if (page.error !== undefined) { console.error('itemIcons:', page.error); return 2 }

  const api = loadClient(args.patch)
  const size = args.size
  const perItem = args.pair ? 2 : 1
  const shown = Math.min(items.length * perItem, 8)
  const columns = Math.max(1, Math.floor(shown / perItem) * perItem)
  const cells = items.length * perItem
  const rows = Math.ceil(cells / columns)
  const sheet = new Uint8ClampedArray(columns * size * rows * size * 4)
  const notes = []

  function paste(cell, index) {
    const cx = (index % columns) * size
    const cy = Math.floor(index / columns) * size
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const from = (y * size + x) * 4
        const to = ((cy + y) * (columns * size) + cx + x) * 4
        sheet[to] = cell[from]; sheet[to + 1] = cell[from + 1]
        sheet[to + 2] = cell[from + 2]; sheet[to + 3] = cell[from + 3]
        if (cell[from + 3] < 40 && args.plain !== true) {
          // a faint checker behind transparent pixels, so "blank" is visible
          const on = ((x >> 3) + (y >> 3)) & 1
          sheet[to] = sheet[to + 1] = sheet[to + 2] = on ? 90 : 55
          sheet[to + 3] = 255
        }
      }
    }
  }

  for (let index = 0; index < items.length; index++) {
    const entry = items[index]
    const recipe = (page.items || {})[entry.id]
    const cell = fakeCanvas(size, size)
    const decoded = {}
    const nodes = {}
    for (const id of (recipe === undefined ? [] : (recipe.textureIds || []))) {
      const url = recipe.textures[id]
      if (typeof url !== 'string') continue
      const comma = url.indexOf(',')
      const image = readPng(Buffer.from(url.slice(comma + 1), 'base64'))
      decoded[id] = { width: image.width, height: image.height, data: image.data }
      nodes[id] = { complete: true, naturalWidth: image.width, naturalHeight: image.height,
        _pixels: image.data }
    }
    // No <img> nodes: the panel drops them once a texture is decoded, so the
    // icon path reads `decoded` only -- and so does this.
    api.drawItemIcon(cell, recipe, 0, decoded)
    if (args.pair) {
      const first = (recipe === undefined ? [] : (recipe.textureIds || []))[0]
      paste(first === undefined ? new Uint8ClampedArray(size * size * 4)
        : scaleNearest(decoded[first], size), index * 2)
    }
    paste(cell._data, index * 2 + (args.pair ? 1 : 0))
    if (args.ascii) {
      console.log('--- ' + entry.id + ' 画出来的（' + size + 'px 里的 16×16）')
      console.log(asciiOf(cell._data, size, 16, 0).map((line) => '    ' + line).join('\n'))
      const first = (recipe === undefined ? [] : (recipe.textureIds || []))[0]
      if (args.pair && first !== undefined) {
        console.log('--- ' + entry.id + ' 贴图本身')
        console.log(asciiOf(scaleNearest(decoded[first], size), size, 16, 0)
          .map((line) => '    ' + line).join('\n'))
      }
    }
    const shape = recipe === undefined ? 'missing' : recipe.shape
    const display = recipe === undefined ? '' : (recipe.display === null || recipe.display === undefined
      ? 'no-display' : JSON.stringify(recipe.display.rotation))
    notes.push('  ' + String(index).padStart(2) + ' ' + entry.id + ' [' + shape + ' ' + display
      + ' tex ' + Object.keys(decoded).length + '/' + ((recipe && recipe.textureIds) || []).length + ']')
  }

  fs.writeFileSync(args.out, writePng(columns * size, rows * size, sheet))
  console.log('表：%s（%d 列 × %d 行，每格 %dpx）', args.out, columns, rows, size)
  console.log('顺序（从左到右、从上到下）：')
  console.log(notes.join('\n'))
  return 0
}

main().then((code) => process.exit(code))
  .catch((error) => { console.error(error && error.stack ? error.stack : error); process.exit(2) })
