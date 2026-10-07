#!/usr/bin/env node
'use strict';
/**
 * build.js —— 把主进程的 CommonJS 模块打成浏览器可用的 bundle，并产出 dist/
 *
 * 为什么自己写而不是上 webpack / esbuild：
 *   1. 这个项目是**零构建**的（渲染层就是几个 `<script>` 标签）。引入一整套打包工具链
 *      会让「拷到任何机器都能直接跑」这个前提失效 —— 而它正是本项目最重要的性质之一。
 *   2. 需要的功能极窄：本地相对 require + 几个 Node 核心模块的垫片。
 *      一个 200 行的模块注册表就够了，而且出问题时每一步都能读懂。
 *
 * 产出 dist/：
 *   ├── bundle.js          主进程共用模块 + 垫片 + 装配层
 *   ├── index.html         网页版外壳
 *   ├── ui.js / charts.js … 从 src/renderer 复制（**同一份源码**）
 *   └── vercel.json        静态站配置
 *
 * 关键点：渲染层文件是**复制**而不是重写。网页版和桌面版跑的是同一个界面。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(__dirname, 'dist');

/** 入口模块（依赖会被自动带上） */
const ENTRIES = ['web/boot.js'];

/** 裸模块名 → 垫片文件 */
const CORE_SHIMS = {
  fs: 'web/shims/node-shims.js',
  path: 'web/shims/node-shims.js',
  crypto: 'web/shims/node-shims.js',
  os: 'web/shims/node-shims.js',
  child_process: 'web/shims/node-shims.js',
  url: 'web/shims/node-shims.js',
  events: 'web/shims/node-shims.js',
  electron: 'web/shims/electron-shim.js'
};

/** 从 node-shims.js 按名字取子导出 */
const SHIM_EXPORTS = new Set(['fs', 'path', 'crypto', 'os', 'child_process', 'url', 'events']);

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

/** 把 `require('./util')` 解析成规范路径 */
function resolveSpec(fromRel, spec) {
  if (CORE_SHIMS[spec]) return { core: spec, shim: CORE_SHIMS[spec] };
  if (!spec.startsWith('.')) {
    throw new Error(`${fromRel} 引入了未支持的模块 "${spec}"（网页版没有 node_modules）`);
  }
  const base = path.posix.join(path.posix.dirname(fromRel), spec);
  for (const cand of [base + '.js', path.posix.join(base, 'index.js'), base]) {
    if (exists(cand) && fs.statSync(path.join(ROOT, cand)).isFile()) return { id: cand };
  }
  throw new Error(`${fromRel} 找不到 "${spec}"（试过 ${base}.js）`);
}

/** 广度优先收集所有需要的模块 */
function collect() {
  const included = new Map();       // 规范路径 → 源码
  const shims = new Set();          // 需要注入的核心模块名
  const queue = ENTRIES.map((e) => ({ from: null, id: e }));

  while (queue.length) {
    const { from, id } = queue.shift();
    if (included.has(id)) continue;
    const src = read(id);
    included.set(id, src);

    const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(src))) {
      const r = resolveSpec(id, m[1]);
      if (r.core) {
        shims.add(r.core);
        if (!included.has(r.shim)) queue.push({ from: id, id: r.shim });
      } else if (!included.has(r.id)) {
        queue.push({ from: id, id: r.id });
      }
    }
  }
  return { included, shims };
}

