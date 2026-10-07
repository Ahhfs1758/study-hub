#!/bin/sh
# 学习中心 · 一键自检
#
#   sh run-checks.sh
#
# 三层，快的先跑，任一层挂了立刻退出（省得在坏地基上跑真机测试）：
#   1. 语法      —— 所有 JS 过一遍 parser，能挡住绝大多数低级错误
#   2. 口径      —— 纯 Node 加载数据层/统计层，把关键数字打出来人工核对
#   3. 真机验收  —— 真的把 Electron 开起来，逐个视图渲染 + 计时全链路 + 截图
#
# 注意第 3 步需要能启动 Chromium；在受限的沙箱里跑要加 --no-sandbox（脚本已自动判定）。

set -e
cd "$(dirname "$0")"

NODE=""
for c in node /Users/mac/.workbuddy/binaries/node/versions/22.22.2-6/bin/node; do
  if command -v "$c" >/dev/null 2>&1; then NODE="$c"; break; fi
done
if [ -z "$NODE" ]; then echo "找不到 node，无法自检。"; exit 1; fi

PYTHON=""
for c in python3 /Users/mac/.workbuddy/binaries/python/versions/3.13.12/bin/python3; do
  if command -v "$c" >/dev/null 2>&1; then PYTHON="$c"; break; fi
done

ELECTRON="./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
[ -x "$ELECTRON" ] || ELECTRON="./node_modules/electron/dist/electron"
if [ ! -x "$ELECTRON" ]; then
  ELECTRON="./node_modules/.bin/electron"
fi
if [ ! -x "$ELECTRON" ]; then
  echo "找不到 Electron 可执行文件，请先 npm install。"
  exit 1
fi

# 文档审计放在最前面：它最便宜，而且拦的是「用户照着 README 敲命令直接报错」这类问题。
# 本项目的 README 就曾经有 8 处 `命令  # 说明` 的写法 —— zsh 默认不把 # 当注释，
# 用户连注释一起复制粘贴，说明文字会被当成参数传给程序。
if [ -n "$PYTHON" ]; then
  echo "== 0/4 文档粘贴安全性 =="
  "$PYTHON" tools/audit-docs.py || exit 1
  echo
fi

echo "== 1/4 语法检查 =="
fail=0
for f in main.js preload.js src/main/*.js src/shared/*.js src/daemon/*.js src/renderer/*.js src/renderer/views/*.js tools/*.js; do
  if ! out=$("$NODE" --check "$f" 2>&1); then
    echo "  ✗ $f"; echo "$out" | head -6; fail=1
  fi
done
[ "$fail" = 0 ] && echo "  ✓ 全部通过"
[ "$fail" = 0 ] || exit 1

echo
echo "== 2/4 统计口径 =="
"$NODE" tools/check-analytics.js
echo
echo "== 3/4 真机验收 =="
# 这个 shell 常被注入代理与 ELECTRON_RUN_AS_NODE，会让 Electron 退化成纯 Node 或连不上代理。
# 另外在受限沙箱里 Chromium 的子进程（GPU/网络服务）无法正常启动、会反复崩溃重启，
# 跑到后面整个主进程会被拖死 —— 所以显式关掉 GPU 相关子进程，让它们根本不启动。
# 正常双击启动不需要这些参数。
#
# 🔴 --user-data-dir 必须给：自检会建科目、加资料、打勾任务、评分复习……
# 不给的话这些全部写进用户的**真实数据目录**（~/Library/Application Support/学习中心）。
# 自检绝不应该动用户的数据 —— 哪怕它事后会清理，中途崩溃就会留下脏数据。
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/studyhub-selftest.XXXXXX")"
rm -rf .selftest

# 🔴 自检绝不允许碰用户的真实数据。
# 自检会建科目、加资料、打勾任务、评分复习 —— 万一哪个环节漏了 --user-data-dir，
# 或者将来有人改回默认目录，就会静默污染用户数据（而且往往事后才发现）。
# 所以这里在跑之前和跑之后各取一次真实数据文件的指纹，不一致就直接失败。
REAL_DIRS=""
case "$(uname)" in
  Darwin) REAL_DIRS="$HOME/Library/Application Support/学习中心/study-hub.json" ;;
  *)      REAL_DIRS="${XDG_CONFIG_HOME:-$HOME/.config}/学习中心/study-hub.json" ;;
esac
fingerprint() {
  local f="$1"
  if [ -f "$f" ]; then
    # mtime + 大小：内容改了就一定会被这两个里至少一个捕捉到
    echo "$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null)-$(wc -c < "$f" | tr -d ' ')"
  else
    echo "absent"
  fi
}
REAL_BEFORE="$(fingerprint "$REAL_DIRS")"

env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS \
  STUDY_HUB_SELFTEST=1 STUDY_HUB_SHOTS=.selftest \
  "$ELECTRON" . --no-sandbox --disable-gpu --disable-gpu-compositing --in-process-gpu \
  --disable-dev-shm-usage --user-data-dir="$SCRATCH" 2>&1 | sed -n '/SELFTEST REPORT/,$p' | tail -n +2

REAL_AFTER="$(fingerprint "$REAL_DIRS")"
rm -rf "$SCRATCH"
if [ "$REAL_BEFORE" != "$REAL_AFTER" ]; then
  echo
  echo "✗ 自检改动了用户的真实数据文件！"
  echo "    路径：$REAL_DIRS"
  echo "    之前：$REAL_BEFORE"
  echo "    之后：$REAL_AFTER"
  echo "  最常见的原因：忘了传 --user-data-dir，或某个子进程没继承到它。"
  exit 1
fi

if [ -f .selftest/report.json ]; then
  if "$NODE" -e "const r=require('./.selftest/report.json'); process.exit(r.ok?0:1)"; then
    echo
    echo "✓ 自检全部通过，截图在 .selftest/"
  else
    echo
    echo "✗ 自检发现问题，详情见 .selftest/report.json"
    "$NODE" -e "
      const r = require('./.selftest/report.json');
      console.log('未通过的检查：');
      (r.errors || []).forEach((e) => console.log('  ·', e.where, JSON.stringify(e).slice(0, 300)));
    "
    exit 1
  fi
else
  echo
  echo "✗ 没有生成报告 —— Electron 很可能中途崩了。"
  echo "  最后执行的步骤（.selftest/progress.log）："
  tail -6 .selftest/progress.log 2>/dev/null | sed 's/^/    /'
  exit 1
fi

# ---------------------------------------------------------------- #
# 4/4（可选）：如果已经打过包，顺手校验 bundle 是不是完好的。
# 校验逻辑在 tools/check-bundle.js 里（和 make-app.js 用的是同一份，不会出现
# 「打包时通过、复检时标准不同」这种漂移）。这一段专治「打包成功但双击没反应」——
# 那类问题在 GUI 上没有任何提示，只能靠静态校验提前挑出来。
# ---------------------------------------------------------------- #
APP="release/学习中心.app"
if [ -d "$APP" ]; then
  echo
  echo "== 4/4 打包产物校验 =="
  "$NODE" tools/check-bundle.js "$APP" | tail -n +2
else
  echo
  echo "（跳过打包产物校验：还没有 $APP，执行 node tools/make-app.js 可以生成）"
fi
