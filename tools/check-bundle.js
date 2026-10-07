#!/usr/bin/env node
'use strict';
/**
 * check-bundle.js —— 打包产物静态校验
 *
 * 为什么要有这个脚本：打包失败在 GUI 上**没有任何提示**。用户双击一下，
 * 什么都没发生，既没有报错窗口也没有日志入口，于是「打包好了但打不开」
 * 这种问题极难定位。所有能提前静态查出来的问题都在这里查掉：
 *
 *   1. 必需的可执行文件 / Helper 是否都在，且名字与 Info.plist 声明一致
 *   2. Electron Framework 是否保持原名（改了它 dyld 直接找不到库）
 *   3. 每个 Mach-O 的 @rpath 依赖是否都能在本 bundle 内真实解析
 *   4. ad-hoc 签名是否有效（签名失效 = Apple Silicon 上双击闪退）
 *   5. 有没有把自检产物之类的垃圾打进去
 *
 * 🔴 第 3 条**不能**用系统的 otool 来做：这台机器上的 otool 是 otool-classic 的包装，
 * 遇到含空格或圆括号的路径会在空格处截断，报「can't open file: .../学习中心 Helper」——
 * 而 `学习中心 Helper (GPU)` 这种名字恰恰是标准形态。更糟的是它会返回非零退出码，
 * 于是调用方如果用 try/catch 忽略错误，校验就被**静默跳过**，看起来一切正常。
 * 所以这里直接解析 Mach-O 的 load commands，不依赖任何外部工具。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/* ------------------------------------------------------------------ *
 * Mach-O 解析
 * ------------------------------------------------------------------ */

const MH_MAGIC_64 = 0xfeedfacf;
const MH_CIGAM_64 = 0xcffaedfe;
const MH_MAGIC = 0xfeedface;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;

// 会带来「运行时需要能找到这个库」的 load command
const DYLIB_CMDS = new Set([
  0x0c,          // LC_LOAD_DYLIB
  0x18 | 0x80000000,  // LC_LOAD_WEAK_DYLIB
  0x1f | 0x80000000,  // LC_REEXPORT_DYLIB
  0x23 | 0x80000000,  // LC_LOAD_UPWARD_DYLIB
  0x20,          // LC_LAZY_LOAD_DYLIB
  0x0d           // LC_ID_DYLIB
]);
const LC_RPATH = 0x1c;

/** 读一个以 NUL 结尾的字符串 */
function cstr(buf, offset, max) {
  if (offset < 0 || offset >= buf.length) return '';
  let end = offset;
  const limit = Math.min(buf.length, offset + (max || 4096));
  while (end < limit && buf[end] !== 0) end++;
  return buf.toString('utf8', offset, end);
}

/** 从一段（非 fat 的）Mach-O 数据里取出所有 @rpath 依赖与 rpath 搜索路径 */
function parseThin(buf) {
  if (buf.length < 32) return null;
  const magic = buf.readUInt32LE(0);
  if (magic !== MH_MAGIC_64 && magic !== MH_MAGIC) return null;
  const is64 = magic === MH_MAGIC_64;
  const headerSize = is64 ? 32 : 28;
  const ncmds = buf.readUInt32LE(16);
  let off = headerSize;

  const deps = [];
  const rpaths = [];
  for (let i = 0; i < ncmds && off + 8 <= buf.length; i++) {
    const cmd = buf.readUInt32LE(off);
    const cmdsize = buf.readUInt32LE(off + 4);
    if (cmdsize < 8 || off + cmdsize > buf.length) break;

    if (DYLIB_CMDS.has(cmd)) {
      // dylib_command: cmd, cmdsize, name.offset, timestamp, current_version, compatibility_version
      const nameOff = buf.readUInt32LE(off + 8);
      const name = cstr(buf, off + nameOff, cmdsize);
      if (name) deps.push(name);
    } else if (cmd === LC_RPATH) {
      const pathOff = buf.readUInt32LE(off + 8);
      const p = cstr(buf, off + pathOff, cmdsize);
      if (p) rpaths.push(p);
    }
    off += cmdsize;
  }
  return { deps, rpaths };
}

/** 处理 fat（通用）二进制：逐片解析后合并 */
function parseMachO(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (_) { return null; }
  if (buf.length < 8) return null;
  const magic = buf.readUInt32BE(0);

  if (magic === FAT_MAGIC || magic === FAT_MAGIC_64) {
    const nfat = buf.readUInt32BE(4);
    const wide = magic === FAT_MAGIC_64;
    const entrySize = wide ? 32 : 20;
    const deps = [];
    const rpaths = [];
    for (let i = 0; i < nfat; i++) {
      const base = 8 + i * entrySize;
      if (base + entrySize > buf.length) break;
      const sliceOff = wide ? Number(buf.readBigUInt64BE(base + 8)) : buf.readUInt32BE(base + 8);
      const sliceSize = wide ? Number(buf.readBigUInt64BE(base + 16)) : buf.readUInt32BE(base + 12);
      const slice = buf.subarray(sliceOff, sliceOff + sliceSize);
      const r = parseThin(slice);
      if (r) { deps.push(...r.deps); rpaths.push(...r.rpaths); }
    }
    return { deps, rpaths, fat: nfat };
  }

  const r = parseThin(buf);
  return r ? { ...r, fat: 0 } : null;
}

