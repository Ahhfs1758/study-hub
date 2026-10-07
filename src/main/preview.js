'use strict';
/**
 * preview.js —— 应用内预览资料
 *
 * 三种资料走三条路：
 *   文本/代码/Markdown → 读进内存交给渲染层内联渲染（保留侧边栏，可以边看边计时）
 *   图片              → 转成 data URL 内联显示（有大小上限，避免几 MB 的图把内存顶爆）
 *   PDF 及其他        → 交给系统（PDF 用 Chromium 自带的阅读器开独立窗口）
 *
 * 「拒绝二进制」这点很重要：把 .zip 或视频文件按文本读进来会得到一堆乱码，
 * 然后界面上一片面目全非，用户只会认为是应用坏了。所以先探测再决定。
 */

const fs = require('fs');
const path = require('path');
const { shell } = require('electron');

const TEXT_MAX = 600 * 1024;          // 文本类上限 600KB
const IMAGE_MAX = 16 * 1024 * 1024;   // 图片上限 16MB

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'mdx', 'rst', 'org',
  'json', 'json5', 'yaml', 'yml', 'toml', 'ini', 'conf', 'env', 'properties',
  'csv', 'tsv', 'log', 'sql',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'swift', 'php', 'lua', 'pl', 'r', 'm',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'html', 'htm', 'xml', 'css', 'scss', 'less', 'sass', 'vue', 'svelte', 'tex'
]);

const IMAGE_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif', ico: 'image/x-icon'
};

/** Markdown 家族：渲染层会用自写的渲染器排版，而不是当纯文本展示 */
const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdx']);

function extOf(p) {
  const m = /\.([a-z0-9]+)$/i.exec(String(p || ''));
  return m ? m[1].toLowerCase() : '';
}

/** 粗判二进制：UTF-8 文本里出现 NUL 字节基本可以断定不是文本 */
function looksBinary(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function humanSize(bytes) {
  if (!bytes) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

function kindOf(file) {
  const ext = extOf(file);
  if (ext === 'pdf') return 'pdf';
  if (IMAGE_MIME[ext]) return 'image';
  if (MARKDOWN_EXT.has(ext)) return 'markdown';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'external';
}

/**
 * 能不能在应用内预览。
 * @returns {{kind:'text'|'markdown'|'image'|'pdf'|'external', ext:string, reason?:string}}
 */
function probe(file) {
  const kind = kindOf(file);
  if (kind === 'external') {
    return { kind, ext: extOf(file), reason: '这类文件应用内没有合适的阅读器，会用系统默认程序打开' };
  }
  if (!fs.existsSync(file)) {
    return { kind: 'missing', ext: extOf(file), reason: '文件已不在原位置' };
  }
  const st = fs.statSync(file);
  if (kind === 'image' && st.size > IMAGE_MAX) {
    return { kind: 'external', ext: extOf(file), reason: `图片有 ${humanSize(st.size)}，超过内联显示上限` };
  }
  return { kind, ext: extOf(file), size: st.size, sizeText: humanSize(st.size), mtime: st.mtime.toISOString() };
}

/** 读文本内容（带大小上限与二进制探测） */
function readText(file, maxBytes = TEXT_MAX) {
  if (!fs.existsSync(file)) return { ok: false, message: '文件已不在原位置：' + file };
  const st = fs.statSync(file);
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    if (looksBinary(buf)) {
      return { ok: false, message: '这个文件看起来是二进制的，不适合当文本显示' };
    }
    let text = buf.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);      // 去掉 BOM
    return {
      ok: true,
      text,
      truncated: st.size > len,
      size: st.size,
      sizeText: humanSize(st.size),
      mtime: st.mtime.toISOString(),
      ext: extOf(file)
    };
  } finally {
    fs.closeSync(fd);
  }
}

/** 读图片为 data URL */
function readImage(file) {
  if (!fs.existsSync(file)) return { ok: false, message: '文件已不在原位置：' + file };
  const st = fs.statSync(file);
  if (st.size > IMAGE_MAX) return { ok: false, message: `图片太大（${humanSize(st.size)}），超过 16MB` };
  const ext = extOf(file);
  const mime = IMAGE_MIME[ext] || 'application/octet-stream';
  const buf = fs.readFileSync(file);
  return {
    ok: true,
    dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
    mime,
    size: st.size,
    sizeText: humanSize(st.size),
    ext
  };
}

/**
 * 打开 PDF：用独立窗口交给 Chromium 自带的阅读器（缩放、翻页、打印都是现成的）。
 * 不内联到主窗口里，是因为主窗口的 CSP 刻意收得很紧（default-src 'none'），
 * 而 Chromium 的 PDF 阅读器需要自己的扩展资源；独立窗口各有各的 CSP，互不干扰。
 */
let pdfWindow = null;
function openPdfWindow(file, title) {
  const { BrowserWindow } = require('electron');
  if (!fs.existsSync(file)) return { ok: false, message: '文件已不在原位置：' + file };
  if (pdfWindow && !pdfWindow.isDestroyed()) {
    pdfWindow.close();
    pdfWindow = null;
  }
  pdfWindow = new BrowserWindow({
    width: 1040,
    height: 860,
    title: title || path.basename(file),
    backgroundColor: '#3a3a3a',
    autoHideMenuBar: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  pdfWindow.loadURL(require('url').pathToFileURL(file).href);
  pdfWindow.on('closed', () => { pdfWindow = null; });
  return { ok: true };
}

/** 用系统默认程序打开 */
async function openExternal(file) {
  if (!fs.existsSync(file)) return { ok: false, message: '文件已不在原位置：' + file };
  const err = await shell.openPath(file);
  return err ? { ok: false, message: err } : { ok: true };
}

module.exports = { probe, readText, readImage, openPdfWindow, openExternal, kindOf, extOf, humanSize, MARKDOWN_EXT, TEXT_EXT, IMAGE_MIME };
