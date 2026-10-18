// 设计令牌：**颜色只从这里出**。官方主题 token（DSH client Theme 的 BUILTIN_INSPECT_TOKENS）
// 优先，宿主没提供时回退到中性灰阶/深色可见值（浅色/深色两套都能看）。间距走 4/8 网格，
// 字号/圆角各有一档。目标是"专业工具"（VS Code / Blender 属性面板）的克制感：
// 不用渐变、不用发光、不用多层阴影、不做动画炫技。
//
// 注意：这个文件在绘制片段之后（清单顺序 00-math → 10-icon → 20-const → …），
// icon-test / icon-render-test 用 `const sub =` 到 `const CSS = [` 切片重建绘制区。
const CSS = [
  '.mcart-root{--mc-text:var(--dsw-alias-label-primary,inherit);'
    + '--mc-text-dim:var(--dsw-alias-label-secondary,currentColor);'
    + '--mc-surface:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.07));'
    + '--mc-surface-2:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));'
    + '--mc-border:var(--dsw-alias-border-l1,rgba(127,127,127,.26));'
    + '--mc-border-strong:var(--dsw-alias-border-l2,rgba(127,127,127,.42));'
    + '--mc-brand:var(--dsw-alias-brand-primary,#6aa9ff);'
    + '--mc-error:var(--dsw-alias-state-error-primary,#e06c6c);'
    + '--mc-warn:var(--dsw-alias-state-warn-primary,#e0a06c);'
    + '--mc-ok:var(--dsw-alias-state-success-primary,#7fc98a);'
    + '--mc-idle:var(--dsw-alias-state-idle-primary,rgba(127,127,127,.6));'
    // 官方 token 没有"hover/选中底色"这一类，集中定义一次（中性灰，两种主题都成立）。
    + '--mc-a-2:rgba(127,127,127,.06);--mc-a-5:rgba(127,127,127,.14);'
    + '--mc-a-9:rgba(127,127,127,.26);--mc-a-14:rgba(127,127,127,.42);'
    // 取景框与 HUD 是**内容**不是界面：3D 视口像 Blender 视口一样固定中性深底，
    // HUD 是模仿游戏物品栏的深色玻璃。这两个不做主题双份，集中在这里一次定义。
    + '--mc-canvas-bg:#141317;--mc-hud-bg:rgba(20,20,24,.72);--mc-hud-border:rgba(200,200,210,.32);'
    // 间距 4/8 网格、字号、圆角、行高
    + '--mc-sp-1:4px;--mc-sp-2:8px;--mc-sp-3:12px;--mc-sp-4:16px;'
    + '--mc-fs-xs:10px;--mc-fs-sm:11px;--mc-fs-md:12px;--mc-fs-lg:13px;'
    + '--mc-r-1:4px;--mc-r-2:6px;--mc-r-3:8px;--mc-r-pill:999px;'
    + '--mc-lh:1.45;--mc-focus:2px solid var(--mc-brand);'
    + '--mc-line:1px solid var(--mc-border);--mc-line-strong:1px solid var(--mc-border-strong);'
    // 表单/列表的统一节奏：控件同高、开关缩进、滚动区同一档、顶栏底色
    + '--mc-control-h:26px;--mc-indent:20px;--mc-scroll-h:220px;--mc-scroll-h-sm:124px;'
    + '--mc-header-bg:var(--dsw-alias-bg-base,rgba(24,24,28,.96));'
    + 'display:flex;flex-direction:column;gap:var(--mc-sp-2);padding:var(--mc-sp-3);height:100%;'
    + 'box-sizing:border-box;overflow-y:auto;overflow-x:hidden;color:var(--mc-text);'
    + 'font-size:var(--mc-fs-md);line-height:var(--mc-lh)}',
  // ---- 版式 ---------------------------------------------------------------
  // 顶栏钉在滚动区顶部：面板很长时"设置/物品列表"不跟着滚走（全宽 + 底边）。
  '.mcart-head{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:var(--mc-sp-1);'
    + 'background:var(--mc-header-bg);border-bottom:var(--mc-line);'
    + 'margin:calc(-1 * var(--mc-sp-3)) calc(-1 * var(--mc-sp-3)) 0;'
    + 'padding:var(--mc-sp-2) var(--mc-sp-3)}',
  '.mcart-bar{display:flex;align-items:center;gap:var(--mc-sp-1);flex-wrap:wrap}',
  '.mcart-title{font-size:var(--mc-fs-lg);font-weight:600}',
  '.mcart-sub{color:var(--mc-text-dim);opacity:.85;font-size:var(--mc-fs-sm)}',
  '.mcart-path{color:var(--mc-text-dim);font-size:var(--mc-fs-sm);word-break:break-all;flex:1;min-width:0}',
  '.mcart-group{font-size:var(--mc-fs-xs);letter-spacing:.05em;text-transform:uppercase;'
    + 'color:var(--mc-text-dim);opacity:.8;padding:var(--mc-sp-2) var(--mc-sp-2) var(--mc-sp-1)}',
  '.mcart-id{font-size:var(--mc-fs-xs);color:var(--mc-text-dim);opacity:.8;margin-left:var(--mc-sp-1)}',
  '.mcart-grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.mcart-src{display:flex;align-items:center;gap:var(--mc-sp-1)}',
  '.mcart-tabs{display:flex;gap:var(--mc-sp-1);flex-wrap:wrap;align-items:center}',
  '.mcart-tools{display:flex;gap:var(--mc-sp-1);flex-wrap:wrap;align-items:center}',
  // ---- 三态（空 / 加载 / 错误）一致：同一档字号，错误/警告用状态色 + 左侧细线 ----
  '.mcart-note{color:var(--mc-text-dim);font-size:var(--mc-fs-sm)}',
  '.mcart-hint{font-size:var(--mc-fs-xs);color:var(--mc-text-dim);margin-left:var(--mc-indent);line-height:var(--mc-lh)}',
  '.mcart-empty{font-size:var(--mc-fs-sm);color:var(--mc-text-dim);padding:var(--mc-sp-2);'
    + 'border:1px dashed var(--mc-border);border-radius:var(--mc-r-2);text-align:center}',
  '.mcart-loading{font-size:var(--mc-fs-sm);color:var(--mc-text-dim);opacity:.9}',
  '.mcart-bad,.mcart-err{font-size:var(--mc-fs-sm);word-break:break-all;padding-left:var(--mc-sp-2);'
    + 'border-left:2px solid currentColor;line-height:var(--mc-lh)}',
  '.mcart-bad{color:var(--mc-warn)}',
  '.mcart-err{color:var(--mc-error)}',
  // ---- 可交互控件：hover / active / disabled / focus-visible 四态一致 ----------
  '.mcart-btn{background:var(--mc-a-5);border:var(--mc-line);border-radius:var(--mc-r-2);'
    + 'color:inherit;font:inherit;font-size:var(--mc-fs-sm);padding:var(--mc-sp-1) var(--mc-sp-2);'
    + 'min-height:var(--mc-control-h);box-sizing:border-box;line-height:1.2;'
    + 'cursor:pointer;flex:none;white-space:nowrap}',
  '.mcart-btn:hover{background:var(--mc-a-9)}',
  '.mcart-btn:active{background:var(--mc-a-14)}',
  '.mcart-btn[disabled]{opacity:.4;cursor:default;background:var(--mc-a-2)}',
  '.mcart-tool[data-on="1"]{background:var(--mc-a-14);font-weight:600}',
  '.mcart-icon{background:none;border:0;color:inherit;font:inherit;font-size:var(--mc-fs-lg);'
    + 'line-height:1;padding:var(--mc-sp-1);border-radius:var(--mc-r-2);cursor:pointer;'
    + 'min-width:var(--mc-control-h);min-height:var(--mc-control-h);box-sizing:border-box;'
    + 'display:inline-flex;align-items:center;justify-content:center}',
  '.mcart-icon:hover{background:var(--mc-a-9)}',
  '.mcart-icon[data-on="1"]{background:var(--mc-a-14)}',
  '.mcart-input{flex:1;min-width:0;background:var(--mc-surface);border:var(--mc-line);'
    + 'border-radius:var(--mc-r-2);color:inherit;font:inherit;font-size:var(--mc-fs-sm);'
    + 'padding:var(--mc-sp-1) var(--mc-sp-2);min-height:var(--mc-control-h);'
    + 'box-sizing:border-box;line-height:1.2}',
  '.mcart-input:hover{border-color:var(--mc-border-strong)}',
  '.mcart-input:disabled,.mcart-select:disabled{opacity:.4;cursor:default}',
  '.mcart-select{flex:1;min-width:0;background:var(--mc-surface);border:var(--mc-line);'
    + 'border-radius:var(--mc-r-2);color:inherit;font:inherit;font-size:var(--mc-fs-sm);'
    + 'padding:var(--mc-sp-1);min-height:var(--mc-control-h);box-sizing:border-box;line-height:1.2}',
  '.mcart-select:hover{border-color:var(--mc-border-strong)}',
  '.mcart-btn:focus-visible,.mcart-icon:focus-visible,.mcart-input:focus-visible,'
    + '.mcart-select:focus-visible,.mcart-item:focus-visible,.mcart-slot:focus-visible,'
    + '.mcart-hudslot:focus-visible,.mcart-swatch:focus-visible,.mcart-picker:focus-visible,'
    + '.mcart-hudpage:focus-visible{outline:var(--mc-focus);outline-offset:1px}',
  // ---- 面板/卡片/列表 -----------------------------------------------------
  '.mcart-card{border:var(--mc-line);border-radius:var(--mc-r-3);padding:var(--mc-sp-3);'
    + 'display:flex;flex-direction:column;gap:var(--mc-sp-2);background:var(--mc-surface)}',
  '.mcart-list{overflow:auto;border:var(--mc-line);border-radius:var(--mc-r-3);'
    + 'padding:var(--mc-sp-1);max-height:var(--mc-scroll-h)}',
  '.mcart-row{display:flex;align-items:center;gap:var(--mc-sp-1);border-radius:var(--mc-r-2);'
    + 'padding:var(--mc-sp-1)}',
  '.mcart-row:hover{background:var(--mc-a-5)}',
  '.mcart-item{display:block;width:100%;text-align:left;background:none;border:0;'
    + 'border-radius:var(--mc-r-2);color:inherit;font:inherit;font-size:var(--mc-fs-md);'
    + 'padding:var(--mc-sp-1) var(--mc-sp-2);cursor:pointer}',
  '.mcart-item:hover{background:var(--mc-a-5)}',
  '.mcart-item:active{background:var(--mc-a-9)}',
  '.mcart-item[data-on="1"]{background:var(--mc-a-9);font-weight:600}',
  '.mcart-projects{max-height:var(--mc-scroll-h);overflow:auto;display:flex;flex-direction:column;gap:1px;'
    + 'border:var(--mc-line);border-radius:var(--mc-r-3);padding:var(--mc-sp-1)}',
  '.mcart-mods{border:var(--mc-line);border-radius:var(--mc-r-3);padding:var(--mc-sp-1) var(--mc-sp-2);'
    + 'display:flex;flex-direction:column;gap:1px;max-height:var(--mc-scroll-h-sm);overflow:auto}',
  '.mcart-switch{display:grid;grid-template-columns:var(--mc-indent) 1fr;column-gap:var(--mc-sp-2);'
    + 'align-items:start;cursor:pointer;padding:var(--mc-sp-1) 0;border-radius:var(--mc-r-1)}',
  '.mcart-switch input{margin:var(--mc-sp-1) 0 0 0;flex:none;accent-color:var(--mc-brand)}',
  '.mcart-switch:focus-within{outline:var(--mc-focus);outline-offset:1px}',
  // 滚动区统一：细滚动条（颜色走宿主 token）、不要链式滚动、右留一点防贴边。
  '.mcart-list,.mcart-hotbar,.mcart-swatches,.mcart-projects,.mcart-mods{'
    + 'scrollbar-width:thin;scrollbar-color:var(--dsh-scrollbar-thumb,var(--mc-a-14)) transparent;'
    + 'overscroll-behavior:contain;padding-right:var(--mc-sp-1)}',
  '.mcart-chip{font-size:var(--mc-fs-xs);padding:1px var(--mc-sp-2);border-radius:var(--mc-r-pill);'
    + 'background:var(--mc-a-9);color:var(--mc-text-dim)}',
  // ---- 取景框与 3D 视口（内容区：中性深底，不随主题变白） --------------------
  '.mcart-stage{flex:none;display:flex;flex-direction:column;gap:var(--mc-sp-1)}',
  '.mcart-canvas{width:100%;height:240px;display:block;border-radius:var(--mc-r-3);'
    + 'background:var(--mc-canvas-bg);border:var(--mc-line);cursor:grab;touch-action:none}',
  '.mcart-canvas:active{cursor:grabbing}',
  '.mcart-viewport{position:relative;flex:none}',
  '.mcart-zoom{position:absolute;right:var(--mc-sp-1);top:var(--mc-sp-1);display:flex;'
    + 'gap:var(--mc-sp-1);opacity:.8}',
  '.mcart-zoom:hover{opacity:1}',
  '.mcart-zoombtn{width:24px;height:24px;padding:0;display:flex;align-items:center;'
    + 'justify-content:center;font-size:var(--mc-fs-md);line-height:1;background:var(--mc-hud-bg);'
    + 'border-color:var(--mc-hud-border);color:var(--mc-text)}',
  '.mcart-poster{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);'
    + 'image-rendering:pixelated;pointer-events:none}',
  '.mcart-grip{display:flex;align-items:center;justify-content:center;height:13px;'
    + 'cursor:ns-resize;touch-action:none}',
  '.mcart-gripbar{width:48px;height:4px;border-radius:var(--mc-r-pill);background:var(--mc-a-14)}',
  '.mcart-grip:hover .mcart-gripbar{background:var(--mc-a-9)}',
  '.mcart-grip:active .mcart-gripbar{background:var(--mc-brand)}',
  // ---- 游戏物品栏（HUD）：模仿游戏，固定深色玻璃；只借主题的文字色 --------------
  '.mcart-hud{position:absolute;left:0;right:0;bottom:0;display:flex;flex-direction:column;'
    + 'align-items:center;gap:var(--mc-sp-1);padding:0 var(--mc-sp-2) var(--mc-sp-2);pointer-events:none}',
  '.mcart-hudname{font-size:var(--mc-fs-sm);padding:1px var(--mc-sp-2);border-radius:var(--mc-r-pill);'
    + 'background:var(--mc-hud-bg);border:1px solid var(--mc-hud-border)}',
  '.mcart-hudbar{display:flex;align-items:center;gap:var(--mc-sp-1);padding:var(--mc-sp-1);'
    + 'border-radius:var(--mc-r-3);background:var(--mc-hud-bg);border:1px solid var(--mc-hud-border);'
    + 'pointer-events:auto}',
  '.mcart-hudslot{width:34px;height:34px;padding:0;flex:none;display:flex;align-items:center;'
    + 'justify-content:center;border-radius:var(--mc-r-1);border:1px solid var(--mc-hud-border);'
    + 'background:rgba(0,0,0,.32);cursor:pointer}',
  '.mcart-hudslot:hover{border-color:var(--mc-brand);background:var(--mc-a-9)}',
  '.mcart-hudslot[data-on="1"]{border-color:var(--mc-brand);outline:1px solid var(--mc-brand)}',
  '.mcart-hudicon{width:30px;height:30px;display:block;image-rendering:pixelated}',
  '.mcart-hudempty{background:rgba(0,0,0,.22);border-color:rgba(120,120,130,.26);cursor:default}',
  '.mcart-hudpage{width:16px;height:34px;padding:0;flex:none;font:inherit;font-size:var(--mc-fs-md);'
    + 'line-height:1;color:inherit;background:none;border:0;cursor:pointer;opacity:.7}',
  '.mcart-hudpage:hover{opacity:1}',
  '.mcart-hudpage[disabled]{opacity:.22;cursor:default}',
  // ---- 物品栏/九宫格/缩略图 ------------------------------------------------
  '.mcart-hotbar{display:flex;gap:var(--mc-sp-1);flex-wrap:wrap;max-height:var(--mc-scroll-h-sm);overflow:auto}',
  '.mcart-slot{width:28px;height:28px;border:var(--mc-line);border-radius:var(--mc-r-1);'
    + 'background:none;background-size:cover;image-rendering:pixelated;padding:0;flex:none;'
    + 'cursor:pointer}',
  '.mcart-slot:hover{border-color:var(--mc-border-strong);background-color:var(--mc-a-5)}',
  '.mcart-slot:active{background-color:var(--mc-a-9)}',
  '.mcart-slot[data-on="1"]{outline:2px solid var(--mc-brand);outline-offset:1px}',
  '.mcart-slotq{font-size:var(--mc-fs-lg);line-height:1;color:var(--mc-text-dim)}',
  // 缺图标的那一格：说"缺"，不装没事，也别看起来像"还在加载"。
  '.mcart-slotmissing{font-size:var(--mc-fs-xs);font-weight:600;color:var(--mc-warn);letter-spacing:0}',
  '.mcart-slot[data-missing="1"],.mcart-hudslot[data-missing="1"]{'
    + 'border-color:var(--mc-warn);background:rgba(224,160,108,.12)}',
  // ---- 像素编辑器 ----------------------------------------------------------
  '.mcart-edit{display:flex;flex-direction:column;gap:var(--mc-sp-1)}',
  '.mcart-edit-canvas{display:block;width:100%;height:auto;max-height:52vh;object-fit:contain;'
    + 'image-rendering:pixelated;border-radius:var(--mc-r-1);background:var(--mc-canvas-bg);'
    + 'margin:var(--mc-sp-1) 0;cursor:crosshair;touch-action:none}',
  '.mcart-swatches{display:flex;gap:var(--mc-sp-1);flex-wrap:wrap;max-height:56px;overflow:auto}',
  '.mcart-swatch{width:20px;height:20px;border-radius:var(--mc-r-1);border:var(--mc-line);'
    + 'cursor:pointer;padding:0;flex:none}',
  '.mcart-swatch:hover{border-color:var(--mc-border-strong)}',
  '.mcart-color{width:24px;height:24px;border-radius:var(--mc-r-1);border:var(--mc-line);flex:none}',
  '.mcart-picker{width:36px;height:24px;padding:0;border:var(--mc-line);border-radius:var(--mc-r-1);'
    + 'background:none;flex:none;cursor:pointer}',
  '.mcart-alpha{flex:1;min-width:60px;accent-color:var(--mc-brand)}',
  // ---- 引用条 / 报告（只上屏，可复制） --------------------------------------
  '.mcart-ref{display:flex;align-items:center;gap:var(--mc-sp-2);flex-wrap:wrap;'
    + 'margin:0 0 var(--mc-sp-1);padding:var(--mc-sp-2) var(--mc-sp-3);border-radius:var(--mc-r-3);'
    + 'background:var(--mc-surface-2);border:var(--mc-line);font-size:var(--mc-fs-md)}',
  '.mcart-ref-path{color:var(--mc-text-dim);word-break:break-all}',
  '.mcart-report{white-space:pre-wrap;word-break:break-word;background:var(--mc-surface);'
    + 'border:var(--mc-line);border-radius:var(--mc-r-2);padding:var(--mc-sp-2);'
    + 'margin:2px 0;font-size:var(--mc-fs-sm);line-height:var(--mc-lh);max-height:280px;'
    + 'overflow:auto;user-select:text;font-family:inherit}',
  '.mcart-reportnote{font-size:var(--mc-fs-xs);color:var(--mc-text-dim);word-break:break-all}',
].join('')

const CATEGORIES = [
  { key: 'biome', label: '群系' },
  { key: 'structure', label: '结构' },
  { key: 'entity', label: '实体' },
  { key: 'block', label: '方块' },
]

