#!/usr/bin/env sh
# 装好这套东西：两个 skill + 一个模式。
#
#   sh install.sh                     # 装/更新
#   sh install.sh --no-cordis-tools   # 模式里关掉 Cordis 工具行（能与别的模式并存）
#
# 为什么美术引擎不放进这个仓库、也不做成 git submodule：
#   `mc-art` 有自己的仓库、自己的历史和节奏，本来也独立可用（它是一台确定性引擎）。
#   做成子模块会把它钉在某个 commit 上，而且要更新就得手动 bump；最常见的坑是
#   `git clone` 忘了 `--recursive`，于是"装好了"但少了半个引擎。
#   所以这里**拉它**，并且用 `git pull` 更新它——安装与更新是同一条命令。
set -eu

DSH_ROOT="${DSH_HOME:-$HOME/.dsh}"
SKILLS="$DSH_ROOT/skills"
PRESETS="$DSH_ROOT/.agent-presets"
ART_REPO="${MC_ART_REPO:-https://github.com/GMH13552/mc-art.git}"
HERE="$(cd "$(dirname "$0")" && pwd)"

NO_CORDIS_TOOLS=0
for arg in "$@"; do
  case "$arg" in
    --no-cordis-tools) NO_CORDIS_TOOLS=1 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) printf '认不出的参数：%s\n' "$arg" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }

mkdir -p "$SKILLS" "$PRESETS"

# ── 1) mc-mod：就在本仓库里 ────────────────────────────────────────────────
rm -rf "$SKILLS/mc-mod"
cp -r "$HERE/skills/mc-mod" "$SKILLS/mc-mod"
say "✓ skill  mc-mod     -> $SKILLS/mc-mod"

# ── 2) mc-art：独立仓库，clone 或更新 ─────────────────────────────────────
if [ -d "$SKILLS/mc-art/.git" ]; then
  if git -C "$SKILLS/mc-art" pull --ff-only --quiet 2>/dev/null; then
    say "✓ skill  mc-art     已更新（git pull --ff-only）"
  else
    say "！skill  mc-art     git pull 没成功（本地有改动或没网？）：$SKILLS/mc-art"
  fi
else
  if git clone --quiet "$ART_REPO" "$SKILLS/mc-art" 2>/dev/null; then
    say "✓ skill  mc-art     -> $SKILLS/mc-art"
  else
    say "！skill  mc-art     拉不下来：$ART_REPO（装好后可手动 git clone 到 $SKILLS/mc-art）"
  fi
fi

# ── 3) 模式 ───────────────────────────────────────────────────────────────
rm -rf "$PRESETS/mc-studio"
cp -r "$HERE/presets/mc-studio" "$PRESETS/mc-studio"
if [ "$NO_CORDIS_TOOLS" = "1" ]; then
  python3 - "$PRESETS/mc-studio/agent.cordis.yml" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
s = p.read_text(encoding='utf-8')
old = "- id: tool-cordis\n  name: '@deepseek-ai/dsh-tool-cordis'"
if old not in s:
    raise SystemExit('找不到 tool-cordis 那一行，没改动')
p.write_text(s.replace(old, old + "\n  disabled: true", 1), encoding='utf-8')
PY
  say "✓ preset mc-studio  已装（Cordis 工具行 disabled：能和别的模式并存；代价是模式里起不了面板）"
else
  say "✓ preset mc-studio  -> $PRESETS/mc-studio"
fi

# ── 4) 依赖自检：只说事实 ─────────────────────────────────────────────────
say ""
say "依赖自检："
if command -v git >/dev/null 2>&1; then say "  ✓ git"; else say "  ！git 没找到"; fi

PY=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1; then PY="$candidate"; break; fi
done
if [ -n "$PY" ]; then
  say "  ✓ $PY $("$PY" -c 'import sys;print(".".join(map(str,sys.version_info[:3])))' 2>/dev/null || echo '')"
  if "$PY" -c 'import PIL' 2>/dev/null; then
    say "  ✓ Pillow $("$PY" -c 'import PIL;print(PIL.__version__)' 2>/dev/null)（mc-art 需要）"
  else
    say "  ！mc-art 需要 Pillow：$PY -m pip install pillow"
  fi
else
  say "  ！没找到 python3 / python（抽取器、判定工具、mc-art 都要）"
fi

if command -v java >/dev/null 2>&1; then
  say "  ✓ java $(java -version 2>&1 | head -1 | cut -d'"' -f2)（1.18.2 模组要 17；1.20.5+ 要 21）"
else
  say "  ！没找到 java（编译/运行模组要用）"
fi

say ""
say "下一步："
say "  1. 重启 DSH，模式里会出现「MC 模组工作室」"
say "  2. 面板要用加载器激活一次：把 tools/mcart-plugin/loader.host.js 作为 code.host、"
say "     loader.client.js 作为 code.client 交给 cordis_define，再 cordis_run"
say "     ⚠️ 先改 loader.host.js 顶部的 MCART_HOME 为你自己的克隆路径"
say "  3. 判定一次：cd fleshland/mod && $PY ../../tools/mcmod_gametest.py"
