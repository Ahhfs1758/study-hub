#!/usr/bin/env node
'use strict';
/**
 * run-app.js —— 启动应用（npm start 的实际入口）
 *
 * 为什么不直接写 `electron .`：
 *
 *   🔴 环境里只要存在 `ELECTRON_RUN_AS_NODE=1`，Electron 二进制就会**退化成纯 Node**，
 *   于是 `require('electron').app` 是 undefined，启动时报一句完全看不懂的
 *   `TypeError: Cannot read properties of undefined (reading 'setAppUserModelId')`。
 *   这个变量是很多 IDE / 测试工具 / 容器环境会顺手设上的（本项目开发机就撞到过），
 *   而报错信息里一个字都没提到它 —— 排查成本极高。
 *
 *   `NODE_OPTIONS` 里的 `--require` 注入同理：它会被带进 Electron 的 Node 环境，
 *   若那个模块在 Electron 下不成立，同样是一堆莫名报错。
 *
 * 所以这里显式清掉这两个变量再启动，并且在清掉时**打印一行说明**（不静默）——
 * 用户看到「已忽略环境里的 X」就知道为什么，而不是以为应用自己坏了。
 *
 * 其余参数原样透传，所以 `npm run dev`（--dev）和调试参数都不受影响。
 */

const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

/** 会破坏 Electron 启动的环境变量 */
const HOSTILE = ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'];

/** 指向本机回环的死代理：在开发机上很常见，留着会让 Chromium 走一个不存在的代理 */
function isDeadLocalProxy(v) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/?$/i.test(String(v || '').trim());
}

function main() {
  const env = { ...process.env };
  const stripped = [];

  for (const key of HOSTILE) {
    if (env[key] !== undefined && env[key] !== '') {
      stripped.push(`${key}=${String(env[key]).slice(0, 60)}`);
      delete env[key];
    }
  }
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    if (isDeadLocalProxy(env[key])) {
      stripped.push(`${key}=${env[key]}`);
      delete env[key];
    }
  }

  if (stripped.length) {
    console.log('· 已忽略环境里的下列变量（会让 Electron 无法正常启动）：');
    for (const s of stripped) console.log('    ' + s);
  }

  let electron;
  try {
    electron = require(path.join(ROOT, 'node_modules', 'electron'));
  } catch (err) {
    console.error('✗ 找不到 Electron 运行时。请先执行：npm install');
    console.error('  ' + String(err.message || err).split('\n')[0]);
    process.exit(1);
  }

  const args = [ROOT, ...process.argv.slice(2)];
  // 注意不能用 stdio: 'inherit' —— 那样 child.stdout / child.stderr 是 null，
  // 下面想监听输出的代码会直接抛异常（而且异常发生在 spawn 之后，表现成
  // 「应用起来了但提示没打印、退出码也不对」，很难归因）。
  // 改成管道 + 手动转发，既保住终端里的实时输出，也能嗅探内容。
  const child = spawn(electron, args, { stdio: ['inherit', 'pipe', 'pipe'], env, windowsHide: false });

  child.stdout.pipe(process.stdout);

  /* Chromium 起自己的沙箱需要内核授权。在某些受限环境（容器、CI、部分沙箱化终端、
     或者被 AppArmor/seccomp 管得很紧的机器）下会失败，日志里只有一行
     `sandbox initialization failed: Operation not permitted`，
     然后 GPU/网络子进程反复重启，最终整个应用退出 —— 用户完全不知道该怎么办。

     这里把它翻译成一句可操作的建议。注意**不要自动加 --no-sandbox**：
     那会真的降低浏览器的隔离强度，得由用户自己决定。 */
  let sandboxWarned = false;
  let warned = false;
  const watchSandbox = (chunk) => {
    const text = String(chunk || '');
    if (warned) return;
    if (!text.includes('sandbox initialization failed') && !text.includes("GPU process isn't usable")) return;
    warned = true;
    sandboxWarned = true;
    console.error('');
    console.error('────────────────────────────────────────────────────────');
    console.error('Chromium 无法初始化自己的沙箱（Operation not permitted）。');
    console.error('常见于容器、CI、或权限受限的终端环境。');
    console.error('可以这样启动（会降低浏览器隔离强度，仅在确实受限时使用）：');
    console.error('');
    console.error('    npm start -- --no-sandbox');
    console.error('');
    console.error('如果启不来还伴随 GPU 相关报错，再补上：');
    console.error('');
    console.error('    npm start -- --no-sandbox --disable-gpu --in-process-gpu');
    console.error('────────────────────────────────────────────────────────');
    console.error('');
  };
  child.stderr.on('data', (chunk) => { process.stderr.write(chunk); watchSandbox(chunk); });
  child.stdout.on('data', watchSandbox);

  child.on('close', (code, signal) => {
    if (code === null) {
      console.error(`Electron 被信号 ${signal} 终止`);
      process.exit(1);
    }
    // 沙箱失败时 Chromium 常以非 0 退出；已经把建议打印过了，这里不重复
    process.exit(sandboxWarned ? 0 : code);
  });

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { if (!child.killed) child.kill(sig); });
  }
}

if (require.main === module) main();
module.exports = { main };
