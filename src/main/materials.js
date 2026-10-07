'use strict';
/**
 * materials.js —— 学习资料的实体操作（选文件、扫目录、打开、入仓）
 *
 * 两种持有方式：
 *   link —— 只记路径，文件留在原地。适合自己的下载目录/桌面上的大文件，不占额外空间。
 *   copy —— 复制进应用数据目录的 vault/，适合散落各处、容易误删的资料。搬运后原地留着也不影响。
 * 路径一律用绝对路径，并在每次打开前做存在性校验 —— 用户移动了文件要能立刻发现并提示「路径已失效」。
 */

const fs = require('fs');
const path = require('path');
const { shell } = require('electron');

const DOC_EXT = {
  pdf: 'doc', doc: 'doc', docx: 'doc', wps: 'doc', odt: 'doc', rtf: 'doc',
  ppt: 'slide', pptx: 'slide', key: 'slide',
  xls: 'sheet', xlsx: 'sheet', csv: 'sheet', numbers: 'sheet',
  txt: 'note', md: 'note', markdown: 'note',
  epub: 'book', mobi: 'book', azw3: 'book', djvu: 'book', caj: 'book',
  mp4: 'video', mkv: 'video', avi: 'video', mov: 'video', flv: 'video', wmv: 'video', webm: 'video',
  mp3: 'audio', m4a: 'audio', wav: 'audio', flac: 'audio', aac: 'audio',
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', bmp: 'image', svg: 'image',
  zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive',
  py: 'code', js: 'code', ts: 'code', java: 'code', c: 'code', cpp: 'code', h: 'code',
  go: 'code', rs: 'code', rb: 'code', php: 'code', sql: 'code', ipynb: 'code',
  html: 'code', htm: 'code', json: 'code', xml: 'code', yml: 'code', yaml: 'code'
};

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.idea', '.vscode',
  'Library', 'AppData', '.Trash', '$RECYCLE.BIN', 'System Volume Information'
]);

function extOf(p) {
  const m = /\.([a-z0-9]+)$/i.exec(String(p || ''));
  return m ? m[1].toLowerCase() : '';
}

function typeOfExt(ext) {
  return DOC_EXT[ext] || 'other';
}

function humanSize(bytes) {
  if (!bytes) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

/** 递归扫描目录，返回候选资料条目（默认最深 4 层，避免把整个硬盘扫穿） */
function scanFolder(dir, { maxDepth = 4, limit = 800 } = {}) {
  const out = [];
  const walk = (cur, depth) => {
    if (depth > maxDepth || out.length >= limit) return;
    let entries = [];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.name.startsWith('.')) continue;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(full, depth + 1);
      } else if (e.isFile()) {
        const ext = extOf(e.name);
        if (!DOC_EXT[ext]) continue;          // 只收学习资料类，不收 .exe/.dll 之类
        let st = null;
        try { st = fs.statSync(full); } catch (_) {}
        out.push({
          title: path.basename(e.name, '.' + ext),
          file: full,
          ext,
          type: typeOfExt(ext),
          size: st ? st.size : 0,
          sizeText: st ? humanSize(st.size) : '',
          mtime: st ? st.mtime.toISOString() : null
        });
      }
    }
  };
  walk(dir, 0);
  return out;
}

/** 复制进 vault，重名自动加序号 */
function copyToVault(file, vaultDir) {
  fs.mkdirSync(vaultDir, { recursive: true });
  const base = path.basename(file);
  let target = path.join(vaultDir, base);
  if (fs.existsSync(target)) {
    const ext = path.extname(base);
    const stem = path.basename(base, ext);
    let i = 1;
    while (fs.existsSync(target)) {
      target = path.join(vaultDir, `${stem} (${i})${ext}`);
      i++;
    }
  }
  fs.copyFileSync(file, target);
  return target;
}

/** 打开资料：本地文件优先，其次链接。返回 {ok, message} */
async function openMaterial(m) {
  if (m.path) {
    if (!fs.existsSync(m.path)) {
      return { ok: false, message: `文件已不在原位置：${m.path}` };
    }
    const err = await shell.openPath(m.path);
    return err ? { ok: false, message: err } : { ok: true };
  }
  if (m.url) {
    const u = String(m.url).trim();
    if (!/^https?:\/\//i.test(u)) return { ok: false, message: '链接必须是 http/https 开头' };
    await shell.openExternal(u);
    return { ok: true };
  }
  return { ok: false, message: '这份资料既没有文件路径也没有链接' };
}

function revealInFolder(p) {
  if (!p) return { ok: false, message: '没有文件路径' };
  if (!fs.existsSync(p)) return { ok: false, message: '文件已不在原位置' };
  shell.showItemInFolder(p);
  return { ok: true };
}

module.exports = { scanFolder, copyToVault, openMaterial, revealInFolder, extOf, typeOfExt, humanSize, DOC_EXT };
