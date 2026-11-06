// 设计令牌与样式表。**判据是 docs/UI-STYLE.md v2**（向「自媒体工作台」靠近）：
// 卡片化、软阴影、圆角、衬线标题、点阵背景、胶囊控件；颜色/圆角/阴影全部走宿主 token。
//
// 参考实现：本机 `dsh-media-desk`（token 命名照抄，全部映射 --dsw-alias-*）。
// 这个文件在绘制片段之后（清单顺序 00-math → 10-icon → 20-const → …）：
// icon-test / icon-render-test 用 `const sub =` 到 `const CSS = [` 切片重建绘制区。
const CSS = [
  '.mcart-root{'
    // ---- token 层（照抄参考实现命名，全部映射 DSH alias）-------------------
    + '--ink:var(--dsw-alias-label-primary,#ececf1);'
    + '--ink2:var(--dsw-alias-label-secondary,#b9b9c2);'
    + '--ink3:var(--dsw-alias-label-tertiary,#8f8f99);'
    + '--ink4:var(--dsw-alias-label-caption,#7a7a84);'
    + '--on-primary:var(--dsw-alias-label-primary-inverted,#ffffff);'
    + '--primary:var(--dsw-alias-button-primary-fill,#4f9cf9);'
    + '--primary-hover:var(--dsw-alias-button-primary-hover,#6fb0ff);'
    + '--bg:var(--dsw-alias-bg-base,#1b1b1f);'
    + '--card:var(--dsw-alias-bg-layer-2,#26262c);'
    + '--canvas:color-mix(in srgb,var(--ink) 3.5%,var(--bg));'
    + '--line:var(--dsw-alias-border-l2,rgba(255,255,255,.16));'
    + '--line-strong:var(--dsw-alias-border-l4,rgba(255,255,255,.28));'
    + '--hover:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));'
    + '--active:var(--dsw-alias-interactive-bg-active,rgba(255,255,255,.10));'
    + '--accent:var(--dsw-alias-link,#6fb0ff);'
    + '--glass:color-mix(in srgb,var(--card) 72%,transparent);'
    + '--dot:color-mix(in srgb,var(--ink) 6%,transparent);'
    + '--serif:"Songti SC","STSong","Noto Serif SC","Source Han Serif SC",Georgia,serif;'
    + '--ease:cubic-bezier(.2,.8,.2,1);'
    + '--r-xs:var(--dsw-radius-xs,4px);'
    + '--r-sm:var(--dsw-radius-sm,8px);'
    + '--r-md:var(--dsw-radius-md,12px);'
    + '--r-lg:var(--dsw-radius-lg,16px);'
    + '--r-xl:var(--dsw-radius-xl,20px);'
    + '--r-panel:var(--dsw-radius-panel,28px);'
    // ---- 版式：基准 14 / 22，点阵画布 -------------------------------------
    + 'display:flex;flex-direction:column;gap:10px;padding:12px;height:100%;'
    + 'box-sizing:border-box;overflow:hidden;container-type:inline-size;'
    + 'color:var(--ink);background-color:var(--canvas);'
    + 'background-image:radial-gradient(var(--dot) 1px,transparent 1px);'
    + 'background-size:24px 24px;'
    + 'font:14px/22px var(--dsw-font-family,system-ui,-apple-system,"Segoe UI",sans-serif);'
    + '-webkit-font-smoothing:antialiased}',
  // ---- 顶栏：衬线标题 + 胶囊页签 + 圆形图标按钮 ---------------------------
  '.mcart-head{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:10px;'
    + 'padding:4px 0;background:transparent}',
  '.mcart-title{font-family:var(--serif);font-size:16px;line-height:22px;font-weight:600;'
    + 'color:var(--ink);white-space:nowrap}',
  '.mcart-sub{font-size:12px;line-height:18px;color:var(--ink3)}',
  '.mcart-settings-prefix{font-size:12px;line-height:18px;color:var(--ink3)}',
  '.mcart-settings-title{font-family:var(--serif);font-size:15px;line-height:22px;'
    + 'font-weight:600;color:var(--ink);min-width:0;overflow:hidden;text-overflow:ellipsis;'
    + 'white-space:nowrap}',
  '.mcart-headpath{font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:18px;'
    + 'font-variant-numeric:tabular-nums;color:var(--ink3);min-width:0;overflow:hidden;'
    + 'text-overflow:ellipsis;white-space:nowrap}',
  '.mcart-headgrow{flex:1;min-width:8px}',
  // 胶囊页签：容器 --r-sm + --hover 底；选中 --card + --elevation-soft
  '.mcart-tabs{display:flex;gap:2px;padding:4px;border-radius:var(--r-sm);'
    + 'background:var(--hover);flex:none}',
  '.mcart-tab{height:26px;padding:0 10px;border:0;border-radius:var(--r-sm);background:transparent;'
    + 'color:var(--ink3);font:inherit;font-size:13px;line-height:26px;cursor:pointer;'
    + 'transition:background-color 150ms var(--ease),color 150ms var(--ease)}',
  '.mcart-tab:hover{background:var(--hover);color:var(--ink2)}',
  '.mcart-tab[data-on="1"]{background:var(--card);color:var(--ink);'
    + 'box-shadow:var(--dsw-elevation-soft)}',
  // 圆形图标按钮（26px，--hover 底）
  '.mcart-icon{width:26px;height:26px;padding:0;flex:none;display:inline-flex;'
    + 'align-items:center;justify-content:center;border:0;border-radius:999px;'
    + 'background:var(--hover);color:var(--ink2);font:inherit;font-size:14px;line-height:1;'
    + 'cursor:pointer;transition:background-color 150ms var(--ease),transform 120ms var(--ease)}',
  '.mcart-icon:hover{background:var(--active);color:var(--ink)}',
  '.mcart-icon:active{transform:scale(.98)}',
  '.mcart-icon[data-on="1"]{background:var(--card);color:var(--ink);'
    + 'box-shadow:var(--dsw-elevation-soft)}',
  // ---- 卡片：--card / 1px --line / --r-md / --elevation-soft ---------------
  '.mcart-card{background:var(--card);border:1px solid var(--line);border-radius:var(--r-md);'
    + 'box-shadow:var(--dsw-elevation-soft);padding:12px;'
    + 'transition:box-shadow 200ms var(--ease)}',
  '.mcart-head .mcart-btn,.mcart-head .mcart-icon{flex:none}',
  '.mcart-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
  '.mcart-grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  // ---- 资产列表：每类一张卡片（两级：面板 → 卡片，不套娃）------------------
  '.mcart-menu-card{display:flex;flex-direction:column;gap:2px;padding:10px 12px}',
  '.mcart-group{display:flex;flex-direction:column;gap:2px}',
  '.mcart-group-head{display:flex;align-items:baseline;gap:8px;padding:2px 4px 8px;'
    + 'border-bottom:1px solid var(--line);position:sticky;top:0;z-index:1;'
    + 'background:var(--card)}',
  '.mcart-group-title{font-family:var(--serif);font-size:15px;line-height:22px;font-weight:600;'
    + 'color:var(--ink)}',
  '.mcart-group-count{font-family:ui-monospace,Consolas,monospace;font-size:12px;'
    + 'font-variant-numeric:tabular-nums;color:var(--ink3)}',
  '.mcart-item{display:flex;align-items:center;gap:8px;width:100%;height:28px;padding:0 8px;'
    + 'border:0;border-left:2px solid transparent;border-radius:var(--r-sm);background:none;'
    + 'color:var(--ink);font:inherit;font-size:13px;line-height:28px;text-align:left;cursor:pointer;'
    + 'transition:background-color 150ms var(--ease)}',
  '.mcart-item:hover{background:var(--hover)}',
  '.mcart-item:active{background:var(--active)}',
  '.mcart-item[data-on="1"]{background:var(--active);border-left-color:var(--accent)}',
  '.mcart-item-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.mcart-item-id{flex:none;max-width:50%;overflow:hidden;text-overflow:ellipsis;'
    + 'white-space:nowrap;font-family:ui-monospace,Consolas,monospace;font-size:12px;'
    + 'font-variant-numeric:tabular-nums;color:var(--ink3);text-align:right}',
  '.mcart-list{display:flex;flex-direction:column;gap:10px;min-height:0;overflow-y:auto}',
  '.mcart-row{display:flex;align-items:center;gap:8px;height:28px;padding:0 8px;'
    + 'border-left:2px solid transparent;border-radius:var(--r-sm)}',
  '.mcart-row:hover{background:var(--hover)}',
  // ---- 表单控件（13px，28px 高，--r-sm）------------------------------------
  '.mcart-btn{height:28px;padding:0 12px;flex:none;box-sizing:border-box;border:1px solid var(--line);'
    + 'border-radius:var(--r-sm);background:var(--card);color:var(--ink);font:inherit;'
    + 'font-size:13px;line-height:26px;white-space:nowrap;cursor:pointer;'
    + 'transition:background-color 150ms var(--ease),border-color 150ms var(--ease),'
    + 'transform 120ms var(--ease)}',
  '.mcart-btn:hover{background:var(--hover);border-color:var(--line-strong)}',
  '.mcart-btn:active{transform:scale(.98)}',
  '.mcart-btn[disabled]{opacity:.4;cursor:default;background:var(--card)}',
  '.mcart-pill{border-radius:999px;height:34px;padding:0 16px;font-size:13px;line-height:32px}',
  '.mcart-primary{background:var(--primary);border-color:var(--primary);color:var(--on-primary)}',
  '.mcart-primary:hover{background:var(--primary-hover);border-color:var(--primary-hover)}',
  '.mcart-input,.mcart-select{height:28px;box-sizing:border-box;min-width:0;padding:0 10px;'
    + 'border:1px solid var(--line);border-radius:var(--r-sm);background:var(--bg);'
    + 'color:var(--ink);font:inherit;font-size:13px;line-height:26px}',
  '.mcart-input{flex:1}',
  '.mcart-select{flex:1;padding:0 6px;cursor:pointer}',
  '.mcart-input:hover,.mcart-select:hover{border-color:var(--line-strong)}',
  '.mcart-input:disabled,.mcart-select:disabled{opacity:.4;cursor:default}',
  '.mcart-input[type="number"]{text-align:right;font-family:ui-monospace,Consolas,monospace;'
    + 'font-variant-numeric:tabular-nums}',
  '.mcart-input[type="range"],.mcart-alpha{accent-color:var(--primary)}',
  '.mcart-src{display:flex;align-items:center;gap:8px}',
  '.mcart-tabs,.mcart-tools{flex-wrap:nowrap}',
  '.mcart-stack{display:flex;flex-direction:column;align-items:stretch;gap:8px}',
  '.mcart-stack>.mcart-btn{align-self:flex-start}',
  // 焦点：2px accent 半透明外圈（不用发光）
  '.mcart-btn:focus-visible,.mcart-icon:focus-visible,.mcart-tab:focus-visible,'
    + '.mcart-input:focus-visible,.mcart-select:focus-visible,.mcart-item:focus-visible,'
    + '.mcart-slot:focus-visible,.mcart-hudslot:focus-visible,.mcart-swatch:focus-visible,'
    + '.mcart-picker:focus-visible,.mcart-hudpage:focus-visible,.mcart-complain:focus-within,'
    + '.mcart-switch:focus-within{outline:none;'
    + 'box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 50%,transparent)}',
  // ---- 开关与复选框 --------------------------------------------------------
  '.mcart-switch{display:flex;align-items:center;gap:8px;min-height:28px;font-size:13px;'
    + 'line-height:22px;cursor:pointer}',
  '.mcart-switch input[type="checkbox"]{appearance:none;-webkit-appearance:none;'
    + 'width:16px;height:16px;margin:0;flex:none;position:relative;border-radius:var(--r-xs);'
    + 'border:1px solid var(--line-strong);background:var(--bg);cursor:pointer;'
    + 'transition:background-color 150ms var(--ease)}',
  '.mcart-switch input[type="checkbox"]::after{content:"";position:absolute;left:5px;top:2px;'
    + 'width:4px;height:8px;border-right:2px solid var(--on-primary);'
    + 'border-bottom:2px solid var(--on-primary);transform:rotate(45deg) scale(0)}',
  '.mcart-switch input[type="checkbox"]:checked{background:var(--primary);'
    + 'border-color:var(--primary)}',
  '.mcart-switch input[type="checkbox"]:checked::after{transform:rotate(45deg) scale(1)}',
  // ---- 属性行（设置）-------------------------------------------------------
  '.mcart-prop{display:grid;grid-template-columns:88px 1fr;align-items:center;'
    + 'min-height:26px;column-gap:10px;padding:2px 0}',
  '.mcart-prop-label{font-size:12px;line-height:18px;color:var(--ink3);text-align:right;'
    + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.mcart-prop-value{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap;'
    + 'font-size:13px;line-height:22px;color:var(--ink)}',
  '.mcart-prop-value>.mcart-input{flex:1 1 96px}',
  '.mcart-prop-value>.mcart-btn{flex:none}',
  '.mcart-settings{background:transparent;border:0;box-shadow:none;padding:0;'
    + 'display:flex;flex-direction:column;gap:10px}',
  '.mcart-settings .mcart-group{background:var(--card);border:1px solid var(--line);'
    + 'border-radius:var(--r-md);box-shadow:var(--dsw-elevation-soft);padding:12px;gap:2px}',
  '.mcart-settings .mcart-group-title{font-size:15px}',
  '.mcart-settings .mcart-group-head{border-bottom:1px solid var(--line);padding-bottom:8px}',
  '.mcart-group-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.mcart-num{font-family:ui-monospace,Consolas,monospace;font-size:12px;'
    + 'font-variant-numeric:tabular-nums}',
  '.mcart-path{color:var(--ink3);min-width:0;white-space:nowrap;overflow:hidden;'
    + 'text-overflow:ellipsis}',
  '.mcart-id{color:var(--ink3);font-family:ui-monospace,Consolas,monospace;font-size:12px;'
    + 'font-variant-numeric:tabular-nums;margin-left:6px}',
  '.mcart-note{font-size:12px;line-height:18px;color:var(--ink3)}',
  '.mcart-hint{font-size:12px;line-height:18px;color:var(--ink3);padding-left:calc(88px + 10px)}',
  '.mcart-sub{font-size:12px;line-height:18px;color:var(--ink3)}',
  // ---- 三态（空 / 加载 / 错误）---------------------------------------------
  '.mcart-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:16px 12px;'
    + 'text-align:center}',
  '.mcart-empty-title{font-family:var(--serif);font-size:26px;line-height:34px;font-weight:600;'
    + 'color:var(--ink)}',
  '.mcart-empty-num{font-family:var(--serif);font-size:28px;line-height:34px;font-weight:600;'
    + 'color:var(--ink);font-variant-numeric:tabular-nums}',
  '.mcart-empty-note{font-size:12px;line-height:18px;color:var(--ink3)}',
  '.mcart-loading{font-size:12px;line-height:18px;color:var(--ink3)}',
  '.mcart-bad,.mcart-err{font-size:12px;line-height:18px;word-break:break-all;'
    + 'border-left:2px solid;padding-left:8px;border-radius:var(--r-xs)}',
  '.mcart-bad{color:var(--dsw-alias-state-warn-primary,#e0a06c);'
    + 'border-left-color:var(--dsw-alias-state-warn-primary,#e0a06c)}',
  '.mcart-err{color:var(--dsw-alias-state-error-primary,#e06c6c);'
    + 'border-left-color:var(--dsw-alias-state-error-primary,#e06c6c)}',
  '.mcart-details{font-size:12px;line-height:18px;color:var(--ink3);margin-top:6px}',
  '.mcart-details>summary{cursor:pointer;width:max-content}',
  '.mcart-details>.mcart-report{margin:6px 0 0}',
  '.mcart-report,.mcart-reportnote{font-family:ui-monospace,Consolas,monospace;font-size:12px;'
    + 'font-variant-numeric:tabular-nums}',
  '.mcart-report{white-space:pre-wrap;word-break:break-word;background:var(--bg);'
    + 'border:1px solid var(--line);border-radius:var(--r-sm);padding:10px;'
    + 'line-height:18px;max-height:240px;overflow:auto;user-select:text}',
  '.mcart-reportnote{color:var(--ink3);word-break:break-all}',
  // ---- 3D 舞台卡片 --------------------------------------------------------
  '.mcart-stage{flex:1;min-height:0;display:flex;flex-direction:column;gap:10px;'
    + 'background:var(--card);border:1px solid var(--line);border-radius:var(--r-md);'
    + 'box-shadow:var(--dsw-elevation-soft);padding:12px}',
  '.mcart-toolbar{display:flex;align-items:center;gap:8px;flex:none}',
  '.mcart-toolbar-facts{font-family:ui-monospace,Consolas,monospace;font-size:12px;'
    + 'line-height:18px;font-variant-numeric:tabular-nums;color:var(--ink3);white-space:nowrap}',
  '.mcart-toolbar-grow{flex:1;min-width:8px}',
  // 视图切换用 300ms（资产列表 ↔ 设置独立视图）；卡片展开/悬浮用 200ms。
  '.mcart-body{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;display:flex;'
    + 'transition:opacity 300ms var(--ease);'
    + 'flex-direction:column;gap:10px;scrollbar-width:thin;'
    + 'scrollbar-color:var(--line-strong) transparent;overscroll-behavior:contain}',
  // 取景框：--canvas 底、r-md、内描边
  '.mcart-viewport{position:relative;flex:1;min-height:0;border-radius:var(--r-md);'
    + 'background:var(--canvas);box-shadow:inset 0 0 0 1px var(--line-strong);'
    + 'overflow:hidden}',
  '.mcart-zoom{position:absolute;right:10px;bottom:10px;display:flex;gap:6px;z-index:2}',
  '.mcart-canvas{width:100%;height:100%;min-height:180px;display:block;'
    + 'border-radius:var(--r-md);background:var(--canvas);cursor:grab;touch-action:none}',
  '.mcart-canvas:active{cursor:grabbing}',
  '.mcart-zoombtn{width:26px;height:26px;padding:0;display:inline-flex;align-items:center;'
    + 'justify-content:center;border:1px solid var(--line);border-radius:999px;'
    + 'background:var(--glass);color:var(--ink);font-size:14px;line-height:1;cursor:pointer;'
    + 'transition:background-color 150ms var(--ease)}',
  '.mcart-zoombtn:hover{background:var(--active)}',
  // 方向指示器（功能）：左下角三根短线，单色
  '.mcart-axis{position:absolute;left:10px;bottom:10px;pointer-events:none;opacity:.75}',
  '.mcart-axis line{stroke:var(--ink3);stroke-width:1;stroke-linecap:butt}',
  '.mcart-axis-x{opacity:.9}',
  '.mcart-axis-y{opacity:.65}',
  '.mcart-axis-z{opacity:.45}',
  '.mcart-poster{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);'
    + 'image-rendering:pixelated;pointer-events:none}',
  '.mcart-grip{display:flex;align-items:center;justify-content:center;height:8px;'
    + 'cursor:ns-resize;touch-action:none;flex:none}',
  '.mcart-gripbar{width:36px;height:2px;border-radius:999px;background:var(--line-strong)}',
  '.mcart-grip:hover .mcart-gripbar{background:var(--accent)}',
  // ---- HUD / 物品栏（内容区：固定中性深底）--------------------------------
  '.mcart-hud{position:absolute;left:0;right:0;bottom:0;display:flex;flex-direction:column;'
    + 'align-items:center;gap:4px;padding:0 8px 8px;pointer-events:none}',
  '.mcart-hudname{position:absolute;right:10px;bottom:calc(26px + 16px);'
    + 'font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:18px;'
    + 'font-variant-numeric:tabular-nums;color:var(--ink3);background:none;border:0;padding:0;'
    + 'pointer-events:none;white-space:nowrap}',
  '.mcart-hudbar{display:flex;align-items:center;gap:2px;padding:4px;border-radius:var(--r-md);'
    + 'background:var(--glass);border:1px solid var(--line);pointer-events:auto}',
  '.mcart-hudslot{width:24px;height:24px;padding:0;flex:none;display:flex;align-items:center;'
    + 'justify-content:center;box-sizing:border-box;border-radius:var(--r-sm);'
    + 'border:1px solid var(--line);background:var(--bg);cursor:pointer;'
    + 'transition:border-color 150ms var(--ease)}',
  '.mcart-hudslot:hover{border-color:var(--line-strong)}',
  '.mcart-hudslot[data-on="1"]{border-color:var(--accent);'
    + 'box-shadow:inset 0 0 0 1px var(--accent)}',
  '.mcart-hudicon{width:20px;height:20px;display:block;image-rendering:pixelated}',
  '.mcart-hudempty{background:transparent;border-color:var(--line);cursor:default}',
  '.mcart-hudpage{width:16px;height:24px;padding:0;flex:none;font:inherit;font-size:12px;'
    + 'line-height:24px;color:var(--ink3);background:none;border:0;cursor:pointer}',
  '.mcart-hudpage:hover{color:var(--ink)}',
  '.mcart-hudpage[disabled]{opacity:.4;cursor:default}',
  // ---- 缩略图条（物品栏 / 最近资产）--------------------------------------
  '.mcart-hotbar{display:flex;gap:2px;flex-wrap:wrap;max-height:124px;overflow:auto}',
  '.mcart-slot{width:24px;height:24px;box-sizing:border-box;padding:0;flex:none;'
    + 'border:1px solid var(--line);border-radius:var(--r-sm);background:none;'
    + 'background-size:cover;image-rendering:pixelated;cursor:pointer;'
    + 'transition:border-color 150ms var(--ease)}',
  '.mcart-slot:hover{border-color:var(--line-strong);background-color:var(--hover)}',
  '.mcart-slot[data-on="1"]{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}',
  '.mcart-slotq{font-size:12px;line-height:1;color:var(--ink3)}',
  '.mcart-slotmissing{font-size:11px;line-height:1;font-weight:600;'
    + 'color:var(--dsw-alias-state-warn-primary,#e0a06c)}',
  '.mcart-slot[data-missing="1"],.mcart-hudslot[data-missing="1"]{'
    + 'border-color:var(--dsw-alias-state-warn-primary,#e0a06c)}',
  '.mcart-chip{font-size:12px;line-height:22px;height:22px;padding:0 8px;'
    + 'border-radius:999px;background:var(--hover);color:var(--ink3)}',
  '.mcart-projects{max-height:240px;overflow:auto;display:flex;flex-direction:column;gap:2px}',
  '.mcart-mods{border:1px solid var(--line);border-radius:var(--r-sm);padding:8px;'
    + 'display:flex;flex-direction:column;gap:2px;max-height:200px;overflow:auto}',
  // ---- 像素编辑器 ---------------------------------------------------------
  '.mcart-edit-canvas{display:block;width:100%;height:auto;max-height:52vh;object-fit:contain;'
    + 'image-rendering:pixelated;border-radius:var(--r-sm);background:var(--canvas);'
    + 'margin:6px 0;cursor:crosshair;touch-action:none}',
  '.mcart-swatches{display:flex;gap:2px;flex-wrap:wrap;max-height:56px;overflow:auto}',
  '.mcart-swatch{width:18px;height:18px;box-sizing:border-box;border-radius:var(--r-sm);'
    + 'border:1px solid var(--line);cursor:pointer;padding:0;flex:none;'
    + 'transition:border-color 150ms var(--ease)}',
  '.mcart-swatch:hover{border-color:var(--line-strong)}',
  '.mcart-color{width:28px;height:28px;box-sizing:border-box;border-radius:var(--r-sm);'
    + 'border:1px solid var(--line);flex:none}',
  '.mcart-picker{width:32px;height:28px;padding:0;border:1px solid var(--line);'
    + 'border-radius:var(--r-sm);background:none;flex:none;cursor:pointer}',
  // ---- 底部「@ 提意见」胶囊输入条（36px）---------------------------------
  '.mcart-complain{display:flex;align-items:center;gap:8px;height:36px;flex:none;'
    + 'padding:0 4px 0 12px;border:1px solid var(--line);border-radius:999px;'
    + 'background:var(--card);box-shadow:var(--dsw-elevation-soft);'
    + 'transition:border-color 150ms var(--ease),box-shadow 150ms var(--ease)}',
  '.mcart-complain:hover{border-color:var(--line-strong)}',
  '.mcart-complain-icon{font-size:14px;line-height:1;color:var(--ink3);flex:none}',
  '.mcart-complain-hint{flex:1;min-width:0;font-size:13px;line-height:18px;color:var(--ink3);'
    + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.mcart-complain-send{width:26px;height:26px;padding:0;flex:none;border:0;border-radius:999px;'
    + 'background:var(--primary);color:var(--on-primary);font:inherit;font-size:13px;'
    + 'line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;'
    + 'transition:background-color 150ms var(--ease),width 200ms var(--ease),'
    + 'transform 120ms var(--ease)}',
  '.mcart-complain-send:hover{background:var(--primary-hover)}',
  '.mcart-complain-send:active{transform:scale(.98)}',
  '.mcart-complain-send[data-inserted="1"]{width:auto;padding:0 10px;border-radius:999px}',
  // ---- 引用条（冷启动兜底）/ 详情 ----------------------------------------
  '.mcart-ref{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;'
    + 'border:1px solid var(--line);border-radius:var(--r-md);background:var(--card);'
    + 'box-shadow:var(--dsw-elevation-soft);font-size:13px}',
  '.mcart-ref-path{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--ink3);'
    + 'word-break:break-all}',
  // ---- 设备窄宽度（右侧栏）----------------------------------------------
  '@container (max-width:320px){.mcart-prop{grid-template-columns:64px 1fr}'
    + '.mcart-hint{padding-left:0}}',
].join('')

const CATEGORIES = [
  { key: 'biome', label: '群系' },
  { key: 'structure', label: '结构' },
  { key: 'entity', label: '实体' },
  { key: 'block', label: '方块' },
]
