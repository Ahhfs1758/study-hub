#!/usr/bin/env node
'use strict';
/**
 * make-app.js —— 零依赖打包脚本
 *
 * 为什么不用 electron-builder：它会去 npm 拉一整套工具链（app-builder-bin、
 * dmg-license 等），在受限网络里经常装不上，而且我们只需要一个能双击的结果。
 * Electron 的二进制本身就是「一个浏览器 + 一个 Node 运行时」，把我们的 app
 * 塞进它的 resources/ 再改一下 Info.plist，就是一个完整可双击的 .app。
 *
 * macOS 产出：release/学习中心.app（改 Info.plist + 注入 app + 生成 .icns + ad-hoc 签名）
 * Windows 产出：release/学习中心-win/ 目录（内含 electron.exe 改名后的 exe 与 resources/app）
 *
 * 用法：
 *   node tools/make-app.js            打包当前平台
 *   node tools/make-app.js --target=mac|win
 *   node tools/make-app.js --zip      额外压出一个 zip（便于拷贝到别的机器）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RELEASE = path.join(ROOT, 'release');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const APP_NAME = PKG.productName || '学习中心';

// 清单与排除项统一放在叶子模块里，避免与 check-bundle 形成循环依赖
const { INCLUDE, EXCLUDE_NAMES } = require('./app-files');

function log(...a) { console.log(...a); }
function die(msg) { console.error('✗ ' + msg); process.exit(1); }
function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', ...opts });
}

/* ------------------------------------------------------------------ *
 * 文件收集
 * ------------------------------------------------------------------ */

function shouldSkip(name) {
  return EXCLUDE_NAMES.has(name) || name.startsWith('.') || name.endsWith('.log');
}

function collect(rel, out = [], base = ROOT) {
  const abs = path.join(base, rel);
  if (!fs.existsSync(abs)) { log('  ! 缺少 ' + rel + '（跳过）'); return out; }
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(abs)) {
      if (shouldSkip(name)) continue;
      collect(path.join(rel, name), out, base);
    }
  } else {
    out.push(rel);
  }
  return out;
}

