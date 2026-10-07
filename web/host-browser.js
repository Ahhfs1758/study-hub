'use strict';
/**
 * host-browser.js —— 浏览器的平台适配器
 *
 * 与 `src/main/host-electron.js` **接口完全一致**，所以 `src/main/ipc.js` 里
 * 那 90 个 handler 一行都不用改，两端跑的是同一份业务逻辑。
 *
 * 这里唯一要动脑子的是「把平台概念翻译成浏览器能做到的事」：
 *   保存文件   → 生成 Blob 触发下载（而不是弹原生保存框）
 *   选择文件   → <input type="file">（而不是原生对话框）
 *   系统通知   → Notification API（而不是 Electron Notification）
 *   窗口控制   → 空实现（网页里没有「最小化到托盘」这回事）
 *
 * 做不到的能力如实写在 capabilities 里，前端据此隐藏入口 ——
 * 这比让按钮点下去报错要好得多。
 */

const VFS = require('./shims/vfs');

/** 浏览器通知授权：只在用户主动点「测试通知」时才请求，不在启动时弹框 */
function ensureNotifyPermission() {
  return new Promise((resolve) => {
    try {
      if (typeof Notification === 'undefined') return resolve('unsupported');
      if (Notification.permission === 'granted') return resolve('granted');
      if (Notification.permission === 'denied') return resolve('denied');
      Notification.requestPermission().then(resolve).catch(() => resolve('denied'));
    } catch (_) { resolve('unsupported'); }
  });
}

function createHost(opts) {
  const o = opts || {};

  return {
    platform: 'web',
    arch: 'wasm',
    version: '1.0.0-web',
    build: { electron: null, node: null, chrome: navigator.userAgent.match(/Chrome\/([\d.]+)/) ? RegExp.$1 : null },
    runtimeName: 'browser',

    paths: {
      userData: '/browser/学习中心',
      home: '/browser',
      documents: '/browser/文档',
      desktop: '/browser/桌面'
    },

    /* 网页版能做到的与做不到的，如实声明。
       前端拿它来决定按钮是「显示」「禁用并说明」还是「隐藏」——
       让用户点下去才发现不行是最差的设计。 */
    capabilities: {
      nativeFilePicker: false,     // 浏览器拿不到文件路径
      openLocalPath: false,        // 打不开本机程序
      revealInFolder: false,
      systemNotify: typeof Notification !== 'undefined',
      backgroundDaemon: false,     // 关掉标签页就没了
      globalShortcut: false,
      tray: false,
      windowControls: false,
      localFilePreview: false,     // 没有本地文件可预览
      webOnly: true,
      storage: 'localStorage'
    },

    /** 广播：网页版直接回调（渲染层不需要 IPC 中转） */
    send(channel, payload) {
      if (typeof o.onSend === 'function') o.onSend(channel, payload);
    },

    /* 网页版没有原生对话框。用 <input type=file> 代替，
       accept 由调用方给的 extensions 决定。 */
    async showOpenDialog(dialogOpts) {
      const files = await pickFiles(dialogOpts);
      return { canceled: !files.length, filePaths: files.map((f) => f.name), files };
    },

    async showSaveDialog() {
      throw new Error('网页版没有保存对话框，导出走的是浏览器下载');
    },

    /** 触发浏览器下载 —— 语义上等价于桌面版的「保存到文件」 */
    async saveText({ fileName, text }) {
      try {
        const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        return { ok: true, path: fileName, via: 'download' };
      } catch (err) {
        return { ok: false, message: String(err && err.message || err) };
      }
    },

    /** 用 <input type=file> 读一个文本文件 —— 语义上等价于桌面版的「选文件并读入」 */
    async pickTextFile({ extensions }) {
      const files = await pickFiles({ extensions, multiple: false });
      if (!files.length) return { canceled: true };
      const text = await files[0].text();
      return { canceled: false, path: files[0].name, text };
    },

    openExternal(url) {
      const u = String(url || '');
      if (!/^https?:\/\//i.test(u)) return { ok: false, message: '只允许打开 http/https 链接' };
      window.open(u, '_blank', 'noopener,noreferrer');
      return { ok: true };
    },

    async openPath() {
      return { ok: false, message: '网页版不能用系统程序打开本机路径。' };
    },

    showItemInFolder() {
      return { ok: false, message: '网页版没有「在文件夹中显示」。' };
    },

    /** 系统通知（浏览器通知）。返回是否真的发出去了 */
    async notify({ title, body, silent }) {
      const perm = await ensureNotifyPermission();
      if (perm !== 'granted') return { ok: false, message: perm === 'denied' ? '通知权限被拒绝' : '浏览器不支持通知' };
      try {
        new Notification(title || '', { body: body || '', silent: !!silent });
        return { ok: true };
      } catch (err) {
        return { ok: false, message: String(err && err.message || err) };
      }
    },

    /** 网页版没有「页面里的第二个窗口」可 eval —— 自检是 Electron 专属能力 */
    evalInPage: null,

    window: {
      hide() { return false; },
      minimize() { return false; },
      maximizeToggle() { return false; },
      close() { return false; }
    },

    /** 给设置页显示存储占用 */
    storageUsage: () => VFS.usage(),
    resetStorage: () => VFS.reset()
  };
}

/** 弹一个隐藏的 <input type=file>，等用户选完 */
function pickFiles({ extensions, multiple } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (multiple) input.multiple = true;
    if (extensions && extensions.length) {
      input.accept = extensions.map((e) => '.' + String(e).replace(/^\./, '')).join(',');
    }
    input.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(input);

    let settled = false;
    const done = (files) => {
      if (settled) return;
      settled = true;
      input.remove();
      window.removeEventListener('focus', onFocus);
      resolve(files || []);
    };
    input.addEventListener('change', () => done([...input.files]));
    // 用户直接关掉选择框时不会触发 change —— 用 window 重新获得焦点做兜底，
    // 否则这个 Promise 会永远挂着，调用方的 await 之后一行都不执行
    const onFocus = () => setTimeout(() => done([]), 500);
    window.addEventListener('focus', onFocus, { once: true });

    input.click();
  });
}

module.exports = { createHost };
