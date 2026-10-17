const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function toBase64(bytes) {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += BASE64[(n >> 18) & 63] + BASE64[(n >> 12) & 63] + BASE64[(n >> 6) & 63] + BASE64[n & 63]
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i] << 16
    out += BASE64[(n >> 18) & 63] + BASE64[(n >> 12) & 63] + '=='
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += BASE64[(n >> 18) & 63] + BASE64[(n >> 12) & 63] + BASE64[(n >> 6) & 63] + '='
  }
  return out
}

const SQUOTE = String.fromCharCode(39)
const BACKSLASH = String.fromCharCode(92)
const PICK_BEGIN = 'MCART_PICK_BEGIN'
const PICK_END = 'MCART_PICK_END'

function utf16leBase64(text) {
  const bytes = []
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    bytes.push(code & 255, (code >> 8) & 255)
  }
  return toBase64(Uint8Array.from(bytes))
}

function base64OfString(text) {
  return toBase64(new TextEncoder().encode(String(text)))
}

function quoteRaw(b64) {
  return SQUOTE + b64 + SQUOTE
}

function shellDecoded(value) {
  return '"$(printf %s ' + quoteRaw(base64OfString(value)) + ' | base64 -d)"'
}

function parentOf(path) {
  const normalized = String(path).replace(/[\\/]+$/, '')
  const cut = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf(BACKSLASH))
  if (cut < 0) return null
  if (cut === 0) return '/'
  const head = normalized.slice(0, cut)
  const isDrive = head.length === 2 && head.charAt(1) === ':'
  return isDrive ? head + BACKSLASH : head
}

function betweenMarkers(text) {
  const raw = String(text === undefined || text === null ? '' : text)
  const begin = raw.indexOf(PICK_BEGIN)
  const end = raw.lastIndexOf(PICK_END)
  if (begin < 0 || end < 0 || end <= begin) return ''
  return raw.slice(begin + PICK_BEGIN.length, end).trim()
}

function beforeStderr(text) {
  const raw = String(text === undefined || text === null ? '' : text)
  const cut = raw.indexOf('[stderr]')
  return (cut >= 0 ? raw.slice(0, cut) : raw).trim()
}

// Forget the extracted blocks nothing holds any more.
//
// Why this is a function of its own: a `ref:` handle is SHARED.  `prismarine`,
// `prismarine_stairs` and `prismarine_slab` all resolve
// `assets/minecraft/textures/block/prismarine.png`, so all three entries carry
// the same `ref:minecraft:block/prismarine` -- and that one handle holds both
// the picture AND the description of how it animates.  Deleting it because ONE
// of the three was dropped took the animation away from the two that survived,
// and a surviving entry is never re-extracted (`referenceLoad` finds its cache
// entry and returns it), so the block kept drawing from the decoder's pixels
// with no `animations` entry -- which shows up as the whole 16x64 strip squashed
// onto every face, permanently, until the plugin is restarted.
//
// So: work out what the SURVIVORS still need first, then delete only what
// nothing holds.  `list:` entries are the namespace listings and are not
// geometry, so they are never dropped here.
function releaseUnused(referenceBlocks, keep, referenceTextures, referenceAnimations) {
  const doomed = []
  for (const key of Array.from(referenceBlocks.keys())) {
    if (key.indexOf('list:') === 0) continue
    if (keep[key] === true) continue
    doomed.push(key)
  }
  const stillUsed = {}
  for (const key of Array.from(referenceBlocks.keys())) {
    if (key.indexOf('list:') === 0) continue
    if (doomed.indexOf(key) >= 0) continue
    const entry = referenceBlocks.get(key)
    if (entry === undefined || entry.load === undefined || entry.load.textures === undefined) continue
    for (const value of entry.load.textures.values()) stillUsed[value] = true
  }
  let dropped = 0
  for (const key of doomed) {
    const entry = referenceBlocks.get(key)
    if (entry !== undefined && entry.load !== undefined && entry.load.textures !== undefined) {
      for (const value of entry.load.textures.values()) {
        if (stillUsed[value] === true) continue
        referenceTextures.delete(value)
        referenceAnimations.delete(value)
      }
    }
    referenceBlocks.delete(key)
    dropped += 1
  }
  let held = 0
  for (const key of referenceBlocks.keys()) if (key.indexOf('list:') !== 0) held += 1
  return { dropped: dropped, held: held }
}