function copyInto(files, dest) {
  for (const rel of files) {
    const from = path.join(ROOT, rel);
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

/* ------------------------------------------------------------------ *
 * icns 生成（纯手工拼 Apple Icon Image 格式）
 * ------------------------------------------------------------------ */

/**
 * ICNS 是一串「类型 + 长度 + 数据」的块。现代 macOS 只认 PNG 载荷的块，
 * 所以不需要做任何图像编码，把 PNG 原样塞进去即可。
 * 类型码：ic07=128, ic08=256, ic09=512, ic10=1024, ic11=32(@2x), ic12=64, ic13=256(@2x), ic14=512(@2x)
 */
function buildIcns(pngBySize) {
  const map = [
    ['ic11', 32], ['ic12', 64], ['ic07', 128], ['ic13', 256],
    ['ic08', 256], ['ic14', 512], ['ic09', 512], ['ic10', 1024]
  ];
  const chunks = [];
  for (const [type, size] of map) {
    const buf = pngBySize[size];
    if (!buf) continue;
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, 'ascii');
    head.writeUInt32BE(buf.length + 8, 4);
    chunks.push(head, buf);
  }
  if (!chunks.length) return null;
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 4, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

/** 用系统自带的 sips 生成各尺寸 PNG；失败就只用现成的 icon.png */
function iconPngs(tmpDir) {
  const src = path.join(ROOT, 'assets', 'icon.png');
  if (!fs.existsSync(src)) return {};
  const out = { 512: fs.readFileSync(src) };
  if (process.platform !== 'darwin') return out;
  for (const size of [32, 64, 128, 256, 1024]) {
    const dst = path.join(tmpDir, `icon-${size}.png`);
    try {
      run('/usr/bin/sips', ['-z', String(size), String(size), src, '--out', dst]);
      out[size] = fs.readFileSync(dst);
    } catch (_) { /* 某个尺寸失败不影响整体 */ }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * macOS
 * ------------------------------------------------------------------ */

/** 在 plist 里设置一个 <string> 键：存在就改，不存在就插到 </dict> 之前 */
function setPlistString(text, key, value) {
  const re = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`);
  if (re.test(text)) return text.replace(re, `$1${value}$2`);
  return text.replace(/(\n<\/dict>\s*<\/plist>)/, `\n\t<key>${key}</key>\n\t<string>${value}</string>$1`);
}

/** 在 plist 里设置一个布尔键 */
function setPlistBool(text, key, value) {
  const node = `\n\t<key>${key}</key>\n\t${value ? '<true/>' : '<false/>'}`;
  const re = new RegExp(`\\n\\t<key>${key}</key>\\s*\\n\\t<(true|false)/>`);
  if (re.test(text)) return text.replace(re, node);
  return text.replace(/(\n<\/dict>\s*<\/plist>)/, node + '$1');
}

function buildMac() {
  const src = path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app');
  if (!fs.existsSync(src)) die('找不到 Electron.app，请先 npm install（路径：' + src + '）');

  const outDir = path.join(RELEASE, APP_NAME + '.app');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(RELEASE, { recursive: true });
  log('· 复制 Electron.app（约 250MB，稍等）…');
  run('/bin/cp', ['-R', src, outDir]);

  const contents = path.join(outDir, 'Contents');
  const macos = path.join(contents, 'MacOS');
  const frameworks = path.join(contents, 'Frameworks');

  /* ------------------------------------------------------------------ *
   * 改名策略（这里极易踩坑，每一步都有明确原因）
   *
   * 🔴 **绝对不能改 `Electron Framework.framework` 的名字**。
   * 主二进制和所有 Helper 里都写着 `@rpath/Electron Framework.framework/Electron Framework`
   * 这条硬编码的加载路径；把 Framework 目录改成别的名字，dyld 直接报
   * `Library not loaded`，表现是「双击完全没反应」（或者只在日志里留一行）。
   * 这是「把 Electron 改名成自己的 app」最常翻的车。
   *
   * ✅ 需要改的是：
   *   Contents/MacOS/Electron                → <APP_NAME>          （顶层可执行文件）
   *   Contents/Frameworks/Electron Helper*.app → <APP_NAME> Helper*.app
   *     ↳ 每个 .app 内部的 Contents/MacOS/<exe> 与 Info.plist 要同步改
   *
   * 为什么 Helper 必须改名：Chromium 是按主 bundle 的 CFBundleName 去推导
   * 「<名字> Helper.app」这个路径来找子进程的。改了 CFBundleName 却不同步改 Helper，
   * 应用能起来但渲染进程起不来 —— 用户看到的是一个白窗口，且没有任何报错提示。
   * ------------------------------------------------------------------ */

  log('· 改名（保留 Framework 原名，只改可执行文件与 Helper）…');
  const exeOld = path.join(macos, 'Electron');
  const exeNew = path.join(macos, APP_NAME);
  if (fs.existsSync(exeOld)) fs.renameSync(exeOld, exeNew);

  const helperSuffixes = ['', ' (GPU)', ' (Plugin)', ' (Renderer)', ' (Alerts)', ' (Sniffer)'];
  for (const suffix of helperSuffixes) {
    const oldApp = path.join(frameworks, 'Electron Helper' + suffix + '.app');
    if (!fs.existsSync(oldApp)) continue;
    const newName = APP_NAME + ' Helper' + suffix;
    const newApp = path.join(frameworks, newName + '.app');
    fs.renameSync(oldApp, newApp);

    const hMacos = path.join(newApp, 'Contents', 'MacOS');
    const oldExe = path.join(hMacos, 'Electron Helper' + suffix);
    const newExe = path.join(hMacos, newName);
    if (fs.existsSync(oldExe)) fs.renameSync(oldExe, newExe);

    const hPlist = path.join(newApp, 'Contents', 'Info.plist');
    if (fs.existsSync(hPlist)) {
      let t = fs.readFileSync(hPlist, 'utf8');
      /* Electron 的 Helper plist 里**原本没有** CFBundleExecutable，
         它依赖「bundle 名 = 可执行文件名」这条隐式规则。我们显式写上去，
         是为了不依赖隐式行为 —— 以后有人改了 .app 的名字却忘了改二进制名，
         显式声明能让问题在打包校验阶段就被抓到，而不是等到双击没反应。 */
      t = setPlistString(t, 'CFBundleExecutable', newName);
      t = setPlistString(t, 'CFBundleName', newName);
      t = setPlistString(t, 'CFBundleDisplayName', newName);
      fs.writeFileSync(hPlist, t, 'utf8');
    }
    log('    ' + newName + '.app');
  }

  /* ------------------------------------------------------------------ *
   * 中途做一次轻量自检：只确认改名没把 Mach-O 依赖改坏。
   *
   * 「Framework 被误改名」是最常见也最难查的一类失败（双击毫无反应、没有任何提示），
   * 所以发现得越早越好 —— 不值得等整个包打完再报错。
   *
   * 用的是自己写的 Mach-O 解析（tools/check-bundle.js），不是系统 otool：
   * 本机的 otool 遇到含空格的路径会在空格处截断，而 `学习中心 Helper (GPU)` 这种
   * 名字恰恰是标准形态 —— 结果就是三个 Helper 被静默跳过，闸门形同虚设。
   * 注意此时应用代码和签名都还没做，所以只挑「依赖是否可解析」这一项看。
   * ------------------------------------------------------------------ */
  {
    const { parseMachO } = require('./check-bundle');
    const frameworksDir = frameworks;
    const bins = [];
    for (const f of fs.readdirSync(macos)) bins.push(path.join(macos, f));
    for (const e of fs.readdirSync(frameworksDir)) {
      if (!e.endsWith('.app')) continue;
      const hm = path.join(frameworksDir, e, 'Contents', 'MacOS');
      if (!fs.existsSync(hm)) continue;
      for (const f of fs.readdirSync(hm)) bins.push(path.join(hm, f));
    }
    const broken = [];
    let parsed = 0;
    for (const bin of bins) {
      const info = parseMachO(bin);
      if (!info) continue;
      parsed++;
      for (const dep of info.deps) {
        if (!dep.startsWith('@rpath/')) continue;
        const rel = dep.slice('@rpath/'.length);
        if (!fs.existsSync(path.join(frameworksDir, rel))) broken.push(`${path.basename(bin)} → 找不到 ${dep}`);
      }
    }
    if (broken.length) {
      die('改名破坏了动态库引用，打包已中止。\n' +
        broken.map((b) => '  ✗ ' + b).join('\n') +
        '\n  最常见的原因是把 Electron Framework.framework 改名了 —— 它的名字必须保持原样。');
    }
    log(`· 依赖自检：${parsed} 个可执行文件的 @rpath 引用全部可解析`);
  }

  log('· 注入应用代码…');
  const resources = path.join(contents, 'Resources');
  const appDir = path.join(resources, 'app');
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.mkdirSync(appDir, { recursive: true });
  const files = [];
  for (const rel of INCLUDE) collect(rel, files);
  copyInto(files, appDir);
  log(`  已打入 ${files.length} 个文件`);

  // 顺手把 Electron 自带的默认图标换掉
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-icons-'));
  const icns = buildIcns(iconPngs(tmp));
  if (icns) {
    fs.writeFileSync(path.join(resources, 'icon.icns'), icns);
    log('  已生成 icon.icns');
  } else {
    log('  ! 没能生成 icns，将沿用 Electron 默认图标');
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

  log('· 改写 Info.plist…');
  const plist = path.join(contents, 'Info.plist');
  let p = fs.readFileSync(plist, 'utf8');
  p = setPlistString(p, 'CFBundleName', APP_NAME);
  p = setPlistString(p, 'CFBundleDisplayName', APP_NAME);
  p = setPlistString(p, 'CFBundleExecutable', APP_NAME);
  p = setPlistString(p, 'CFBundleIdentifier', PKG.build.appId);
  p = setPlistString(p, 'CFBundleShortVersionString', PKG.version);
  p = setPlistString(p, 'CFBundleVersion', PKG.version);
  p = setPlistString(p, 'CFBundleIconFile', 'icon.icns');
  p = setPlistString(p, 'NSHumanReadableCopyright', '');
  p = setPlistString(p, 'LSApplicationCategoryType', 'public.app-category.education');
  p = setPlistBool(p, 'NSHighResolutionCapable', true);
  p = setPlistBool(p, 'LSMultipleInstancesProhibited', false);
  fs.writeFileSync(plist, p, 'utf8');

  // 去掉隔离属性 + ad-hoc 签名。不重新签名的话（改名会让原签名失效），
  // Apple Silicon 上会直接闪退，用户看到的同样只是「双击没反应」。
  log('· 清理隔离属性并做 ad-hoc 签名…');
  try { run('/usr/bin/xattr', ['-cr', outDir]); } catch (_) {}
  try {
    run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', outDir], { stdio: 'pipe' });
    log('  签名完成');
  } catch (err) {
    log('  ! ad-hoc 签名失败（不影响本机使用，但换机器可能被 Gatekeeper 拦下）');
    log('    ' + String(err.stderr || err.message || err).split('\n')[0]);
  }

  log('');
  log('· 完整校验打包产物…');
  const { check } = require('./check-bundle');
  const results = check(outDir);
  for (const r of results) if (r.level !== 'ok') log(`    ${r.level === 'fail' ? '✗' : '!'} ${r.msg}`);
  const failed = results.filter((r) => r.level === 'fail');
  if (failed.length) {
    die('打包产物校验不通过（' + failed.length + ' 项）。\n' +
      failed.map((r) => '  ✗ ' + r.msg).join('\n'));
  }
  log(`    ✓ ${results.filter((r) => r.level === 'ok').length} 项检查全部通过`);

  log('');
  log('✓ 打包完成：' + outDir);
  log('  双击即可运行。第一次打开若提示「来自身份不明的开发者」，右键 → 打开。');
  return outDir;
}
/* ------------------------------------------------------------------ *
 * Windows
 * ------------------------------------------------------------------ */

function buildWin() {
  const src = path.join(ROOT, 'node_modules', 'electron', 'dist');
  if (!fs.existsSync(src)) die('找不到 Electron 目录，请先 npm install');
  const exeSrc = path.join(src, 'electron.exe');
  if (!fs.existsSync(exeSrc)) {
    die('当前 node_modules 里是 macOS 版的 Electron（没有 electron.exe）。\n' +
      '  在 Windows 上执行 npm install 之后再运行本脚本，即可产出 Windows 包。');
  }

  const outDir = path.join(RELEASE, APP_NAME + '-win');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  log('· 复制 Electron 运行时…');
  run('/bin/sh', ['-c', `cp -R "${src}/." "${outDir}/"`]);
  try { fs.renameSync(path.join(outDir, 'electron.exe'), path.join(outDir, APP_NAME + '.exe')); } catch (_) {}

  const appDir = path.join(outDir, 'resources', 'app');
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.mkdirSync(appDir, { recursive: true });
  const files = [];
  for (const rel of INCLUDE) collect(rel, files);
  copyInto(files, appDir);
  log(`  已打入 ${files.length} 个文件`);

  log('');
  log('✓ 打包完成：' + outDir);
  log('  把整个目录拷到 Windows 上，双击 ' + APP_NAME + '.exe 即可运行。');
  return outDir;
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function main() {
  const args = process.argv.slice(2);
  const targetArg = (args.find((a) => a.startsWith('--target=')) || '').split('=')[1];
  const target = targetArg || (process.platform === 'win32' ? 'win' : 'mac');

  log(`打包 ${APP_NAME} v${PKG.version} → ${target}`);
  const out = target === 'mac' ? buildMac() : buildWin();

  if (args.includes('--zip')) {
    const zip = out + '.zip';
    log('· 压缩…');
    try {
      run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', out, zip]);
      log('✓ 已生成 ' + zip);
    } catch (err) {
      log('! 压缩失败：' + String(err.message || err).split('\n')[0]);
    }
  }
}

if (require.main === module) main();
module.exports = { buildIcns, INCLUDE, APP_NAME };
