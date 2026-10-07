'use strict';
/**
 * boot.js —— 网页版的装配层
 *
 * 对应 Electron 端的 `main.js`：
 *   main.js ：建窗口 + store/timer/notifier/scheduler + 把 handlers 挂到 ipcMain + 接事件
 *   boot.js ：建 store/timer/notifier/scheduler + 把 handlers 挂到 window.api + 接事件
 *
 * 业务逻辑全在 `src/main/ipc.js` 里，两端共用。这里只做「接线」——
 * 所以网页版和桌面版的行为天然一致，不存在「改了桌面版忘了改网页版」。
 */

const { Store, seedDB } = require('../src/main/store');
const { StudyTimer } = require('../src/main/timer');
const { Notifier } = require('../src/main/notifier');
const { Scheduler } = require('../src/main/scheduler');
const { createHandlers } = require('../src/main/ipc');
const { buildApi } = require('../src/shared/api-surface');
const { createHost } = require('./host-browser');
const VFS = require('./shims/vfs');

globalThis.STUDYHUB_WEB = { version: '1.0.0-web' };

/** 虚拟数据目录：store.js 会在这里建 study-hub.json 与 backups/ */
const DATA_DIR = '/browser/Library/学习中心';

const store = new Store(DATA_DIR);
store.init();

/* 首次访问灌一份示例数据 —— 否则打开是一片空白，看不出这个应用是干什么的。
   用 meta.seeded 而不是「数据为空」判断，这样用户清空后不会又被灌一次。 */
if (!store.read().meta.seeded) {
  try {
    seedDB(store);
    store.update((db) => { db.meta.seeded = true; }, { immediate: true });
  } catch (err) {
    console.warn('[boot] 示例数据写入失败：', err);
  }
}

/* ---- 事件订阅（渲染层通过 window.api.on.* 注册） ---- */
const subs = { data: [], timer: [], toast: [], navigate: [], scheduler: [] };

/* api.on.* 用的是通道名，这里映射到内部事件名 */
const CHANNEL_TO_EVENT = {
  'app:data': 'data',
  'timer:state': 'timer',
  'notify:toast': 'toast',
  'app:navigate': 'navigate',
  'scheduler:fired': 'scheduler'
};
const emit = (kind, payload) => {
  for (const fn of subs[kind].slice()) {
    try { fn(payload); } catch (err) { console.error('[boot] 订阅回调出错', kind, err); }
  }
};

let host = null;
host = createHost({
  onSend(channel, payload) {
    if (channel === 'app:data') emit('data', payload);
    else if (channel === 'notify:toast') emit('toast', payload);
    else if (channel === 'timer:state') emit('timer', payload);
    else if (channel === 'scheduler:fired') emit('scheduler', payload);
  }
});

const notifier = new Notifier({
  store,
  onActivate(action, payload) {
    // 与桌面版一致：只有 'toast' 变成浮层（见 notifier.js 里那段注释的来龙去脉）
    if (action === 'toast') host.send('notify:toast', payload);
    else if (action === 'focus' && payload && payload.route) emit('navigate', payload.route);
  }
});

const timer = new StudyTimer(store);
const scheduler = new Scheduler({ store, notifier, timer, dataDir: DATA_DIR });

/* 网页版的「后台提醒守护」桩件。
   做成同形接口而不是 null，是为了 handler 里不必到处判空 —— 那些 handler
   在桌面版是有意义的，网页版只需要给出一句准确的话。 */
const autostart = {
  supported: false,
  detect: async () => ({
    supported: false, installed: false, platform: 'web', method: '',
    intervalSec: 0, file: '', execPath: '', daemonScript: '',
    message: '网页版没有后台提醒守护。关掉标签页后提醒就停了 —— 需要它的话请用桌面版（设置 → 后台提醒）。'
  }),
  install: async () => ({ ok: false, message: '网页版无法注册系统级后台任务。桌面版可以。' }),
  uninstall: async () => ({ ok: false, message: '网页版没有后台任务需要取消。' }),
  runOnce: async () => ({ ok: false, message: '网页版无法试跑后台巡检。' }),
  daemonLog: () => []
};

const ctx = {
  store, timer, notifier, scheduler, autostart,
  dataDir: DATA_DIR,
  vaultDir: DATA_DIR + '/vault'
};

const handlers = createHandlers(ctx, host);

/* ---- window.api ----
   🔴 这里**不再手写** API 结构，而是用 src/shared/api-surface.js —— 
   桌面版 preload.js 用的也是它。那里面有 94 个方法、其中 19 个带参数整形，
   手抄一份必然会出现「调用了但数据没变」这种最难查的 bug。
   网页版只是换成「直接调用 handler」而已。 */
const api = buildApi({
  invoke: (channel, ...args) => {
    const fn = handlers[channel];
    if (!fn) return Promise.reject(new Error('网页版没有实现通道：' + channel));
    return Promise.resolve(fn(...args));
  },
  on: (channel, handler) => {
    const kind = CHANNEL_TO_EVENT[channel];
    if (!kind) return () => {};
    subs[kind].push(handler);
    return () => {
      const i = subs[kind].indexOf(handler);
      if (i >= 0) subs[kind].splice(i, 1);
    };
  },
  // 浏览器拿不到拖拽文件的真实路径（这是浏览器的安全限制，不是缺陷）
  getPathForFile: () => ''
});

window.api = api;

/* 计时事件 → 渲染层（对应 main.js 里那段接线） */
timer.on('change', () => emit('timer', timer.getState()));
timer.on('phase-complete', () => emit('data', handlers['app:snapshot']()));
timer.restore();
scheduler.start();

/* 网页版专属信息，给设置页显示能力差异与存储占用 */
window.__WEB__ = {
  capabilities: host.capabilities,
  storageUsage: () => host.storageUsage(),
  resetStorage: () => VFS.reset(),
  notify: (o) => host.notify(o),
  dataDir: DATA_DIR,
  /** 完全重载数据（导入之后用） */
  reload: () => emit('data', handlers['app:snapshot']())
};

console.info('%c学习中心 · 网页版', 'font-weight:bold',
  '\n数据存在浏览器的 localStorage 里（不上传任何服务器）。' +
  '\n导入本地文件、PDF 预览、后台提醒这些依赖操作系统的能力在网页版不可用 ——' +
  '\n需要它们请用桌面版。');
