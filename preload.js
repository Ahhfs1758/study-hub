'use strict';
/**
 * preload.js —— Electron 端的 API 装配（薄适配器）
 *
 * 安全基线：contextIsolation 开启、nodeIntegration 关闭、sandbox 关闭（主进程要用 fs）。
 * 渲染层只能看到 api-surface.js 里显式列出的方法，拿不到 require，
 * 也拿不到任意文件系统能力。文件选择、打开外链这类能力全部收敛在主进程里做参数校验。
 *
 * 真正的「有哪些能力」在 src/shared/api-surface.js —— 网页版注入自己的 invoke，
 * 跑的是同一份结构。这里只负责把它接到 ipcRenderer 上。
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { buildApi } = require('./src/shared/api-surface');

/** 订阅主进程事件，返回取消订阅函数 */
function on(channel, handler) {
  const wrapped = (_e, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api = buildApi({
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on,
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch (_) { return ''; }
  }
});

contextBridge.exposeInMainWorld('api', api);
