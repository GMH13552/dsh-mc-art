#!/usr/bin/env sh
# 装好这套东西：两个 skill + 两个模式。
#
#   sh install.sh                     # 装/更新
#   sh install.sh --no-cordis-tools   # 只装"无 Cordis 工具"的那个模式
#
# 这只是个壳：真正的安装逻辑在 install.mjs 里，一份，Windows（install.bat）与这里共用。
# 以前逻辑写在这个 .sh 里，于是在 Windows 上有两处必然出错（反斜杠路径被当转义、
# 一条分支写死 python3）——同一份逻辑写两遍，就会各修一次、各漏一次。
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' "需要 Node.js（DSH 本身就是 Node 跑的，正常应该已经有）。" >&2
  exit 2
fi

exec node "$HERE/install.mjs" "$@"
