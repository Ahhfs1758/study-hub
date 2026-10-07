#!/usr/bin/env node
'use strict';
/**
 * verify.js —— 在真实浏览器里验收网页版
 *
 * 关键点：它跑的**不是另一套测试**，而是桌面版那份 `src/main/journey.js` 的
 * 同一份 19 项界面流程断言。两个环境跑同一套断言，就得到了
 * 「网页版和桌面版行为一致」的直接证据 —— 而不是靠人肉比对两边截图。
 *
 * 流程：
 *   1. 起一个本地静态服务（serving web/dist）
 *   2. 无头 Chrome 打开它
 *   3. 把 journey 的 deps 接到 CDP 上（evalJs → Runtime.evaluate，shot → 截图）
 *   4. 收集页面 console 错误
 *   5. 截图存到 web/.verify/
 *
 * 用法：
 *   node web/verify.js              无头
 *   node web/verify.js --headful    看得见窗口（排查用）
 *   node web/verify.js --url=...    不启服务，直接验证某个地址（例如线上 Vercel）
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(__dirname, 'dist');
const OUT = path.join(__dirname, '.verify');

const { launch } = require('../tools/cdp');
const journey = require('../src/main/journey');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};

/** 极简静态服务：只服务 dist 目录，不做任何路径穿越 */
function serve(port) {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/' || rel === '') rel = '/index.html';
    const full = path.join(DIST, rel.replace(/^\/+/, ''));
    if (!full.startsWith(DIST) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
    res.end(fs.readFileSync(full));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function main() {
  const args = process.argv.slice(2);
  const headful = args.includes('--headful');
  const urlArg = (args.find((a) => a.startsWith('--url=')) || '').split('=')[1];

  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error('✗ 还没有构建产物，先执行：npm run build:web');
    process.exit(1);
  }

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const PORT = 8953 + Math.floor(Math.random() * 200);
  let server = null;
  let url = urlArg;
  if (!url) {
    server = await serve(PORT);
    url = `http://127.0.0.1:${PORT}/`;
    console.log(`本地服务：${url}（根目录 web/dist）`);
  } else {
    console.log(`直接验证：${url}`);
  }

  console.log('启动无头浏览器…');
  const browser = await launch({ port: 9300 + Math.floor(Math.random() * 300), headless: !headful });

  let failed = 0;
  try {
    await browser.goto(url, { waitMs: 1400 });

    // 页面到底有没有起来？先给一个明确的判断，而不是让后面的断言全部"找不到元素"
    const boot = await browser.evaluate(`({
      hasApi: typeof window.api === 'object' && !!window.api,
      hasSH: typeof window.SH === 'object' && !!window.SH,
      navItems: document.querySelectorAll('.nav-item').length,
      title: document.title,
      viewNodes: document.getElementById('view') ? document.getElementById('view').querySelectorAll('*').length : 0
    })`);
    console.log(`页面：title="${boot.title}" nav=${boot.navItems} 视图节点=${boot.viewNodes} api=${boot.hasApi} SH=${boot.hasSH}`);
    if (!boot.hasApi || !boot.hasSH || boot.navItems < 5 || boot.viewNodes < 10) {
      console.error('✗ 页面没有正常启动 —— 后面的流程断言没有意义，先看控制台错误');
      for (const e of browser.consoleErrors.slice(0, 10)) console.error('   ' + e.split('\n')[0]);
      await browser.screenshot(path.join(OUT, 'boot-failed.png'));
      throw new Error('网页版启动失败');
    }
    await browser.screenshot(path.join(OUT, '00-初始界面.png'));

    /* ---- 把 journey 的 deps 接到 CDP 上 ---- */
    const deps = {
      evalJs: (code) => browser.evaluate(code),
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
      /** journey 用它断言「数据真的落盘了」。网页版的数据在页面里的 store 上，
          通过 window.api.snapshot() 取 —— 这和桌面版读的是同一份 store 代码 */
      readDb: async () => {
        const snap = await browser.evaluate('window.api.snapshot()');
        return snap.db;
      },
      shot: async (name) => {
        const f = path.join(OUT, `journey-${name}.png`);
        await browser.screenshot(f);
        return f;
      }
    };

    console.log('\n  ── 界面级端到端流程（与桌面版同一套断言）──');
    const jr = await journey.run({}, OUT, deps);

    // 每个视图再截一张，便于人工复核
    for (const v of ['dashboard', 'focus', 'plans', 'materials', 'srs', 'stats', 'review', 'settings']) {
      await browser.evaluate(`window.SH.app.go(${JSON.stringify(v)}); true`).catch(() => {});
      await new Promise((r) => setTimeout(r, 700));
      await browser.screenshot(path.join(OUT, `${v}.png`));
    }

    const consoleErrors = browser.consoleErrors.filter((e) => !/favicon|net::ERR/i.test(e));

    const report = {
      url,
      at: new Date().toISOString(),
      boot,
      journey: jr.summary,
      failed: jr.results.filter((r) => !r.ok),
      consoleErrors,
      ok: jr.ok && consoleErrors.length === 0
    };
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

    console.log('');
    if (consoleErrors.length) {
      console.log(`控制台错误 ${consoleErrors.length} 条：`);
      for (const e of consoleErrors.slice(0, 8)) console.log('  · ' + String(e).split('\n')[0]);
      failed++;
    } else {
      console.log('✓ 控制台无错误');
    }
    if (!jr.ok) {
      failed++;
      console.log('未通过的流程断言：');
      for (const r of report.failed) console.log('  · ' + r.step + '  ' + JSON.stringify(r).slice(0, 220));
    }
    console.log(`\n截图 ${fs.readdirSync(OUT).filter((f) => f.endsWith('.png')).length} 张 → web/.verify/`);

    await browser.close();
    if (server) server.close();

    if (failed) { console.log('\n✗ 网页版验收未通过'); process.exit(1); }
    console.log('\n✓ 网页版验收通过（与桌面版同一套流程断言）');
  } catch (err) {
    try { await browser.screenshot(path.join(OUT, 'crash.png')); } catch (_) {}
    console.error('\n✗ ' + String(err && err.message || err));
    for (const e of (browser.consoleErrors || []).slice(0, 8)) console.error('   ' + String(e).split('\n')[0]);
    try { await browser.close(); } catch (_) {}
    if (server) server.close();
    process.exit(1);
  }
}

if (require.main === module) main();
