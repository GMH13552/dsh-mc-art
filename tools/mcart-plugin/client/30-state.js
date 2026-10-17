const TAB_ID = 'mc-art.atlas'

// 最近打开的 project id：换了项目就丢像素缓存（见 forgetTextures）。
let lastProject = ''
const decoded = {}
const failedTex = {}
const indexes = {}
const imageNodes = {}
const drag = { active: false, x: 0, y: 0, moved: 0 }
let pickBuffer = null
// Which ghost request is already on screen (or already in flight).  Kept
// OUTSIDE the ghost object on purpose: it used to live on the ghost as
// `aroundKey`, and the success path replaced the ghost with the host's
// reply -- which has no such field -- so the identity check failed on the
// very next render and asked again.  The ghost flickered forever.  A field
// that one setter forgets is a field that will be forgotten again.
let ghostAsk = ''
// Block icon data URLs, cached per block name across openings of the panel.
const icons = {}
// Names we have already asked about.  Without this a block whose icon cannot be
// produced stays "missing" forever, the icon effect re-fires on every iconTick,
// and the panel spins asking for the same dead names.
const iconTried = {}
// `namespace:item` -> the icon recipe, and its data URL for the grid.  The grid
// draws every slot at once; the big preview keeps the recipe so it can ANIMATE
// (`item/clock` is 64 model swaps, and a mod's item texture may be a strip).
const itemRecipes = {}
const itemUrls = {}
// 取配方失败的那句话。**静默失败在这条路上等于"图标凭空消失"**：`itemRecipes`
// 拿不到，物品浏览器和九宫格就是一片空白，而屏幕上没有任何东西说为什么。
// 模块级（不是 hook 状态）是因为它只在渲染时读一次、由 promise 回调写。
let itemFetchError = ''

/**
 * 丢掉"像素级"缓存：解码好的贴图、标记失败的贴图、烘好的物品图标。
 *
 * 为什么必须要它：场景请求带 `have: Object.keys(decoded)` —— 宿主只送客户端**没有的**
 * 贴图。所以一张图一旦被解码过，**外部改动它就永远看不到**：agent 重新生成纹理、
 * 别的工具写盘，面板照旧显示旧像素。用户实测："agent 改完之后点刷新没有重新加载新的纹理"。
 * 换项目 / 换根目录同理（不同项目可能有同名贴图，缓存按 id 是跨项目的）。
 * 宿主那一侧不用管：它的贴图缓存键是 `path@mtime:size`，文件一变就自然失效。
 */
function forgetTextures() {
  // 像素级：解码好的贴图、标记失败的贴图、烘好的物品图标、按名字烘的方块图标。
  for (const key of Object.keys(decoded)) delete decoded[key]
  for (const key of Object.keys(failedTex)) delete failedTex[key]
  for (const key of Object.keys(itemUrls)) delete itemUrls[key]
  // **按名字记的图标**也必须丢：`icons`/`iconTried` 是"这个方块/物品的图标烘过了"
  // 的账本（左边菜单那些格子就是它）。只丢像素缓存的话，3D 会换新图、菜单图标还是旧的
  // ——用户实测："刷新完全没看到新贴图"，而屏幕左边正是那些图标。
  for (const key of Object.keys(icons)) delete icons[key]
  for (const key of Object.keys(iconTried)) delete iconTried[key]
  // 配方（路径、动画帧）也一起丢：外部重生成可能换了文件名或帧数，留着会指向旧文件。
  for (const key of Object.keys(itemRecipes)) delete itemRecipes[key]
  itemFetchError = ''
  // **故意不丢 `imageNodes`**：那些是 ref 回调登记进来的 <img> 节点，React 不会为同一个
  // 元素再跑一次 ref —— 清掉它们会让解码循环永远等不到 complete。它们在下次渲染时会
  // 带上新的 src（贴图 URL 变了，React 会更新属性）。
}
// The hotbar's slot canvases, keyed like `itemRecipes`.  Module scope for the
// same reason: the draw effect needs them across renders without a state update
// per slot, and a ref callback is what fills them in.
const hudCanvases = {}
const TINT_REMOVE = [0.85, 0.2, 0.18]
// A stroke is one undo step, so the pen has to know whether it is still down.
const painting = { active: false }

const EDIT_ZOOM = 18
const EDIT_UNDO = 24
const EDIT_PALETTE = 64

// The (list, selection) pair the bar has already turned to.  Module scope for the
// same reason `lastDrawKey` is: the effect needs to remember it across renders,
// and putting it in state would re-render to say "no change".
let hudFollowed = ''
// The 3D+hotbar block: default height, and the range the grip may drag it to.
// Generous at the top because the panel scrolls; stingy at the bottom because
// below ~140 px the hotbar covers the model it is supposed to be showing.
const VIEW_H = 240
const VIEW_H_MIN = 140
const VIEW_H_MAX = 760
// The grip drag lives outside React for the same reason `drag` and `painting`
// do: it is read on every pointer move, and a state field read one render late
// is a drag that starts from the wrong height.
const gripDrag = { active: false, y: 0, origin: 0 }
const clampViewH = (value) => Math.max(VIEW_H_MIN, Math.min(VIEW_H_MAX, Math.round(value)))

// Where in a TEXTURE a pointer landed.
//
// The editor canvas is a replaced element: `width:100%`, `height:auto`, capped by
// `max-height:52vh`, and `object-fit:contain`.  So its BOX and its PICTURE are not
// the same rectangle -- as soon as the box is wider than the picture's aspect
// (which is what a wide side panel does), the picture is scaled to the box height
// and centred with margins left and right.  Mapping the whole box put every click
// on the wrong pixel, and the error grew with the panel width -- the case the user
// reported ("我点了a格子 但被上色或者擦掉的是左边的格子 尤其是我把侧边栏拉宽").
// Compute the drawn rectangle first, then map inside it.  `contain` means ONE
// scale for both axes, so a box that already matches the picture's aspect lands
// exactly on the old arithmetic.
function texturePoint(rect, target, clientX, clientY) {
  if (rect === undefined || rect === null) return null
  if (!(rect.width > 0) || !(rect.height > 0)) return null
  if (!(target.w > 0) || !(target.h > 0)) return null
  const scale = Math.min(rect.width / target.w, rect.height / target.h)
  if (!(scale > 0)) return null
  const left = rect.left + (rect.width - target.w * scale) / 2
  const top = rect.top + (rect.height - target.h * scale) / 2
  return [Math.floor((clientX - left) / scale), Math.floor((clientY - top) / scale)]
}

// Blocks per page.  The user's complaint about the first cut ("只显示前面240算什么")
// was right: a bigger ceiling is still a ceiling.  Categories narrow the list and
// the rest is PAGED, so every block is reachable rather than merely present.
const PAGE_SIZE = 20
// Reference textures are HD (AoA3 runs ~12 KB per icon, 17 MB for a whole
// namespace), so icons are fetched a batch at a time and never all at once.
const ICON_BATCH = 80
// The item browser: 40 slots a page (8 x 5).  The hotbar at the bottom of the
// 3D view is the game's OWN number -- nine slots -- because that is what it is
// imitating: one row, one click, the thing you are holding.
const ITEM_PAGE = 40
const HUD_SLOTS = 9

