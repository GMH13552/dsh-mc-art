// 设计令牌与样式表。**判据是 docs/UI-STYLE.md**：专业 3D 工具 / IDE 检查器面板
// （平、密、窄、静）。颜色只走宿主 token（带中性兜底），间距只用 2/4/6/8，
// 控件圆角 2px、面板 3px，禁止渐变/阴影/动画/过渡/硬编码灰。
//
// 这个文件在绘制片段之后（清单顺序 00-math → 10-icon → 20-const → …）：
// icon-test / icon-render-test 用 `const sub =` 到 `const CSS = [` 切片重建绘制区。
const CSS = [
  '.mcart-root{'
    // 面与线（全部来自宿主主题，兜底为中性色）
    + '--mc-bg-0:var(--dsw-alias-bg-base,Canvas);'
    + '--mc-bg-1:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.04));'
    + '--mc-bg-2:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.07));'
    + '--mc-overlay:var(--dsw-alias-bg-overlay,rgba(24,24,28,.98));'
    + '--mc-line-1:var(--dsw-alias-border-l1,rgba(255,255,255,.13));'
    + '--mc-line-2:var(--dsw-alias-border-l2,rgba(255,255,255,.24));'
    + '--mc-text-1:var(--dsw-alias-label-primary,rgba(236,236,241,.94));'
    + '--mc-text-2:var(--dsw-alias-label-secondary,rgba(236,236,241,.58));'
    + '--mc-brand:var(--dsw-alias-brand-primary,#4f9cf9);'
    // 选中行左侧 2px 条：纯品牌色在暗色主题下偏暗、容易被当成灰，
    // 按 75% 品牌色 + 25% 主文字色提亮（仍是 token 派生，不是硬编码颜色）。
    + '--mc-brand-bar:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f9cf9) 75%,'
    + 'var(--dsw-alias-label-primary,#ececf1));'
    + '--mc-error:var(--dsw-alias-state-error-primary,#e06c6c);'
    + '--mc-warn:var(--dsw-alias-state-warn-primary,#e0a06c);'
    + '--mc-ok:var(--dsw-alias-state-success-primary,#7fc98a);'
    + '--mc-idle:var(--dsw-alias-state-idle-primary,rgba(236,236,241,.6));'
    // 中性叠底由文字色算出来（4% hover / 8% active / 8% 强调选中），不是硬编码灰
    + '--mc-hover:color-mix(in srgb,var(--mc-text-1) 4%,transparent);'
    + '--mc-active:color-mix(in srgb,var(--mc-text-1) 8%,transparent);'
    + '--mc-select:color-mix(in srgb,var(--mc-brand) 8%,transparent);'
    // 间距刻度只有 2/4/6/8
    + '--mc-s1:2px;--mc-s2:4px;--mc-s3:6px;--mc-s4:8px;'
    // 尺寸：正文 12 / 次要 11 / 行高 22 / 表单行 26 / 工具栏 28 / 控件 22 / 标题 22
    + '--mc-fs:12px;--mc-fs2:11px;--mc-lh:22px;--mc-row:26px;--mc-toolbar:28px;'
    + '--mc-control:22px;--mc-section:22px;--mc-label:88px;--mc-icon:14px;'
    + '--mc-radius:2px;--mc-radius-panel:3px;'
    + '--mc-mono:ui-monospace,Consolas,monospace;'
    // 内容区（视口 / 像素画布 / HUD）是内容不是界面：固定中性深底
    + '--mc-canvas-bg:#141317;--mc-hud-bg:rgba(20,20,24,.8);'
    + 'display:flex;flex-direction:column;gap:var(--mc-s4);padding:var(--mc-s4);'
    + 'height:100%;box-sizing:border-box;overflow:hidden;container-type:inline-size;'
    + 'color:var(--mc-text-1);background:var(--mc-bg-0);'
    + 'font:var(--mc-fs)/var(--mc-lh) system-ui,-apple-system,"Segoe UI",sans-serif}',
  // ---- 标签 / 文字层级 -----------------------------------------------------
  '.mcart-title{font-size:var(--mc-fs2);font-weight:600;color:var(--mc-text-2)}',
  '.mcart-sub{font-size:var(--mc-fs2);color:var(--mc-text-2)}',
  '.mcart-note{font-size:var(--mc-fs2);color:var(--mc-text-2)}',
  '.mcart-hint{font-size:var(--mc-fs2);line-height:14px;color:var(--mc-text-2);'
    + 'padding-left:calc(var(--mc-label) + var(--mc-s3))}',
  '.mcart-path,.mcart-id,.mcart-report,.mcart-reportnote{font-family:var(--mc-mono);'
    + 'font-size:var(--mc-fs2);font-variant-numeric:tabular-nums}',
  '.mcart-path{color:var(--mc-text-2);word-break:break-all;min-width:0}',
  '.mcart-id{color:var(--mc-text-2);margin-left:var(--mc-s2)}',
  '.mcart-grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.mcart-group{display:flex;flex-direction:column}',
  '.mcart-group+.mcart-group{border-top:1px solid var(--mc-line-1);'
    + 'margin-top:var(--mc-s2);padding-top:var(--mc-s2)}',
  // ---- 工具栏 / 区块标题 ---------------------------------------------------
  '.mcart-head{position:sticky;top:0;z-index:3;display:flex;align-items:center;'
    + 'height:var(--mc-toolbar);min-height:var(--mc-toolbar);gap:var(--mc-s2);'
    + 'padding:0 var(--mc-s4);margin:calc(-1 * var(--mc-s4)) calc(-1 * var(--mc-s4)) 0;'
    + 'background:var(--mc-bg-0);border-bottom:1px solid var(--mc-line-1)}',
  '.mcart-head>.mcart-title{color:var(--mc-text-1)}',
  // ---- 单行紧凑头部：只有路径（mono）+ 右侧图标按钮组 ----------------------
  // 不再显示"中央面板/右侧栏"这类内部落点概念，也不再重复视图名。
  '.mcart-headpath{font-family:var(--mc-mono);font-size:var(--mc-fs2);color:var(--mc-text-2);'
    + 'font-variant-numeric:tabular-nums;min-width:0;overflow:hidden;text-overflow:ellipsis;'
    + 'white-space:nowrap}',
  '.mcart-headgrow{flex:1;min-width:var(--mc-s2)}',
  // 工具栏按钮：透明底、组间 1px 竖线（只在 header 内）
  '.mcart-head .mcart-btn,.mcart-head .mcart-icon{background:transparent;border-color:transparent;'
    + 'height:var(--mc-control);flex:none}',
  '.mcart-head .mcart-btn:hover,.mcart-head .mcart-icon:hover{background:var(--mc-hover)}',
  '.mcart-head .mcart-btn+.mcart-btn,.mcart-head .mcart-btn+.mcart-icon,'
    + ' .mcart-head .mcart-icon+.mcart-btn,.mcart-head .mcart-icon+.mcart-icon{'
    + 'border-left:1px solid var(--mc-line-1);border-radius:0;padding-left:var(--mc-s1)}',
  // ---- 3D 舞台的工具栏：事实（左）· 图标工具（中）· 主操作（右） ----------
  '.mcart-toolbar{display:flex;align-items:center;gap:var(--mc-s2);height:var(--mc-toolbar);'
    + 'min-height:var(--mc-toolbar)}',
  '.mcart-toolbar-facts{font-family:var(--mc-mono);font-size:var(--mc-fs2);'
    + 'font-variant-numeric:tabular-nums;color:var(--mc-text-2);white-space:nowrap}',
  '.mcart-toolbar-grow{flex:1;min-width:var(--mc-s2)}',
  // 主操作：强调色文字 + 强调色描边（唯一带品牌色的按钮）
  '.mcart-primary{color:var(--mc-brand);border-color:var(--mc-brand);background:transparent}',
  '.mcart-primary:hover{background:var(--mc-select);border-color:var(--mc-brand)}',
  '.mcart-bar{display:flex;align-items:center;gap:var(--mc-s2);flex-wrap:wrap}',
  // ---- 主体（独立滚动）与 3D 舞台（占满剩余高度） -------------------------
  '.mcart-body{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;display:flex;'
    + 'flex-direction:column;gap:var(--mc-s4);scrollbar-width:thin;'
    + 'scrollbar-color:var(--dsw-scrollbar-thumb,var(--mc-line-2)) transparent;'
    + 'overscroll-behavior:contain}',
  '.mcart-stage{flex:1;min-height:0;display:flex;flex-direction:column;gap:var(--mc-s2)}',
  // 卡片去掉"卡片感"：面 + 顶部分隔线 + 4/8 留白，无圆角无阴影
  '.mcart-card{border:0;border-top:1px solid var(--mc-line-1);border-radius:0;'
    + 'padding:var(--mc-s2) 0;display:flex;flex-direction:column;gap:var(--mc-s2);'
    + 'background:transparent}',
  // 卡片第一行是区块标题：22px 高、11px/600、次要色、底部 1px 线
  '.mcart-card>.mcart-bar:first-child{min-height:var(--mc-section);height:var(--mc-section);'
    + 'padding:0;border-bottom:1px solid var(--mc-line-1)}',
  // ---- 属性行：label 88px 右对齐 + 值占满；组内不画线，组间才画 -------------
  '.mcart-prop{display:grid;grid-template-columns:var(--mc-label) 1fr;align-items:center;'
    + 'min-height:var(--mc-row);column-gap:var(--mc-s3);padding:1px 0}',
  '.mcart-prop-label{font-size:var(--mc-fs2);color:var(--mc-text-2);text-align:right;'
    + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.mcart-prop-value{display:flex;align-items:center;gap:var(--mc-s2);min-width:0;'
    + 'font-size:var(--mc-fs2);color:var(--mc-text-1)}',
  '.mcart-src{display:flex;align-items:center;gap:var(--mc-s2)}',
  '.mcart-tabs,.mcart-tools{display:flex;gap:var(--mc-s2);flex-wrap:wrap;align-items:center}',
  // ---- 控件（与规范同高 22px，圆角 2px） -----------------------------------
  '.mcart-btn{height:var(--mc-control);padding:0 var(--mc-s3);box-sizing:border-box;'
    + 'border:1px solid var(--mc-line-1);border-radius:var(--mc-radius);'
    + 'background:var(--mc-bg-1);color:var(--mc-text-1);font:inherit;font-size:var(--mc-fs2);'
    + 'line-height:20px;white-space:nowrap;cursor:pointer;flex:none}',
  '.mcart-btn:hover{background:var(--mc-active);border-color:var(--mc-line-2)}',
  '.mcart-btn:active{background:var(--mc-active)}',
  '.mcart-btn[disabled]{opacity:.4;cursor:default;background:var(--mc-bg-1)}',
  '.mcart-tool[data-on="1"]{background:var(--mc-select);border-color:var(--mc-brand)}',
  '.mcart-icon{width:var(--mc-control);height:var(--mc-control);display:inline-flex;'
    + 'align-items:center;justify-content:center;padding:0;border:0;border-radius:var(--mc-radius);'
    + 'background:none;color:var(--mc-text-2);font:inherit;font-size:var(--mc-icon);'
    + 'line-height:1;cursor:pointer}',
  '.mcart-icon:hover{background:var(--mc-hover);color:var(--mc-text-1)}',
  '.mcart-icon[data-on="1"]{background:var(--mc-select);color:var(--mc-text-1)}',
  '.mcart-input,.mcart-select{height:var(--mc-control);box-sizing:border-box;min-width:0;'
    + 'padding:0 var(--mc-s3);border:1px solid var(--mc-line-1);border-radius:var(--mc-radius);'
    + 'background:var(--mc-bg-2);color:var(--mc-text-1);font:inherit;font-size:var(--mc-fs2)}',
  '.mcart-input{flex:1}',
  '.mcart-select{flex:1;padding:0 var(--mc-s1)}',
  '.mcart-input:hover,.mcart-select:hover{border-color:var(--mc-line-2)}',
  '.mcart-input:disabled,.mcart-select:disabled{opacity:.4;cursor:default}',
  '.mcart-input[type="number"]{text-align:right;font-family:var(--mc-mono);'
    + 'font-variant-numeric:tabular-nums}',
  '.mcart-input[type="range"],.mcart-alpha{accent-color:var(--mc-brand)}',
  '.mcart-slot[disabled],.mcart-swatch[disabled]{opacity:.4;cursor:default}',
  // 四态一致：hover 4% / active 8% / focus-visible 1px 强调内描边 / disabled 40%
  '.mcart-btn:focus-visible,.mcart-icon:focus-visible,.mcart-input:focus-visible,'
    + '.mcart-select:focus-visible,.mcart-item:focus-visible,.mcart-slot:focus-visible,'
    + '.mcart-hudslot:focus-visible,.mcart-swatch:focus-visible,.mcart-picker:focus-visible,'
    + '.mcart-hudpage:focus-visible,.mcart-switch:focus-within{'
    + 'outline:1px solid var(--mc-brand);outline-offset:-1px}',
  // 开关：12×20 轨道（2px 圆角），不是 iOS 大开关
  '.mcart-switch{display:flex;align-items:center;gap:var(--mc-s2);min-height:var(--mc-row);'
    + 'font-size:var(--mc-fs2);cursor:pointer}',
  '.mcart-switch input[type="checkbox"]{appearance:none;-webkit-appearance:none;'
    + 'width:20px;height:12px;margin:0;flex:none;position:relative;border-radius:var(--mc-radius);'
    + 'border:1px solid var(--mc-line-2);background:var(--mc-bg-2);cursor:pointer}',
  '.mcart-switch input[type="checkbox"]::after{content:"";position:absolute;top:1px;left:1px;'
    + 'width:8px;height:8px;border-radius:var(--mc-radius);background:var(--mc-text-2)}',
  '.mcart-switch input[type="checkbox"]:checked{background:var(--mc-brand);border-color:var(--mc-brand)}',
  '.mcart-switch input[type="checkbox"]:checked::after{left:9px;background:var(--mc-bg-0)}',
  // ---- 三态（空 / 加载 / 错误）一致 ---------------------------------------
  '.mcart-empty{font-size:var(--mc-fs2);color:var(--mc-text-2);padding:var(--mc-s2) 0}',
  '.mcart-loading{font-size:var(--mc-fs2);color:var(--mc-text-2)}',
  '.mcart-bad,.mcart-err{font-size:var(--mc-fs2);line-height:14px;word-break:break-all;'
    + 'border-left:2px solid;padding-left:var(--mc-s3)}',
  '.mcart-bad{color:var(--mc-warn);border-left-color:var(--mc-warn)}',
  '.mcart-err{color:var(--mc-error);border-left-color:var(--mc-error)}',
  // 技术细节：可展开的"详情"，原话只进这里（不占主文案）
  '.mcart-details{font-size:var(--mc-fs2);line-height:14px;color:var(--mc-text-2);'
    + 'margin-top:var(--mc-s1)}',
  '.mcart-details>summary{cursor:pointer;width:max-content}',
  '.mcart-details>.mcart-report{margin:var(--mc-s1) 0 0}',
  // ---- 列表：两列行（名称 + 右对齐等宽 id），选中 8% 叠底 + 左侧 2px 强调条 ----
  // 列表区填满主体剩余高度（不留"飘在空白里"的死区），底部自带 1px 发丝线。
  '.mcart-list{flex:1;min-height:0;overflow:auto;'
    + 'border:1px solid var(--mc-line-1);border-radius:var(--mc-radius-panel);'
    + 'padding:var(--mc-s1)}',
  '.mcart-row{display:flex;align-items:center;gap:var(--mc-s2);height:var(--mc-lh);'
    + 'padding:0 var(--mc-s2);border-left:2px solid transparent}',
  '.mcart-row:hover{background:var(--mc-hover)}',
  '.mcart-item{display:flex;align-items:center;gap:var(--mc-s2);width:100%;'
    + 'height:var(--mc-lh);padding:0 var(--mc-s2);text-align:left;'
    + 'border:0;border-left:2px solid transparent;border-radius:0;background:none;'
    + 'color:var(--mc-text-1);font:inherit;font-size:var(--mc-fs);cursor:pointer}',
  '.mcart-item-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.mcart-item-id{flex:none;max-width:50%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
    + 'font-family:var(--mc-mono);font-size:var(--mc-fs2);font-variant-numeric:tabular-nums;'
    + 'color:var(--mc-text-2);text-align:right}',
  // 分组头：11px/600 次要色、22px 高、底部 1px 发丝线、滚动时 sticky（贴在顶栏下面）
  '.mcart-group-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;'
    + 'height:var(--mc-section);min-height:var(--mc-section);padding:0 var(--mc-s2);'
    + 'background:var(--mc-bg-0);border-bottom:1px solid var(--mc-line-1);'
    + 'font-size:var(--mc-fs2);font-weight:600;color:var(--mc-text-2)}',
  '.mcart-item:hover{background:var(--mc-hover)}',
  '.mcart-item:active{background:var(--mc-active)}',
  '.mcart-item[data-on="1"]{background:var(--mc-select);border-left-color:var(--mc-brand-bar)}',
  '.mcart-projects{max-height:240px;overflow:auto;display:flex;flex-direction:column;'
    + 'border:1px solid var(--mc-line-1);border-radius:var(--mc-radius-panel);padding:var(--mc-s1)}',
  '.mcart-mods{border:1px solid var(--mc-line-1);border-radius:var(--mc-radius-panel);'
    + 'padding:var(--mc-s1) var(--mc-s2);display:flex;flex-direction:column;max-height:200px;'
    + 'overflow:auto}',
  '.mcart-chip{font-size:var(--mc-fs2);padding:0 var(--mc-s3);height:var(--mc-control);'
    + 'box-sizing:border-box;border-radius:var(--mc-radius);background:var(--mc-bg-1);'
    + 'color:var(--mc-text-2)}',
  // 滚动区统一：细滚动条、不链式滚动
  '.mcart-list,.mcart-hotbar,.mcart-swatches,.mcart-projects,.mcart-mods{'
    + 'scrollbar-width:thin;scrollbar-color:var(--dsw-scrollbar-thumb,var(--mc-line-2)) transparent;'
    + 'overscroll-behavior:contain}',
  // ---- 取景框（内容区，固定深底；视口占满舞台剩余高度） --------------------
  '.mcart-canvas{width:100%;height:100%;min-height:180px;display:block;'
    + 'border-radius:var(--mc-radius-panel);background:var(--mc-canvas-bg);'
    + 'border:1px solid var(--mc-line-1);cursor:grab;touch-action:none}',
  '.mcart-canvas:active{cursor:grabbing}',
  '.mcart-viewport{position:relative;flex:1;min-height:0}',
  '.mcart-zoom{position:absolute;right:var(--mc-s2);top:var(--mc-s2);display:flex;'
    + 'gap:var(--mc-s1);opacity:.9}',
  '.mcart-zoom:hover{opacity:1}',
  '.mcart-zoombtn{width:var(--mc-control);height:var(--mc-control);padding:0;display:inline-flex;'
    + 'align-items:center;justify-content:center;font-size:var(--mc-fs);line-height:1;'
    + 'background:var(--mc-hud-bg);border-color:var(--mc-line-2);color:var(--mc-text-1)}',
  // 方向指示器：左下角，三根 12px 短线，单色低饱和（没有彩色装饰）
  '.mcart-axis{position:absolute;left:var(--mc-s2);bottom:var(--mc-s2);pointer-events:none;'
    + 'opacity:.75}',
  '.mcart-axis line{stroke:var(--mc-text-2);stroke-width:1;stroke-linecap:butt}',
  '.mcart-axis-x{opacity:.9}',
  '.mcart-axis-y{opacity:.65}',
  '.mcart-axis-z{opacity:.45}',
  '.mcart-poster{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);'
    + 'image-rendering:pixelated;pointer-events:none}',
  '.mcart-grip{display:flex;align-items:center;justify-content:center;height:5px;'
    + 'cursor:ns-resize;touch-action:none}',
  '.mcart-gripbar{width:32px;height:1px;background:var(--mc-line-2)}',
  '.mcart-grip:hover .mcart-gripbar{background:var(--mc-brand)}',
  // ---- HUD（游戏物品栏）：槽位 22px、2px 圆角、选中 1px 强调内描边 ----------
  '.mcart-hud{position:absolute;left:0;right:0;bottom:0;display:flex;flex-direction:column;'
    + 'align-items:center;gap:var(--mc-s1);padding:0 var(--mc-s2) var(--mc-s2);pointer-events:none}',
  // 当前物品名：**视口右下角的 mono 11 次要色标签**（不再浮在热键栏上方挡内容）
  '.mcart-hudname{position:absolute;right:var(--mc-s2);'
    + 'bottom:calc(var(--mc-control) + var(--mc-s4));font-family:var(--mc-mono);'
    + 'font-size:var(--mc-fs2);font-variant-numeric:tabular-nums;color:var(--mc-text-2);'
    + 'background:none;border:0;padding:0;pointer-events:none;white-space:nowrap}',
  '.mcart-hudbar{display:flex;align-items:center;gap:var(--mc-s1);padding:var(--mc-s1);'
    + 'border-radius:var(--mc-radius-panel);background:var(--mc-hud-bg);'
    + 'border:1px solid var(--mc-line-2);pointer-events:auto}',
  '.mcart-hudslot{width:var(--mc-control);height:var(--mc-control);padding:0;flex:none;'
    + 'display:flex;align-items:center;justify-content:center;box-sizing:border-box;'
    + 'border-radius:var(--mc-radius);border:1px solid var(--mc-line-2);'
    + 'background:var(--mc-bg-1);cursor:pointer}',
  '.mcart-hudslot:hover{border-color:var(--mc-brand)}',
  '.mcart-hudslot[data-on="1"]{border-color:var(--mc-brand);outline:1px solid var(--mc-brand);'
    + 'outline-offset:-2px}',
  '.mcart-hudicon{width:18px;height:18px;display:block;image-rendering:pixelated}',
  '.mcart-hudempty{background:transparent;border-color:var(--mc-line-1);cursor:default}',
  '.mcart-hudpage{width:12px;height:var(--mc-control);padding:0;flex:none;font:inherit;'
    + 'font-size:var(--mc-fs);line-height:1;color:var(--mc-text-2);background:none;border:0;'
    + 'cursor:pointer}',
  '.mcart-hudpage:hover{color:var(--mc-text-1)}',
  '.mcart-hudpage[disabled]{opacity:.4;cursor:default}',
  // ---- 物品栏 / 九宫格 / 缩略图 -------------------------------------------
  '.mcart-hotbar{display:flex;gap:var(--mc-s1);flex-wrap:wrap;max-height:124px;overflow:auto}',
  '.mcart-slot{width:var(--mc-control);height:var(--mc-control);box-sizing:border-box;'
    + 'border:1px solid var(--mc-line-1);border-radius:var(--mc-radius);background:none;'
    + 'background-size:cover;image-rendering:pixelated;padding:0;flex:none;cursor:pointer}',
  '.mcart-slot:hover{border-color:var(--mc-line-2);background-color:var(--mc-hover)}',
  '.mcart-slot[data-on="1"]{border-color:var(--mc-brand);outline:1px solid var(--mc-brand);'
    + 'outline-offset:-2px}',
  '.mcart-slotq{font-size:var(--mc-fs);line-height:1;color:var(--mc-text-2)}',
  '.mcart-slotmissing{font-size:var(--mc-fs2);font-weight:600;color:var(--mc-warn)}',
  '.mcart-slot[data-missing="1"],.mcart-hudslot[data-missing="1"]{border-color:var(--mc-warn)}',
  // ---- 像素编辑器 ---------------------------------------------------------
  '.mcart-edit{display:flex;flex-direction:column;gap:var(--mc-s2)}',
  '.mcart-edit-canvas{display:block;width:100%;height:auto;max-height:52vh;object-fit:contain;'
    + 'image-rendering:pixelated;border-radius:var(--mc-radius);background:var(--mc-canvas-bg);'
    + 'margin:var(--mc-s2) 0;cursor:crosshair;touch-action:none}',
  '.mcart-swatches{display:flex;gap:var(--mc-s1);flex-wrap:wrap;max-height:56px;overflow:auto}',
  '.mcart-swatch{width:16px;height:16px;box-sizing:border-box;border-radius:var(--mc-radius);'
    + 'border:1px solid var(--mc-line-2);cursor:pointer;padding:0;flex:none}',
  '.mcart-swatch:hover{border-color:var(--mc-text-2)}',
  '.mcart-color{width:var(--mc-control);height:var(--mc-control);box-sizing:border-box;'
    + 'border-radius:var(--mc-radius);border:1px solid var(--mc-line-1);flex:none}',
  '.mcart-picker{width:32px;height:var(--mc-control);padding:0;border:1px solid var(--mc-line-1);'
    + 'border-radius:var(--mc-radius);background:none;flex:none;cursor:pointer}',
  // ---- 引用条（冷启动兜底）/ 报告（只上屏、可复制） ------------------------
  '.mcart-ref{display:flex;align-items:center;gap:var(--mc-s2);flex-wrap:wrap;'
    + 'padding:var(--mc-s2) var(--mc-s4);border:1px solid var(--mc-line-1);'
    + 'border-radius:var(--mc-radius-panel);background:var(--mc-bg-1);font-size:var(--mc-fs2)}',
  '.mcart-ref-path{font-family:var(--mc-mono);color:var(--mc-text-2);word-break:break-all}',
  '.mcart-report{white-space:pre-wrap;word-break:break-word;background:var(--mc-bg-2);'
    + 'border:1px solid var(--mc-line-1);border-radius:var(--mc-radius-panel);'
    + 'padding:var(--mc-s3);margin:var(--mc-s1) 0;line-height:14px;max-height:240px;'
    + 'overflow:auto;user-select:text}',
  '.mcart-reportnote{color:var(--mc-text-2);word-break:break-all}',
  // ---- 窄宽度（右侧栏）：不许把按钮裁掉 —— 控件换行、标签列收窄 -------------
  '.mcart-stack{display:flex;flex-direction:column;align-items:stretch;gap:var(--mc-s2)}',
  '.mcart-stack>.mcart-btn{align-self:flex-start}',
  '.mcart-prop-value{flex-wrap:wrap}',
  '.mcart-prop-value>.mcart-input{flex:1 1 96px}',
  '.mcart-prop-value>.mcart-btn{flex:none}',
  '@container (max-width:260px){'
    + '.mcart-prop{grid-template-columns:64px 1fr}'
    + '.mcart-hint{padding-left:0}'
    + '.mcart-item-id{max-width:46%}}',
].join('')

const CATEGORIES = [
  { key: 'biome', label: '群系' },
  { key: 'structure', label: '结构' },
  { key: 'entity', label: '实体' },
  { key: 'block', label: '方块' },
]
