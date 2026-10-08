'use strict';
/**
 * api-surface.js —— 渲染层能看到的全部能力（**唯一真值**）
 *
 * 这里只描述「有哪些能力、怎么调、参数怎么整形」，不关心底层怎么送过去：
 *   Electron：invoke → ipcRenderer.invoke（跨进程）
 *   网页版  ：invoke → 直接调用 ipc.js 里的 handler（同进程函数调用）
 *
 * 🔴 为什么不让网页版自己写一份 window.api：
 *   这里有 94 个叶子方法，其中 **19 个带参数整形** —— 例如
 *     update: (id, patch) => invoke('subjects:update', { id, patch })
 *   手抄的时候把 `{ id, patch }` 写成 `id, patch` 是必然会发生的事，
 *   而后果是「调用了、没报错、但数据没变」这种最难查的 bug。
 *   抽成共享模块后，两端的 API 形状与参数整形天然一致。
 */

/**
 * @param {object} deps
 * @param {(channel: string, ...args: any[]) => Promise<any>} deps.invoke  调用一个通道
 * @param {(channel: string, handler: Function) => Function} deps.on       订阅事件，返回取消订阅函数
 * @param {(file: File) => string} [deps.getPathForFile]                   拖拽文件取路径（仅桌面版有）
 */
function buildApi({ invoke, on, getPathForFile }) {
  return {
  /* ---------------- 读 ---------------- */
  snapshot: () => invoke('app:snapshot'),

  /* ---------------- 学科空间（多租户） ----------------
     一个空间 = 一套独立的科目/资料/计划/记录/复习。
     下面这些方法只管理空间本身；空间内部的增删改查仍然走
     subjects / plans / … —— 它们的作用域永远是当前空间。 */
  tenants: {
    list: () => invoke('tenants:list'),
    templates: () => invoke('tenants:templates'),
    create: (data) => invoke('tenants:create', data),
    fromTemplate: (templateId, level) => invoke('tenants:from-template', { templateId, level }),
    update: (id, patch) => invoke('tenants:update', { id, patch }),
    remove: (id) => invoke('tenants:remove', id),
    switch: (id) => invoke('tenants:switch', id),
    compare: () => invoke('tenants:compare')
  },

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
      try { return getPathForFile(file); } catch (_) { return ''; }
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
  };
}

module.exports = { buildApi };
