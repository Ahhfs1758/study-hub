'use strict';
/**
 * host-electron.js —— Electron 端的平台适配器
 *
 * `src/main/ipc.js` 里所有 handler 的业务逻辑都是共享的，只有「跟操作系统打交道」
 * 的那几件事通过这个对象注入。网页版有另一份实现（web/host-browser.js），
 * 两边接口一致，所以 handler 代码一行都不用改。
 *
 * 接口清单（网页版必须实现同样这些方法）：
 *   platform / arch / version / build / runtimeName / paths
 *   capabilities  能力开关，前端据此隐藏或禁用桌面专属入口
 *   send(channel, payload)          单向推事件给界面
 *   showOpenDialog(opts)            原生打开对话框
 *   showSaveDialog(opts)            原生保存对话框
 *   saveText({title,fileName,text}) 保存文本（语义化，两端各自实现）
 *   pickTextFile({title,extensions}) 读一个文本文件（语义化）
 *   openExternal(url)               用系统浏览器打开
 *   openPath(p)                     用系统默认程序打开
 *   evalInPage(js)                  在页面里执行 JS（仅自检用）
 *   window.{hide,minimize,maximizeToggle,close}
 */

const { app, dialog, shell, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

function createHost() {
  const anyWin = () => BrowserWindow.getAllWindows()[0] || null;

  return {
    platform: process.platform,
    arch: process.arch,
    version: app.getVersion(),
    build: {
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome
    },
    runtimeName: 'electron',
    paths: {
      userData: app.getPath('userData'),
      home: app.getPath('home'),
      documents: (() => { try { return app.getPath('documents'); } catch (_) { return ''; } })(),
      desktop: (() => { try { return app.getPath('desktop'); } catch (_) { return ''; } })()
    },

    /** 桌面版全都支持 */
    capabilities: {
      nativeFilePicker: true,
      openLocalPath: true,
      revealInFolder: true,
      systemNotify: true,
      backgroundDaemon: true,
      globalShortcut: true,
      tray: true,
      windowControls: true,
      localFilePreview: true
    },

    send(channel, payload) {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send(channel, payload);
      }
    },

    async showOpenDialog(opts) {
      const win = BrowserWindow.getFocusedWindow() || anyWin();
      return dialog.showOpenDialog(win, opts);
    },

    async showSaveDialog(opts) {
      const win = BrowserWindow.getFocusedWindow() || anyWin();
      return dialog.showSaveDialog(win, opts);
    },

    /** 弹保存框写文件。网页版的同名实现是「触发浏览器下载」 */
    async saveText({ title, fileName, text }) {
      const win = BrowserWindow.getFocusedWindow() || anyWin();
      const res = await dialog.showSaveDialog(win, {
        title,
        defaultPath: fileName,
        filters: [{ name: 'JSON', extensions: ['json'] }]
      });
      if (res.canceled || !res.filePath) return { ok: false };
      fs.writeFileSync(res.filePath, text, 'utf8');
      return { ok: true, path: res.filePath };
    },

    /** 选一个文本文件并读回来。网页版的同名实现是 <input type=file> */
    async pickTextFile({ title, extensions }) {
      const win = BrowserWindow.getFocusedWindow() || anyWin();
      const res = await dialog.showOpenDialog(win, {
        title,
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: extensions || ['json'] }]
      });
      if (res.canceled || !res.filePaths.length) return { canceled: true };
      return { canceled: false, path: res.filePaths[0], text: fs.readFileSync(res.filePaths[0], 'utf8') };
    },

    openExternal(url) {
      shell.openExternal(url);
      return { ok: true };
    },

    async openPath(p) {
      const err = await shell.openPath(p);
      return err ? { ok: false, message: err } : { ok: true };
    },

    showItemInFolder(p) {
      try {
        shell.showItemInFolder(p);
        return { ok: true };
      } catch (err) {
        return { ok: false, message: String(err && err.message || err) };
      }
    },

    evalInPage(js) {
      const w = anyWin();
      if (!w) return Promise.reject(new Error('没有窗口'));
      return w.webContents.executeJavaScript(js);
    },

    window: {
      hide() { const w = anyWin(); if (w) w.hide(); return true; },
      minimize() { const w = anyWin(); if (w) w.minimize(); return true; },
      maximizeToggle() {
        const w = anyWin();
        if (!w) return false;
        if (w.isMaximized()) w.unmaximize(); else w.maximize();
        return w.isMaximized();
      },
      close() { const w = anyWin(); if (w) w.close(); return true; }
    }
  };
}

module.exports = { createHost };