function buildBundle() {
  const { included, shims } = collect();
  const names = [...included.keys()].sort();

  const out = [];
  out.push(`/* 学习中心 · 网页版 bundle
 *
 * 由 web/build.js 自动生成 —— 请勿手工修改，改源码后重新执行：npm run build:web
 *
 * 内容：
 *   · 主进程共用模块（store / analytics / ipc / rules …）
 *   · Node 与 Electron 的浏览器垫片（localStorage 文件系统等）
 *   · 装配层（web/boot.js）
 *
 * 这里没有第二份业务逻辑：store、统计、间隔重复、IPC handler 全都是桌面版那一份。
 */
(function () {
'use strict';

var __reg = {};
var __cache = {};

function __def(name, fn) { __reg[name] = fn; }

function __norm(p) {
  var out = [], abs = p.charAt(0) === '/';
  var segs = String(p).split('/');
  for (var i = 0; i < segs.length; i++) {
    var s = segs[i];
    if (!s || s === '.') continue;
    if (s === '..') { out.pop(); continue; }
    out.push(s);
  }
  return (abs ? '/' : '') + out.join('/');
}

function __resolve(from, spec) {
  if (spec.charAt(0) !== '.') return spec;
  var dir = from ? from.slice(0, from.lastIndexOf('/') + 1) : '';
  var base = __norm(dir + spec);
  if (__reg[base + '.js']) return base + '.js';
  if (__reg[base + '/index.js']) return base + '/index.js';
  return base;
}

/* 核心模块映射 —— **由 web/build.js 从 CORE_SHIMS 生成**，不要手写。
   手写过的后果：Node 侧的解析表里有 electron、运行时这张表漏了，
   于是报「模块没打进包：electron（被 notifier.js 引入）」—— 顺着报错去查 notifier.js 会一无所获。 */
var CORE = {"child_process": "web/shims/node-shims.js", "crypto": "web/shims/node-shims.js", "electron": "web/shims/electron-shim.js", "events": "web/shims/node-shims.js", "fs": "web/shims/node-shims.js", "os": "web/shims/node-shims.js", "path": "web/shims/node-shims.js", "url": "web/shims/node-shims.js"};
/* 这些名字要把垫片模块的**子导出**返回（fs → shims.fs）；
   electron 不在此列 —— require('electron') 返回的就是整个 electron-shim 的导出。 */
var CORE_SUB = {"child_process": 1, "crypto": 1, "events": 1, "fs": 1, "os": 1, "path": 1, "url": 1};


function __req(from, spec) {
  var id = __resolve(from, spec);
  if (__cache[id]) return __cache[id].exports;
  if (!__reg[id]) {
    if (CORE[id]) {
      var shim = __req('', CORE[id]);
      return CORE_SUB[id] ? shim[id] : shim;
    }
    throw new Error('[bundle] 模块没打进包：' + id + '（被 "' + from + '" 引入）');
  }
  var mod = { exports: {}, id: id };
  __cache[id] = mod;
  __reg[id].call(mod.exports, mod, mod.exports, function (s) { return __req(id, s); });
  return mod.exports;
}
`);

  for (const name of names) {
    // 缩进保持原样即可；模块体在函数作用域里，不会污染全局
    out.push(`__def(${JSON.stringify(name)}, function (module, exports, require) {\n${included.get(name)}\n});\n`);
  }

  out.push(`
/* 入口 */
__req('', ${JSON.stringify(ENTRIES[0])});

})();
`);

  return { code: out.join('\n'), files: names.length, shims: [...shims].sort() };
}

/* ------------------------------------------------------------------ *
 * dist/index.html
 * ------------------------------------------------------------------ */
/**
 * 网页版外壳 —— **从 src/renderer/index.html 变换而来**，不是另写一份。
 *
 * 🔴 一开始我是手写这个 HTML 的，结果漏掉了 `#miniToggle` 那个按钮，
 * 页面直接抛 `Cannot read properties of null (reading 'addEventListener')`，
 * 整个视图渲染不出来。手写外壳的每一个标签都可能漏 ——
 * 而渲染层的 app.js 是按完整结构写的，少一个 id 就崩。
 * 所以改成：读真实文件 → 只做必要的三处替换 → 输出。
 * 这样两端的外壳结构永远一致。
 */
