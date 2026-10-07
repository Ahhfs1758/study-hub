#!/usr/bin/env node
'use strict';
/**
 * cdp.js —— 极简 Chrome DevTools Protocol 客户端
 *
 * 为什么自己写：本机 npm install 不稳定（沙箱里 npm cache 容易坏），
 * 而验证网页版**必须**真的开一个浏览器 —— 静态检查不出「点了按钮没反应」这类问题。
 * Node 22 内置了 WebSocket 和 fetch，所以驱动 Chrome 只需要 100 行，
 * 不引入 puppeteer 反而更可靠。
 *
 * 用法：
 *   const browser = await launch({ port: 9222 });
 *   await browser.goto('http://127.0.0.1:8947/');
 *   await browser.eval('1 + 1');
 *   await browser.screenshot('/tmp/a.png');
 *   await browser.close();
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  process.env.CHROME_PATH
].filter(Boolean);

function findChrome() {
  for (const c of CHROME_CANDIDATES) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  throw new Error('找不到 Chrome / Chromium。可以设 CHROME_PATH 环境变量指定路径。');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等调试端口可用 */
async function waitForPort(port, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch (_) { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error(`Chrome 调试端口 ${port} 在 ${timeoutMs}ms 内没起来`);
}

class Browser {
  constructor(proc, port, ws, targetId) {
    this.proc = proc;
    this.port = port;
    this.ws = ws;
    this.targetId = targetId;
    this._id = 0;
    this._pending = new Map();
    this._events = new Map();
  }

  _send(method, params) {
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`CDP 调用超时：${method}`));
        }
      }, 30000);
    });
  }

  on(event, fn) {
    if (!this._events.has(event)) this._events.set(event, []);
    this._events.get(event).push(fn);
    return this;
  }

  /**
   * 在页面里执行 JS 并取回值（自动 await）。
   *
   * 🔴 这里有两个坑，都是踩过才知道的：
   *
   * 1. **不能靠正则猜「函数还是表达式」**：`({a:1})` 和 `(() => 1)` 都以 `(` 开头，
   *    猜错就会把对象字面量当函数调用，报一句
   *    「{(intermediate value)...} is not a function」，完全看不出是包装逻辑的问题。
   *    改成运行时判断：先求值，是函数就调用它。
   *
   * 2. **代码可能不是表达式而是语句序列**：例如 `x(); true;` 或一整段脚本。
   *    塞进 `( ... )` 里必然 SyntaxError。这类调用只用来产生副作用，
   *    拿不到返回值也无所谓，所以 SyntaxError 时退化成「当成函数体执行」。
   */
  async evaluate(expr) {
    const asExpr = `(function(){
      var __v = (${expr});
      return (typeof __v === 'function') ? __v() : __v;
    })()`;
    try {
      return await this._evaluateRaw(asExpr);
    } catch (err) {
      // 只有当失败原因是「语法错误」时才退化成语句形式 ——
      // 其它错误（比如页面里真的抛异常）要原样抛出去，不能悄悄吞掉
      if (!/SyntaxError/i.test(String(err && err.message))) throw err;
      const asBody = `(async function(){\n${expr}\n})()`;
      return await this._evaluateRaw(asBody);
    }
  }

  async _evaluateRaw(expression) {
    const r = await this._send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const msg = (d.exception && (d.exception.description || d.exception.value)) || d.text || '未知错误';
      throw new Error('页面里抛错：' + String(msg).split('\n').slice(0, 4).join('\n'));
    }
    return r.result ? r.result.value : undefined;
  }

  async goto(url, { waitMs = 900 } = {}) {
    await this._send('Page.enable');
    await this._send('Page.navigate', { url });
    // 等 load 事件；没有就按时间兜底
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      this.on('Page.loadEventFired', finish);
      setTimeout(finish, waitMs + 3000);
    });
    await sleep(waitMs);
  }

  async screenshot(file) {
    const r = await this._send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }

  /** 设置视口，保证截图是桌面布局 */
  async setViewport(width, height) {
    await this._send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 2, mobile: false
    });
  }

  async close() {
    try { this.ws.close(); } catch (_) {}
    try { this.proc.kill('SIGKILL'); } catch (_) {}
  }
}

/** 启动 Chrome 并连上第一个页面 target */
async function launch({ port = 9222, headless = true, width = 1440, height = 900 } = {}) {
  const chrome = findChrome();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-cdp-'));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking',
    '--disable-sync', '--disable-features=Translate,MediaRouter',
    '--window-size=' + width + ',' + height,
    'about:blank'
  ];
  if (headless) args.unshift('--headless=new');
  // 沙箱化终端里 Chromium 自己的沙箱常常起不来
  args.unshift('--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage');

  const proc = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += String(d).slice(0, 20000); });

  await waitForPort(port);

  // 找一个 page 类型的 target
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!target) await sleep(300);
  }
  if (!target) { try { proc.kill('SIGKILL'); } catch (_) {} throw new Error('找不到可连接的页面 target\n' + stderr.slice(-800)); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('连不上 Chrome 调试端口'));
  });

  const browser = new Browser(proc, port, ws, target.id);
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (msg.id && browser._pending.has(msg.id)) {
      const { resolve, reject } = browser._pending.get(msg.id);
      browser._pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const fn of browser._events.get(msg.method) || []) {
        try { fn(msg.params); } catch (_) {}
      }
    }
  };

  await browser._send('Runtime.enable');
  await browser._send('Log.enable').catch(() => {});
  await browser.setViewport(width, height);

  // 收集页面控制台错误与未捕获异常
  browser.consoleErrors = [];
  browser.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') {
      browser.consoleErrors.push((p.args || []).map((a) => a.value || a.description || '').join(' '));
    }
  });
  browser.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails || {};
    browser.consoleErrors.push((d.exception && (d.exception.description || d.exception.value)) || d.text || '未知异常');
  });

  return browser;
}

if (require.main === module) {
  (async () => {
    const url = process.argv[2] || 'about:blank';
    const b = await launch({});
    await b.goto(url);
    console.log('标题:', await b.evaluate('document.title'));
    await b.close();
  })().catch((err) => { console.error(String(err && err.stack || err)); process.exit(1); });
}

module.exports = { launch, findChrome };
