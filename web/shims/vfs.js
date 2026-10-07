'use strict';
/**
 * vfs.js —— 浏览器里的迷你文件系统
 *
 * 为什么需要它：`src/main/store.js` 用的是**同步** fs API（原子写：先写 .tmp 再 rename、
 * 滚动备份、按天留档）。与其给网页版另写一份数据层，不如提供这些同步 API 的浏览器实现，
 * 让 **store.js 本身原封不动地跑起来**。
 *
 * 这样数据逻辑（结构迁移、备份轮转、原子写、写入去抖）在两端**完全一致**，
 * 不存在「网页版存的数据和桌面版行为不一样」这种极难发现的问题。
 *
 * 后端是 localStorage：
 *   · 同步 —— 正好匹配 store.js 的同步调用方式，不需要把整个数据层改成 async
 *   · 容量约 5MB —— 一份学习数据约 40KB，加 14 份备份也就 600KB 上下
 *   · 超限时**明确抛错**，绝不静默丢数据（静默丢数据比崩溃糟得多）
 */

const NS = 'studyhub.vfs.';
const DIRS_KEY = NS + '__dirs__';

/** 规范化路径：统一成正斜杠、折叠 . 与多余分隔符、去掉末尾斜杠 */
function normalize(p) {
  let s = String(p == null ? '' : p).replace(/\\/g, '/');
  const abs = s.startsWith('/');
  const parts = [];
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return (abs ? '/' : '') + parts.join('/') || '/';
}

function readDirs() {
  try {
    const raw = localStorage.getItem(DIRS_KEY);
    const arr = raw ? JSON.parse(raw) : null;
    return Array.isArray(arr) && arr.length ? arr : ['/'];
  } catch (_) { return ['/']; }
}

function writeDirs(list) {
  try { localStorage.setItem(DIRS_KEY, JSON.stringify([...new Set(list)])); } catch (_) { /* 目录表丢了不影响文件读取 */ }
}

function isDir(p) {
  const n = normalize(p);
  if (n === '/') return true;
  return readDirs().includes(n);
}

function fsExists(p) {
  const n = normalize(p);
  if (isDir(n)) return true;
  return localStorage.getItem(NS + n) !== null;
}

function fsMkdir(p, opts) {
  const n = normalize(p);
  const list = readDirs();
  if (opts && opts.recursive) {
    const parts = n.split('/').filter(Boolean);
    let cur = '';
    for (const seg of parts) {
      cur += '/' + seg;
      if (!list.includes(cur)) list.push(cur);
    }
  } else if (!list.includes(n)) {
    list.push(n);
  }
  writeDirs(list);
  return undefined;
}

function fsReadFile(p, enc) {
  const n = normalize(p);
  const v = localStorage.getItem(NS + n);
  if (v === null) {
    const err = new Error(`ENOENT: no such file or directory, open '${n}'`);
    err.code = 'ENOENT';
    throw err;
  }
  if (enc === 'utf8' || enc === 'utf-8' || enc == null) return v;
  return v;   // 本项目只用 utf8 文本，不做二进制
}

function fsWriteFile(p, data) {
  const n = normalize(p);
  // 保证父目录存在（store.js 会 mkdir，但容错一下更稳）
  const parent = n.split('/').slice(0, -1).join('/') || '/';
  const list = readDirs();
  if (!list.includes(parent)) fsMkdir(parent, { recursive: true });
  try {
    localStorage.setItem(NS + n, String(data));
  } catch (err) {
    const e = new Error('浏览器存储空间不足（localStorage 上限约 5MB），这次写入没有生效。可以在「设置」里清空示例数据或减少备份份数。');
    e.code = 'ENOSPC';
    e.cause = err;
    throw e;
  }
}

function fsReaddir(p) {
  const n = normalize(p);
  const prefix = n === '/' ? '/' : n + '/';
  const names = new Set();
  for (const d of readDirs()) {
    if (d !== n && d.startsWith(prefix)) names.add(d.slice(prefix.length).split('/')[0]);
  }
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(NS) || k === DIRS_KEY) continue;
    const f = k.slice(NS.length);
    if (f.startsWith(prefix)) names.add(f.slice(prefix.length).split('/')[0]);
  }
  return [...names].filter(Boolean);
}

