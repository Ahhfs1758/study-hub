'use strict';
/**
 * preload.js —— 渲染进程与主进程之间的唯一通道
 *
 * 安全基线：contextIsolation 开启、nodeIntegration 关闭、sandbox 关闭（主进程要用 fs）。
 * 渲染层只能看到这里显式列出的方法，拿不到 require，也拿不到任意文件系统能力。
 * 文件选择、打开外链这类能力全部收敛在主进程里做参数校验。
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args);
}

/** 订阅主进程事件，返回取消订阅函数 */
function on(channel, handler) {
  const wrapped = (_e, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('api', {
  /* ---------------- 读 ---------------- */
  snapshot: () => invoke('app:snapshot'),

  subjects: {
    list: () => invoke('subjects:list'),
    add: (data) => invoke('subjects:add', data),
    update: (id, patch) => invoke('subjects:update', { id, patch }),
    remove: (id) => invoke('subjects:remove', id)
  },

  materials: {
    list: () => invoke('materials:list'),
    add: (data) => invoke('materials:add', data),
    update: (id, patch) => invoke('materials:update', { id, patch }),
    remove: (id) => invoke('materials:remove', id),
    open: (id) => invoke('materials:open', id),
    logOpen: (id) => invoke('materials:log-open', id),
    pickFiles: () => invoke('materials:pick-files'),
    pickFolder: () => invoke('materials:pick-folder'),
    scanFolder: (dir, subjectId) => invoke('materials:scan-folder', { dir, subjectId }),
    revealInFolder: (id) => invoke('materials:reveal', id),
    pathForDropped: (file) => {
      try { return webUtils.getPathForFile(file); } catch (_) { return ''; }
    }
  },

  plans: {
    list: () => invoke('plans:list'),
    add: (data) => invoke('plans:add', data),
    update: (id, patch) => invoke('plans:update', { id, patch }),
    remove: (id) => invoke('plans:remove', id),
    addTask: (planId, data) => invoke('plans:add-task', { planId, data }),
    updateTask: (planId, taskId, patch) => invoke('plans:update-task', { planId, taskId, patch }),
    removeTask: (planId, taskId) => invoke('plans:remove-task', { planId, taskId }),
    toggleTask: (planId, taskId, dateKey) => invoke('plans:toggle-task', { planId, taskId, dateKey }),
    addMilestone: (planId, data) => invoke('plans:add-milestone', { planId, data }),
    toggleMilestone: (planId, msId) => invoke('plans:toggle-milestone', { planId, msId }),
    removeMilestone: (planId, msId) => invoke('plans:remove-milestone', { planId, msId }),
    today: (dateKey) => invoke('plans:today', dateKey)
  },

  sessions: {
    list: (range) => invoke('sessions:list', range),
    add: (data) => invoke('sessions:add', data),
    update: (id, patch) => invoke('sessions:update', { id, patch }),
    remove: (id) => invoke('sessions:remove', id)
  },

  reminders: {
    list: () => invoke('reminders:list'),
    add: (data) => invoke('reminders:add', data),
    update: (id, patch) => invoke('reminders:update', { id, patch }),
    remove: (id) => invoke('reminders:remove', id)
  },

  reviews: {
    list: () => invoke('reviews:list'),
    queue: (dateKey) => invoke('reviews:queue', dateKey),
    stats: (horizon) => invoke('reviews:stats', horizon),
    curve: (stages) => invoke('reviews:curve', stages),
    add: (data) => invoke('reviews:add', data),
    update: (id, patch) => invoke('reviews:update', { id, patch }),
    remove: (id) => invoke('reviews:remove', id),
    grade: (id, result, dateKey) => invoke('reviews:grade', { id, result, dateKey }),
    reset: (id) => invoke('reviews:reset', id),
    fromMaterial: (materialId) => invoke('reviews:add-from-material', materialId)
  },

  preview: {
    probe: (id) => invoke('preview:probe', id),
    read: (id, mode) => invoke('preview:read', { id, mode }),
    openNative: (id) => invoke('preview:open-native', id)
  },

  autostart: {
    detect: () => invoke('autostart:detect'),
    install: () => invoke('autostart:install'),
    uninstall: () => invoke('autostart:uninstall'),
    test: () => invoke('autostart:test'),
    log: () => invoke('autostart:log')
  },

  timer: {
    state: () => invoke('timer:state'),
    start: (opts) => invoke('timer:start', opts),
    pause: () => invoke('timer:pause'),
    resume: () => invoke('timer:resume'),
    stop: () => invoke('timer:stop'),
    reset: () => invoke('timer:reset'),
    distraction: () => invoke('timer:distraction')
  },

  stats: {
    overview: () => invoke('stats:overview'),
    daily: (days) => invoke('stats:daily', days),
    subjects: (from, to) => invoke('stats:subjects', { from, to }),
    heatmap: (weeks) => invoke('stats:heatmap', weeks),
    hourly: (days) => invoke('stats:hourly', days),
    weeklyReport: (offset) => invoke('stats:weekly-report', offset),
    materialReport: () => invoke('stats:material-report'),
    planReport: () => invoke('stats:plan-report'),
    score: (from, to) => invoke('stats:score', { from, to })
  },

  settings: {
    get: () => invoke('settings:get'),
    update: (patch) => invoke('settings:update', patch)
  },

  notify: {
    history: () => invoke('notify:history'),
    clear: () => invoke('notify:clear'),
    read: () => invoke('notify:read'),
    test: () => invoke('notify:test')
  },

  system: {
    info: () => invoke('system:info'),
    openExternal: (url) => invoke('system:open-external', url),
    openPath: (p) => invoke('system:open-path', p),
    exportData: () => invoke('system:export-data'),
    importData: () => invoke('system:import-data'),
    clearDemo: () => invoke('system:clear-demo'),
    resetAll: () => invoke('system:reset-all'),
    backupList: () => invoke('system:backup-list'),
    restoreBackup: (name) => invoke('system:restore-backup', name)
  },

  win: {
    hide: () => invoke('win:hide'),
    minimize: () => invoke('win:minimize'),
    maximizeToggle: () => invoke('win:maximize-toggle'),
    close: () => invoke('win:close')
  },

  /* ---------------- 事件 ---------------- */
  on: {
    timer: (h) => on('timer:state', h),
    toast: (h) => on('notify:toast', h),
    navigate: (h) => on('app:navigate', h),
    data: (h) => on('app:data', h),
    scheduler: (h) => on('scheduler:fired', h)
  }
});
