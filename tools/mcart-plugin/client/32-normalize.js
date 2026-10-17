/**
 * Is this reply a failure?  "Has an `error` key" is NOT the same question: the
 * extractor answers `error: null` on purpose for every flat item (no elements is
 * the normal state of a generated item), so a key-exists test turned every flat
 * item into "取不到" -- a tool, a sword, a project's own sprite.
 */
/**
 * 缺失判定与"总取值"。
 *
 * 为什么需要：面板和宿主之间走 JSON，而 **JSON 会把 `undefined` 的字段整条丢掉**。
 * 于是宿主那边的"没有这个字段"到客户端就是 `undefined`，而代码里大量守卫只写了
 * `=== null`（107 处）。用户实测的崩溃就是这么来的：
 *   `const ids = asset.recipe === null ? [] : (asset.recipe.textureIds || [])`
 * `recipe` 不在时是 `undefined`，`=== null` 放它过去 → 读 `.textureIds` 当场抛
 * `Cannot read properties of undefined (reading 'textureIds')`（面板白屏）。
 *
 * 所以形状取值一律走这里：缺失（null/undefined）与非数组都给空数组，永不抛。
 */
const isAbsent = (value) => value === null || value === undefined
const idsOf = (value) => (isAbsent(value) || !Array.isArray(value.textureIds) ? [] : value.textureIds)
const objectOf = (value) => (isAbsent(value) || typeof value !== 'object' ? {} : value)
const arrayOf = (value) => (Array.isArray(value) ? value : [])

/**
 * 把宿主回来的场景**归一化**再存进 state。
 *
 * 为什么在"存"这一侧做：JSON 会丢掉 `undefined` 字段，所以"少一个字段"是常态而不是
 * 异常。以前是把 payload 原样存进 `scene`，之后每个读它的人都得自己防 —— 漏一处就是
 * 一次白屏（用户实测 `asset.recipe` 那处就是这么炸的）。现在存之前补齐：数组字段一律
 * 是数组，对象字段一律是对象，可空的保持 null。
 */
const sceneOf = (payload) => ({
  kind: payload.kind,
  id: payload.id,
  title: payload.title,
  project: payload.project,
  quads: arrayOf(payload.quads),
  textureIds: idsOf(payload),
  textures: objectOf(payload.textures),
  animations: objectOf(payload.animations),
  // 「这张贴图有没有动画描述、读不读得了」——宿主已经查过 `.mcmeta` 时把**真话**放这里
  // （`{ state:'unreadable', text:'…有动画描述文件，但我读不了它…' }`）。屏幕只许照抄它，
  // 不许自己按形状再下一个"没有动画描述"的结论：文件明明在，那句话就是在指责产物。
  animationNotes: objectOf(payload.animationNotes),
  cells: isAbsent(payload.cells) ? null : payload.cells,
  faceStep: payload.faceStep,
  refs: arrayOf(payload.refs),
  ref: isAbsent(payload.ref) ? null : payload.ref,
  palette: arrayOf(payload.palette),
  box: isAbsent(payload.box) ? null : payload.box,
  errors: arrayOf(payload.errors),
  preview: payload.preview === true,
})

function failureOf(reply) {
  if (reply === null || reply === undefined) return '没有返回结果'
  if (reply.error === undefined || reply.error === null) return null
  return String(reply.error)
}

