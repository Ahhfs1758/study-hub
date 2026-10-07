'use strict';
/**
 * node-shims.js —— 浏览器版的 Node 核心模块
 *
 * 只实现本项目真正用到的那几个函数，不追求完整兼容。
 * 每个「网页版做不到」的调用都抛**带解释的错误**，而不是静默返回 undefined ——
 * 静默失败会让人以为是应用坏了，明确报错才能引导用户换条路走。
 */

const VFS = require('./vfs');

/* ------------------------------------------------------------------ *
 * path —— 只用到 join / dirname / basename / extname / resolve
 * ------------------------------------------------------------------ */
const path = {
  sep: '/',
  join(...parts) {
    return VFS.normalize(parts.filter((p) => p != null && p !== '').join('/')) || '.';
  },
  dirname(p) {
    const n = VFS.normalize(p);
    const i = n.lastIndexOf('/');
    if (i < 0) return '.';
    return i === 0 ? '/' : n.slice(0, i);
  },
  basename(p, ext) {
    const n = VFS.normalize(p);
    let b = n.slice(n.lastIndexOf('/') + 1) || n;
    if (ext && b.endsWith(ext)) b = b.slice(0, -ext.length);
    return b;
  },
  extname(p) {
    const b = path.basename(p);
    const i = b.lastIndexOf('.');
    return i <= 0 ? '' : b.slice(i);
  },
  resolve(...parts) {
    let out = '';
    for (const p of parts) {
      if (!p) continue;
      out = String(p).startsWith('/') ? String(p) : (out ? out + '/' + p : String(p));
    }
    return VFS.normalize(out) || '/';
  },
  isAbsolute(p) { return String(p).startsWith('/'); }
};

/* ------------------------------------------------------------------ *
 * crypto —— 只用到 randomBytes(n).toString('hex')
 * ------------------------------------------------------------------ */
const crypto = {
  randomBytes(n) {
    const buf = new Uint8Array(n);
    (globalThis.crypto || { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256); return a; } })
      .getRandomValues(buf);
    return {
      toString(enc) {
        if (enc !== 'hex') throw new Error('浏览器版 crypto 只支持 hex 输出');
        return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
      },
      length: n
    };
  },
  randomUUID() {
    if (globalThis.crypto && globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
    return crypto.randomBytes(16).toString('hex');
  }
};

/* ------------------------------------------------------------------ *
 * os —— 只用于显示环境信息
 * ------------------------------------------------------------------ */
const os = {
  platform: () => 'browser',
  type: () => 'Browser',
  arch: () => 'wasm',
  homedir: () => '/home/browser',
  tmpdir: () => '/tmp',
  hostname: () => (typeof location !== 'undefined' ? location.hostname : 'localhost'),
  release: () => (typeof navigator !== 'undefined' ? navigator.userAgent : ''),
  cpus: () => [{ model: 'browser', speed: 0 }]
};

/* ------------------------------------------------------------------ *
 * events —— 只用到 EventEmitter 的 on / off / emit / once / removeAllListeners
 * ------------------------------------------------------------------ */
class EventEmitter {
  constructor() { this._ev = new Map(); }
  on(type, fn) {
    if (!this._ev.has(type)) this._ev.set(type, []);
    this._ev.get(type).push(fn);
    return this;
  }
  addListener(type, fn) { return this.on(type, fn); }
  once(type, fn) {
    const wrap = (...a) => { this.off(type, wrap); fn(...a); };
    return this.on(type, wrap);
  }
  off(type, fn) {
    const list = this._ev.get(type);
    if (!list) return this;
    if (!fn) { this._ev.delete(type); return this; }
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
    return this;
  }
  removeListener(type, fn) { return this.off(type, fn); }
  removeAllListeners(type) {
    if (type === undefined) this._ev.clear();
    else this._ev.delete(type);
    return this;
  }
  listeners(type) { return (this._ev.get(type) || []).slice(); }
  listenerCount(type) { return (this._ev.get(type) || []).length; }
  emit(type, ...args) {
    // 复制一份再遍历：回调里可能会 off 掉自己
    for (const fn of (this._ev.get(type) || []).slice()) {
      try { fn(...args); } catch (err) { console.error('[events] 监听器抛错', type, err); }
    }
    return (this._ev.get(type) || []).length > 0;
  }
}

/* ------------------------------------------------------------------ *
 * child_process / url
 * ------------------------------------------------------------------ */
const child_process = {
  execFile() {
    throw new Error('浏览器不能启动本机进程（这是「后台提醒守护」用的能力，网页版没有）。');
  },
  exec() {
    throw new Error('浏览器不能启动本机进程。');
  },
  spawn() {
    throw new Error('浏览器不能启动本机进程。');
  }
};

const url = {
  pathToFileURL(p) { return { href: String(p), toString: () => String(p) }; },
  fileURLToPath(u) { return String(u).replace(/^file:\/\//, ''); }
};

module.exports = { path, crypto, os, child_process, url, events: { EventEmitter }, fs: VFS.fs, __vfs: VFS };
