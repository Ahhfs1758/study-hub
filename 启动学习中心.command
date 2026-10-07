#!/bin/sh
# 学习中心 · macOS 双击启动
#
# 双击这个文件就行，不需要先 cd —— 脚本会自己切到所在目录。
# 首次运行会自动准备 Electron 运行时（约 100MB，需要联网，几分钟）；之后就秒开。

cd "$(dirname "$0")" || exit 1

# 挡住常见环境坑：
#   ELECTRON_RUN_AS_NODE=1 → Electron 退化成纯 Node，报一个完全看不懂的 TypeError
#   NODE_OPTIONS 里的 --require 注入 → 同样会污染 Electron 的 Node 环境
#   指向本机回环的死代理 → Chromium 连不上自己
unset ELECTRON_RUN_AS_NODE NODE_OPTIONS
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy

NODE=""
for c in node /usr/local/bin/node /opt/homebrew/bin/node \
         /Users/mac/.workbuddy/binaries/node/versions/22.22.2-6/bin/node; do
  if command -v "$c" >/dev/null 2>&1; then NODE="$c"; break; fi
done

ELECTRON="./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"

if [ ! -x "$ELECTRON" ]; then
  echo "==============================================="
  echo " 首次启动：正在准备运行环境，请稍候（约需几分钟）"
  echo "==============================================="
  if [ -z "$NODE" ]; then
    echo
    echo "没有找到 Node.js。"
    echo "请先安装 Node.js（https://nodejs.org 下载 LTS 版本），再双击本文件。"
    echo
    read -r _
    exit 1
  fi
  # ensure-runtime 优先从本机缓存恢复，装不上时也能自己兜住
  if ! "$NODE" tools/ensure-runtime.js; then
    echo
    echo "准备运行环境失败。请检查网络后重试，或在终端里手动执行：npm install"
    echo
    read -r _
    exit 1
  fi
  echo
fi

# 统一走 run-app.js：它会再清一遍环境变量，并在 Chromium 沙箱失败时给出可操作的建议
if [ -n "$NODE" ]; then
  exec "$NODE" tools/run-app.js "$@"
fi
exec "$ELECTRON" . "$@"
