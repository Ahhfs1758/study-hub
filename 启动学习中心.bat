@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem 挡住常见环境坑（ELECTRON_RUN_AS_NODE 会让 Electron 退化成纯 Node，报一个看不懂的 TypeError）
set ELECTRON_RUN_AS_NODE=
set NODE_OPTIONS=
set HTTP_PROXY=
set HTTPS_PROXY=
set http_proxy=
set https_proxy=

set "ELECTRON=node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON%" (
  echo ===============================================
  echo  首次启动：正在准备运行环境，请稍候（约需几分钟）
  echo ===============================================
  where node >nul 2>nul
  if errorlevel 1 (
    echo.
    echo 没有找到 Node.js。
    echo 请先安装 Node.js（https://nodejs.org 下载 LTS 版本），再双击本文件。
    echo.
    pause
    exit /b 1
  )
  node tools\ensure-runtime.js
  if errorlevel 1 (
    where npm >nul 2>nul
    if errorlevel 1 (
      echo.
      echo 没有找到 npm。请检查 Node.js 安装是否完整。
      pause
      exit /b 1
    )
    call npm install --no-audit --no-fund
    if errorlevel 1 (
      echo.
      echo 准备运行环境失败。请检查网络后重试，或在命令行里手动执行：npm install
      pause
      exit /b 1
    )
    node tools\ensure-runtime.js
    if errorlevel 1 (
      echo 运行环境仍然不可用，请检查上面的报错。
      pause
      exit /b 1
    )
  )
)

rem 统一走 run-app.js：它会再清一遍环境变量，并在 Chromium 沙箱失败时给出可操作的建议。
rem 用 node 启动而不是直接 start，是为了能捕获子进程输出；托盘/窗口行为完全一样。
where node >nul 2>nul
if not errorlevel 1 (
  node tools\run-app.js %*
) else (
  start "" "%ELECTRON%" .
)