function htmlShell() {
  let html = read('src/renderer/index.html');

  // 1) CSP：桌面版是 file:// 加载，网页版是 http(s)，需要放行 blob:（导出下载用）
  html = html.replace(
    /<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>/,
    `<meta http-equiv="Content-Security-Policy"\n        content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'" />`
  );

  // 2) 标题与移动端视口
  html = html.replace('<title>学习中心</title>', '<title>学习中心 · 网页版</title>');
  html = html.replace('<meta charset="UTF-8" />',
    '<meta charset="UTF-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1" />\n  <link rel="icon" href="assets/icon.png" />');

  // 3) 在**第一个**渲染层脚本之前插入 bundle.js（它定义 window.api，必须先跑）
  const firstScript = html.indexOf('  <script src="ui.js">');
  if (firstScript < 0) throw new Error('index.html 里找不到渲染层脚本的起始位置');
  html = html.slice(0, firstScript)
    + '  <!-- 主进程共用模块 + 浏览器垫片 + window.api —— 必须先于渲染层 -->\n'
    + '  <script src="bundle.js"></script>\n'
    + html.slice(firstScript);

  return html;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
function main() {
  console.log('打包网页版 → web/dist/');

  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  // 1) bundle
  const { code, files, shims } = buildBundle();
  fs.writeFileSync(path.join(DIST, 'bundle.js'), code, 'utf8');
  console.log(`· bundle.js：${files} 个模块，${(code.length / 1024).toFixed(1)} KB`);
  console.log(`  核心模块垫片：${shims.join(', ')}`);

  // 2) 复制渲染层（同一份源码，不是副本）
  const renderer = path.join(ROOT, 'src', 'renderer');
  const walk = (dir, rel = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const from = path.join(dir, entry.name);
      const to = path.join(DIST, rel, entry.name);
      if (entry.isDirectory()) { fs.mkdirSync(to, { recursive: true }); walk(from, path.join(rel, entry.name)); }
      else fs.copyFileSync(from, to);
    }
  };
  walk(renderer);
  // 渲染层自带的 index.html 是给 Electron 用的（没有 bundle.js），换成网页版外壳
  fs.writeFileSync(path.join(DIST, 'index.html'), htmlShell(), 'utf8');
  console.log('· 已复制渲染层（ui.js / charts.js / views/* …）');

  // 3) 图标：把 assets 里的 png 复制过去当 favicon
  const assets = path.join(ROOT, 'assets');
  if (fs.existsSync(assets)) {
    fs.mkdirSync(path.join(DIST, 'assets'), { recursive: true });
    for (const f of fs.readdirSync(assets)) {
      if (/\.(png|svg|ico)$/i.test(f)) fs.copyFileSync(path.join(assets, f), path.join(DIST, 'assets', f));
    }
    // favicon 指向已有图标
    let html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
    html = html.replace('</title>', '</title>\n  <link rel="icon" href="assets/icon.png" />');
    fs.writeFileSync(path.join(DIST, 'index.html'), html, 'utf8');
  }

  // 4) Vercel 配置
  fs.writeFileSync(path.join(DIST, 'vercel.json'), JSON.stringify({
    version: 2,
    cleanUrls: true,
    headers: [
      {
        // 静态资源长缓存；index.html 不缓存，避免用户拿到旧版本
        source: '/(.*)\\.(js|css|png|svg|ico|woff2)',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }]
      },
      {
        source: '/index.html',
        headers: [{ key: 'Cache-Control', value: 'no-cache' }]
      },
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' }
        ]
      }
    ]
  }, null, 2) + '\n', 'utf8');
  console.log('· vercel.json');

  // 5) 自检：确认 dist 里没有指向仓库外的引用
  const idx = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const bad = [...idx.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => /^https?:|^\/\//.test(u) || u.includes('..'));
  if (bad.length) {
    console.error('✗ index.html 里有外部或越界引用：' + bad.join(', '));
    process.exit(1);
  }
  console.log('· 引用检查通过（无外链）');

  const total = fs.readdirSync(DIST).length;
  console.log(`\n✓ 完成：web/dist/（${total} 项）`);
  console.log('  本地预览：npm run serve:web');
  console.log('  部署：    npm run deploy:web');
}

if (require.main === module) main();
module.exports = { buildBundle, htmlShell, DIST, ROOT };
