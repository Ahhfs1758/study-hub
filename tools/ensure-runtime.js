#!/usr/bin/env node
'use strict';
/**
 * ensure-runtime.js —— 保证 npm 脚本能真的跑起来
 *
 * 解决的问题：`npm install` 只要在中途失败过一次（本机网络环境下很常见，症状是
 * `EEXIST`/`ENOENT stat` 之类），就会出现「包目录在、但 `node_modules/.bin/` 没建出来」
 * 的半成品状态。此时 `npm start` 会报 `electron: command not found`，
 * 而用户完全看不出这和「安装没成功」有关 —— 目录明明都在。
 *
 * 这里做三件事，全部是幂等的：
 *   1. 确认 node_modules/electron/dist 里有可用的 Electron 二进制
 *      （缺失时尝试从本机的 electron 下载缓存里解压，不需要联网）
 *   2. 确认 node_modules/.bin/electron 存在，不存在就补上
 *   3. 跑一次 `--version` 确认它真的能执行
 *
 * 挂成 prestart / predev / precheck / prepack:mac 的前置脚本，所以任何一条 npm 命令
 * 都会先自愈一次。正常安装过的环境下这三步基本是零开销（几个 stat 调用）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ELECTRON_PKG = path.join(ROOT, 'node_modules', 'electron');
const DIST = path.join(ELECTRON_PKG, 'dist');
const BIN_DIR = path.join(ROOT, 'node_modules', '.bin');

const isWin = process.platform === 'win32';
const EXE_REL = isWin ? 'electron.exe' : path.join('Electron.app', 'Contents', 'MacOS', 'Electron');
const EXE = path.join(DIST, EXE_REL);

function log(...a) { console.log(...a); }

/** 本机的 electron 下载缓存目录（electron 的 install.js 用的就是这个） */
function cacheDirs() {
  const home = os.homedir();
  if (process.platform === 'darwin') return [path.join(home, 'Library', 'Caches', 'electron')];
  if (isWin) return [path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'electron', 'Cache')];
  return [path.join(home, '.cache', 'electron')];
}

/** 从缓存 zip 里解出二进制（离线可用） */
function extractFromCache() {
  const version = require(path.join(ELECTRON_PKG, 'package.json')).version;
  const wanted = [
    `electron-v${version}-${process.platform}-${process.arch}.zip`,
    `electron-v${version}-darwin-${process.arch}.zip`
  ];
  for (const dir of cacheDirs()) {
    if (!fs.existsSync(dir)) continue;
    // 缓存可能是平铺的，也可能在哈希子目录里
    const candidates = [];
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      let st;
      try { st = fs.statSync(full); } catch (_) { continue; }
      if (st.isDirectory()) {
        for (const inner of fs.readdirSync(full)) {
          if (wanted.includes(inner)) candidates.push(path.join(full, inner));
        }
      } else if (wanted.includes(entry)) {
        candidates.push(full);
      }
    }
    if (!candidates.length) continue;

    const zip = candidates[0];
    log(`· 从本机缓存解压 Electron：${zip}`);
    fs.mkdirSync(DIST, { recursive: true });
    try {
      if (isWin) {
        execFileSync('powershell.exe', ['-NoProfile', '-Command',
          `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${DIST.replace(/'/g, "''")}' -Force`],
          { stdio: 'pipe' });
      } else {
        execFileSync('/usr/bin/unzip', ['-q', '-o', zip, '-d', DIST], { stdio: 'pipe' });
      }
    } catch (err) {
      log('  ! 解压失败：' + String(err.message || err).split('\n')[0]);
      return false;
    }
    // electron 的 index.js 依赖 path.txt 才知道真正的可执行文件在哪
    fs.writeFileSync(path.join(ELECTRON_PKG, 'path.txt'), EXE_REL.split(path.sep).join('/'), 'utf8');
    return fs.existsSync(EXE);
  }
  return false;
}

/** 补上 node_modules/.bin/electron（npm 只会在 install 成功时创建它） */
function ensureBinLink() {
  const linkJs = path.join(BIN_DIR, 'electron');
  const linkCmd = path.join(BIN_DIR, 'electron.cmd');
  const target = path.join('..', 'electron', 'cli.js');

  if (isWin) {
    if (fs.existsSync(linkCmd)) return true;
    fs.mkdirSync(BIN_DIR, { recursive: true });
    fs.writeFileSync(linkCmd, '@echo off\r\nnode "%~dp0\\..\\electron\\cli.js" %*\r\n', 'utf8');
    log('· 已补上 node_modules/.bin/electron.cmd');
    return true;
  }

  // 已经存在且指向正确就什么都不做
  try {
    if (fs.lstatSync(linkJs).isSymbolicLink() && fs.readlinkSync(linkJs) === target) return true;
    if (fs.existsSync(linkJs) || fs.lstatSync(linkJs)) return true;   // 已有（可能是 npm 建的），不覆盖
  } catch (_) { /* 不存在，往下建 */ }

  fs.mkdirSync(BIN_DIR, { recursive: true });
  try {
    fs.symlinkSync(target, linkJs);
  } catch (_) {
    // 某些文件系统不支持符号链接，退化成一层转发脚本
    fs.writeFileSync(linkJs, `#!/bin/sh\nexec node "$(dirname "$0")/../electron/cli.js" "$@"\n`, { mode: 0o755 });
  }
  try { fs.chmodSync(linkJs, 0o755); } catch (_) {}
  log('· 已补上 node_modules/.bin/electron');
  return true;
}

function main() {
  if (!fs.existsSync(path.join(ELECTRON_PKG, 'package.json'))) {
    console.error('✗ 找不到 node_modules/electron，请先执行：npm install');
    process.exit(1);
  }

  if (!fs.existsSync(EXE)) {
    log('· 找不到 Electron 二进制，尝试从本机缓存恢复…');
    if (!extractFromCache()) {
      console.error(
        '✗ 无法准备 Electron 运行时。\n' +
        '  请执行：npm install\n' +
        '  若安装仍然失败，可以删除 node_modules/electron 后重试。'
      );
      process.exit(1);
    }
  }

  ensureBinLink();

  // 真跑一次，确认不是「文件在但执行不了」（架构不匹配、缺权限等）
  try {
    const out = execFileSync(EXE, ['--version'], { encoding: 'utf8', timeout: 20000 }).trim();
    log(`· Electron 运行时就绪（${out}）`);
  } catch (err) {
    console.error('✗ Electron 二进制无法执行：' + String(err.message || err).split('\n')[0]);
    console.error('  可以试试：rm -rf node_modules/electron && npm install');
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { main, extractFromCache, ensureBinLink };