/* ------------------------------------------------------------------ *
 * 检查
 * ------------------------------------------------------------------ */

function check(appPath) {
  const results = [];
  const ok = (msg) => results.push({ level: 'ok', msg });
  const fail = (msg) => results.push({ level: 'fail', msg });
  const warn = (msg) => results.push({ level: 'warn', msg });

  if (!fs.existsSync(appPath)) {
    fail('找不到 bundle：' + appPath);
    return results;
  }

  const contents = path.join(appPath, 'Contents');
  const plistFile = path.join(contents, 'Info.plist');
  const readKey = (file, key) => {
    try {
      const out = execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, file], { encoding: 'utf8' });
      return out.trim();
    } catch (_) { return ''; }
  };

  const exe = readKey(plistFile, 'CFBundleExecutable');
  const name = readKey(plistFile, 'CFBundleName');
  if (!exe) fail('Info.plist 里没有 CFBundleExecutable');
  else ok(`CFBundleExecutable = ${exe}`);
  if (!name) fail('Info.plist 里没有 CFBundleName');
  else if (exe && name && exe !== name) {
    fail(`CFBundleExecutable(${exe}) 与 CFBundleName(${name}) 不一致 —— Chromium 按 CFBundleName 推导 Helper 路径，不一致会导致子进程起不来`);
  } else if (exe) ok('CFBundleExecutable 与 CFBundleName 一致');

  const macos = path.join(contents, 'MacOS');
  const mainExe = path.join(macos, exe || 'Electron');
  if (exe && fs.existsSync(mainExe)) ok(`主可执行文件存在（${exe}）`);
  else fail(`找不到 Contents/MacOS/${exe}`);

  const frameworks = path.join(contents, 'Frameworks');
  if (!fs.existsSync(frameworks)) {
    fail('没有 Contents/Frameworks 目录');
    return results;
  }

  // Framework 必须保持原名
  if (fs.existsSync(path.join(frameworks, 'Electron Framework.framework'))) {
    ok('Electron Framework.framework 名字未被改动');
  } else {
    fail('Electron Framework.framework 不见了 —— 它必须保持原名，改名后所有二进制都找不到它，启动直接失败');
  }

  // Helper 是否存在且名字自洽
  if (exe) {
    for (const suffix of ['', ' (GPU)', ' (Renderer)', ' (Plugin)']) {
      const hName = `${name} Helper${suffix}`;
      const hApp = path.join(frameworks, hName + '.app');
      if (!fs.existsSync(hApp)) {
        if (suffix === ' (Plugin)') { warn(`缺少 ${hName}.app（一般用不到，Windows 才需要）`); continue; }
        fail(`缺少 ${hName}.app —— 该类型的子进程无法启动`);
        continue;
      }
      const hExe = readKey(path.join(hApp, 'Contents', 'Info.plist'), 'CFBundleExecutable');
      const hBin = path.join(hApp, 'Contents', 'MacOS', hExe || hName);
      if (hExe && fs.existsSync(hBin)) ok(`${hName}.app → ${hExe}`);
      else fail(`${hName}.app 里的可执行文件对不上（Info.plist 声明 ${hExe || '（缺 CFBundleExecutable）'}）`);
    }
  }

  // 逐个二进制校验 @rpath 依赖
  const bins = [];
  if (fs.existsSync(macos)) {
    for (const f of fs.readdirSync(macos)) {
      const full = path.join(macos, f);
      if (fs.statSync(full).isFile()) bins.push(full);
    }
  }
  for (const e of fs.readdirSync(frameworks)) {
    if (!e.endsWith('.app')) continue;
    const hm = path.join(frameworks, e, 'Contents', 'MacOS');
    if (!fs.existsSync(hm)) continue;
    for (const f of fs.readdirSync(hm)) bins.push(path.join(hm, f));
  }

  let checked = 0, unreadable = 0;
  const broken = [];
  for (const bin of bins) {
    const info = parseMachO(bin);
    if (!info) { unreadable++; continue; }
    checked++;
    for (const dep of info.deps) {
      if (!dep.startsWith('@rpath/')) continue;      // 系统库 / 绝对路径不用管
      const rel = dep.slice('@rpath/'.length);
      // @rpath 可能是无框架的裸相对路径，也可能带 framework 前缀；逐个 rpath 试
      const candidates = [path.join(frameworks, rel), path.join(contents, rel)];
      for (const rp of info.rpaths) {
        const expanded = rp.replace('@loader_path', path.dirname(bin)).replace('@executable_path', macos);
        candidates.push(path.join(expanded, rel));
      }
      if (!candidates.some((c) => fs.existsSync(c))) broken.push({ bin: path.basename(bin), dep });
    }
  }
  if (broken.length) {
    for (const b of broken) fail(`${b.bin} → 找不到 ${b.dep}`);
  } else if (checked) {
    ok(`${checked} 个可执行文件的 @rpath 依赖全部可解析`);
  }
  if (unreadable) warn(`${unreadable} 个文件不是 Mach-O（可能是脚本或资源），已跳过`);
  if (!checked) fail('一个可执行文件都没能解析出来 —— 打包八成没做完');

  // 签名
  try {
    execFileSync('/usr/bin/codesign', ['-v', appPath], { stdio: 'pipe' });
    ok('ad-hoc 签名有效');
  } catch (err) {
    const tip = 'Apple Silicon 上签名失效会直接闪退，用户只会看到「双击没反应」';
    fail('签名无效（' + tip + '）');
  }

  // 别把开发垃圾打进去
  const appDir = path.join(contents, 'Resources', 'app');
  for (const junk of ['.selftest', 'release', 'node_modules', '.git', 'backups']) {
    if (fs.existsSync(path.join(appDir, junk))) fail(`包里混进了 ${junk}`);
  }
  if (!fs.existsSync(appDir)) fail('没有 Contents/Resources/app —— 应用代码没打进去');
  else {
    const inner = fs.readdirSync(appDir);
    ok(`应用代码已注入（${inner.length} 项：${inner.slice(0, 6).join(' ')}${inner.length > 6 ? ' …' : ''}）`);
    for (const need of ['main.js', 'preload.js', 'src']) {
      if (!fs.existsSync(path.join(appDir, need))) fail(`应用代码缺少 ${need}`);
    }

    /* 包是不是旧的？
       这是个非常容易掉的坑：改完代码忘了重新打包，双击 .app 跑的还是旧代码，
       然后你会对着一个「明明改了却没生效」的现象排查半天。
       判据不需要额外的构建戳 —— 直接比源文件与包内副本的修改时间。 */
    const stale = [];
    const walk = (rel) => {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) return;
      const st = fs.statSync(abs);
      if (st.isDirectory()) {
        for (const name of fs.readdirSync(abs)) {
          if (name.startsWith('.') || name === 'node_modules') continue;
          walk(path.join(rel, name));
        }
        return;
      }
      // 只在两边都有这个文件时比较（新增文件另算：包内没有 → 也算旧）
      const inPkg = path.join(appDir, rel);
      if (!fs.existsSync(inPkg)) { stale.push({ file: rel, why: '包内还没有这个文件' }); return; }
      if (fs.statSync(inPkg).mtimeMs < st.mtimeMs - 1000) stale.push({ file: rel, why: '源码比包内副本新' });
    };
    // 与 make-app 共用同一份清单（tools/app-files.js），
    // 保证「打包打了什么」和「校验检查什么」永远不会分叉
    const { INCLUDE: include } = require('./app-files');
    for (const rel of include) walk(rel);

    if (stale.length) {
      fail(`打包产物已过期（${stale.length} 个文件比包内副本新），双击它跑的是旧代码。重新打包：npm run pack:mac`);
      for (const s of stale.slice(0, 5)) results.push({ level: 'info', msg: `  过期的文件：${s.file}（${s.why}）` });
    } else {
      ok('打包产物是最新的（源码没有比包内副本更新的文件）');
    }
  }

  return results;
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

if (require.main === module) {
  const target = process.argv[2] || path.join(ROOT, 'release', '学习中心.app');
  const results = check(target);
  console.log('校验 ' + target);
  for (const x of results) {
    const mark = x.level === 'ok' ? '✓' : x.level === 'warn' ? '!' : x.level === 'info' ? ' ' : '✗';
    console.log(`  ${mark} ${x.msg}`);
  }
  const failed = results.filter((r) => r.level === 'fail').length;
  console.log('');
  if (failed) {
    const onlyStale = results.filter((r) => r.level === 'fail').every((r) => r.msg.includes('已过期'));
    console.log(onlyStale
      ? '✗ 包本身是好的，但内容已过期 —— 重新打包即可：npm run pack:mac'
      : `✗ 有 ${failed} 项不通过 —— 这个包双击很可能没反应。重新执行：node tools/make-app.js`);
    process.exit(1);
  }
  console.log('✓ 打包产物完好，可以拷给别人用');
}

module.exports = { check, parseMachO };
