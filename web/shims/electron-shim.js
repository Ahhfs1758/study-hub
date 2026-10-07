'use strict';
/**
 * electron-shim.js —— 浏览器版的 `require('electron')`
 *
 * 有些主进程模块在**顶层**就 `require('electron')` 并解构（如 preview.js 取 `shell`、
 * notifier.js 取 `Notification`）。打包网页版时不能没有这个模块，否则一加载就炸 ——
 * 哪怕那些代码路径在网页版里永远不会被走到。
 *
 * 所以这里的策略是：
 *   · 提供同名的对象，让顶层解构能成功（不炸）
 *   · 真正被调用时给出**能读懂的提示**，而不是 undefined is not a function
 *   · 能用浏览器 API 替代的，就直接替代（Notification → 浏览器通知）
 */

/** 被调用时才抱怨的桩 */
function stub(name, hint) {
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return undefined;          // 别被当成 Promise
      if (typeof prop === 'symbol') return undefined;
      return () => { throw new Error(`${name}.${String(prop)} 在网页版不可用${hint ? '（' + hint + '）' : ''}`); };
    }
  });
}

/** 浏览器通知：尽力而为，用户没授权就不发（不抛错） */
class NotificationShim {
  constructor(opts) {
    this.opts = opts || {};
    this._handlers = {};
  }
  on(evt, fn) { this._handlers[evt] = fn; return this; }
  show() {
    try {
      if (typeof Notification === 'undefined') return;
      const fire = () => {
        const n = new Notification(this.opts.title || '', { body: this.opts.body || '', silent: !!this.opts.silent });
        n.onclick = () => { if (this._handlers.click) this._handlers.click(); };
      };
      if (Notification.permission === 'granted') fire();
      else if (Notification.permission !== 'denied') {
        // 不在这里主动要权限 —— 一进页面就弹权限框体验很差。
        // 交给设置页的「测试通知」按钮去请求。
      }
    } catch (_) { /* 通知失败不影响窗口内浮层 */ }
  }
}

const app = {
  getVersion: () => (globalThis.STUDYHUB_WEB && globalThis.STUDYHUB_WEB.version) || '1.0.0-web',
  getPath: () => '/browser',
  getAppPath: () => '/browser',
  isPackaged: false,
  name: '学习中心',
  /** 网页版没有开机自启 */
  setLoginItemSettings: () => {},
  getLoginItemSettings: () => ({ openAtLogin: false }),
  quit: () => {},
  whenReady: () => Promise.resolve(),
  on: () => app,
  requestSingleInstanceLock: () => true
};

const shell = {
  openExternal(url) {
    try {
      const u = String(url || '');
      if (!/^https?:\/\//i.test(u)) throw new Error('只允许打开 http/https 链接');
      window.open(u, '_blank', 'noopener,noreferrer');
      return Promise.resolve('');
    } catch (err) {
      return Promise.resolve(String(err && err.message || err));
    }
  },
  openPath() { return Promise.resolve('网页版不能用系统程序打开本机文件'); },
  showItemInFolder() { throw new Error('网页版没有「在文件夹中显示」'); }
};

const dialog = stub('dialog', '浏览器没有原生文件对话框，网页版用「上传/下载」代替选文件与导出');

const BrowserWindow = {
  getAllWindows: () => [],
  getFocusedWindow: () => null,
  fromWebContents: () => null
};

const clipboard = {
  writeText: (t) => navigator.clipboard.writeText(t),
  readText: () => navigator.clipboard.readText()
};

const ipcMain = stub('ipcMain', '网页版直接把处理函数挂到 window.api，不走 IPC');
const ipcRenderer = stub('ipcRenderer');

module.exports = {
  app, shell, dialog, BrowserWindow, Notification: NotificationShim,
  clipboard, ipcMain, ipcRenderer,
  nativeImage: { createFromPath: () => ({}) },
  globalShortcut: { register: () => false, unregisterAll: () => {} },
  powerMonitor: { on: () => {} },
  Tray: function () { throw new Error('网页版没有菜单栏托盘'); },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1280, height: 800 } }) }
};