function fsStat(p) {
  const n = normalize(p);
  if (isDir(n)) return { size: 0, mtime: new Date(), mtimeMs: Date.now(), isDirectory: () => true, isFile: () => false };
  const v = localStorage.getItem(NS + n);
  if (v === null) {
    const err = new Error(`ENOENT: no such file or directory, stat '${n}'`);
    err.code = 'ENOENT';
    throw err;
  }
  // localStorage 不存 mtime，用「写入顺序号」近似：记录每次写入时间
  let t = Number(localStorage.getItem(NS + n + '__mtime') || 0) || Date.now();
  return { size: v.length, mtime: new Date(t), mtimeMs: t, isDirectory: () => false, isFile: () => true };
}

function fsUnlink(p) {
  const n = normalize(p);
  localStorage.removeItem(NS + n);
  localStorage.removeItem(NS + n + '__mtime');
}

function fsRename(from, to) {
  const a = normalize(from), b = normalize(to);
  if (isDir(a)) {
    // 目录改名：把前缀整体换掉（本项目用不到，但保持语义完整）
    writeDirs(readDirs().map((d) => (d === a ? b : d.startsWith(a + '/') ? b + d.slice(a.length) : d)));
    const moves = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(NS + a + '/')) moves.push([k, NS + b + k.slice(NS.length + a.length)]);
    }
    for (const [k, v] of moves) { const val = localStorage.getItem(k); localStorage.setItem(v, val); localStorage.removeItem(k); }
    return;
  }
  const v = localStorage.getItem(NS + a);
  if (v === null) {
    const err = new Error(`ENOENT: no such file or directory, rename '${a}'`);
    err.code = 'ENOENT';
    throw err;
  }
  const mt = localStorage.getItem(NS + a + '__mtime');
  fsWriteFile(b, v);
  if (mt) localStorage.setItem(NS + b + '__mtime', mt);
  fsUnlink(a);
}

function fsCopyFile(from, to) {
  const v = fsReadFile(from, 'utf8');
  fsWriteFile(to, v);
}

function fsRm(p, opts) {
  const n = normalize(p);
  if (!fsExists(n)) {
    if (opts && opts.force) return;
    const err = new Error(`ENOENT: ${n}`);
    err.code = 'ENOENT';
    throw err;
  }
  if (isDir(n)) {
    for (const f of fsReaddir(n)) fsRm(n + '/' + f, { force: true });
    writeDirs(readDirs().filter((d) => d !== n));
  } else {
    fsUnlink(n);
  }
}

/** 清空整个虚拟文件系统（设置页「恢复出厂」用） */
function fsReset() {
  const doomed = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(NS)) doomed.push(k);
  }
  for (const k of doomed) localStorage.removeItem(k);
}

/** 占用统计，给设置页显示 */
function fsUsage() {
  let bytes = 0, files = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(NS)) continue;
    bytes += k.length + String(localStorage.getItem(k) || '').length;
    if (!k.endsWith('__mtime') && k !== DIRS_KEY) files++;
  }
  return { bytes, files, quotaHint: 5 * 1024 * 1024 };
}

module.exports = {
  fs: {
    existsSync: fsExists,
    mkdirSync: fsMkdir,
    readFileSync: fsReadFile,
    writeFileSync: fsWriteFile,
    readdirSync: fsReaddir,
    statSync: fsStat,
    unlinkSync: fsUnlink,
    renameSync: fsRename,
    copyFileSync: fsCopyFile,
    rmSync: fsRm,
    /** 少数地方用得到；这里的实现是「批量写」 */
    writeFile: (p, d, cb) => { try { fsWriteFile(p, d); cb && cb(null); } catch (e) { cb && cb(e); } }
  },
  reset: fsReset,
  usage: fsUsage,
  normalize
};
