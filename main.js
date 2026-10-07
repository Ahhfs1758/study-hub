'use strict';
/**
 * main.js —— 主进程入口
 *
 * 启动顺序（顺序有讲究，别随便调换）：
 *   单实例锁 → 建数据目录 → 开库（首次写示例数据）→ 恢复未走完的计时
 *   → 注册 IPC → 建窗口 → 托盘 → 菜单 → 启动提醒调度器
 * 调度放在最后：它是唯一会主动弹东西的模块，必须等界面就绪之后再开始跑。
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, powerMonitor, globalShortcut, dialog, ipcMain } = require('electron');

const { Store, seedDB, defaultDB } = require('./src/main/store');
const { StudyTimer } = require('./src/main/timer');
const { Notifier } = require('./src/main/notifier');
const { Scheduler } = require('./src/main/scheduler');
const { Autostart } = require('./src/main/autostart');
const A = require('./src/main/analytics');
const U = require('./src/main/util');
const ipc = require('./src/main/ipc');

const IS_DEV = process.argv.includes('--dev');
const ROOT = __dirname;

/* Windows 上任务栏分组和通知都依赖这个 id，必须在建窗口之前设好 */
app.setAppUserModelId('tech.studyhub.app');

/* ------------------------------------------------------------------ *
 * 后台巡检模式
 *
 * 由系统调度器（Windows 任务计划 / 手动测试）拉起，跑一次提醒扫描就退出，
 * 全程不建窗口。macOS 走的是 launchd + ELECTRON_RUN_AS_NODE（纯 Node，更快），
 * 这条路径是给「没法注入环境变量」的 Windows 任务计划用的。
 * 必须放在单实例锁之前 —— 否则应用正在运行时这次巡检会被锁挡掉。
 * ------------------------------------------------------------------ */
if (process.argv.includes('--reminder-scan')) {
  const { run } = require('./src/daemon/reminder-daemon');
  const quiet = process.argv.includes('--quiet');
  const dataIdx = process.argv.indexOf('--data-dir');
  const dataDir = (dataIdx > -1 && process.argv[dataIdx + 1]) || app.getPath('userData');
  run({ once: true, dataDir, quiet, force: false, dryRun: false }).then((res) => {
    if (!quiet) console.log(JSON.stringify(res, null, 2));
    app.exit(res.ok ? 0 : 1);
  }).catch((err) => {
    if (!quiet) console.error(String(err && err.stack || err));
    app.exit(2);
  });
} else {
  /* 单实例：第二次启动只是把已有窗口唤到前台 */
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    bootstrap();
  }
}

let mainWindow = null;
let tray = null;
let isQuitting = false;
const ctx = {};

function asset(p) {
  const full = path.join(ROOT, 'assets', p);
  return fs.existsSync(full) ? full : null;
}

function bootstrap() {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(() => {
    const dataDir = app.getPath('userData');
    const vaultDir = path.join(dataDir, 'vault');

    /* ---- 数据 ---- */
    const store = new Store(dataDir);
    const fresh = !fs.existsSync(store.file);
    store.init();
    if (fresh || (store.read().subjects.length === 0 && store.read().sessions.length === 0 && !store.read().meta.demo)) {
      seedDB(store);
    }

    /* ---- 组件 ---- */
    const notifier = new Notifier({
      store,
      onActivate: (action, payload) => {
        /* 只有 'toast' 会变成界面浮层。
           这里刻意不再接 'history' —— 早先 Notifier 每发一条通知会同时抛 'history'
           和 'toast'，而两个都往渲染层送浮层，用户会看到每条提醒弹出两个一模一样的卡片。
           'history-cleared' 只是「记录被清空了」，刷新角标即可，同样不该弹浮层。 */
        if (action === 'toast') {
          for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) w.webContents.send('notify:toast', payload);
          }
          return;
        }
        if (action === 'history-cleared') {
          sendToRenderer('app:data', ctx.snapshot());
          return;
        }
        if (action === 'focus') {
          showWindow();
          if (payload && payload.route) sendToRenderer('app:navigate', payload.route);
          return;
        }
        if (action === 'scheduler') {
          sendToRenderer('scheduler:fired', payload);
        }
      }
    });

    const timer = new StudyTimer(store);
    const scheduler = new Scheduler({ store, notifier, timer, dataDir });
    const autostart = new Autostart({ dataDir, execPath: () => process.execPath });

    Object.assign(ctx, { store, timer, notifier, scheduler, autostart, dataDir, vaultDir });

    /* ---- IPC（必须在建窗口之前注册，否则前端首帧的 invoke 会打空） ----
       处理逻辑在 src/main/ipc.js 里，与网页版共用同一份；
       这里只做「把通道表挂到 ipcMain」这一件事。 */
    const host = require('./src/main/host-electron').createHost();
    const handlers = ipc.createHandlers(ctx, host);
    for (const [channel, fn] of Object.entries(handlers)) {
      ipcMain.handle(channel, (_e, ...args) => fn(...args));
    }
    ctx.host = host;
    ctx.handlers = handlers;

    /* ---- 计时事件 → 渲染层 ---- */
    timer.on('change', () => {
      sendToRenderer('timer:state', timer.getState());
      updateTrayTitle();
    });
    timer.on('phase-complete', () => {
      sendToRenderer('app:data', ctx.snapshot());
    });

    /* ---- 窗口 ---- */
    createWindow();

    /* ---- 托盘 ---- */
    createTray();

    /* ---- 菜单 ---- */
    buildMenu();

    /* ---- 恢复未走完的一段 ---- */
    timer.restore();

    /* ---- 调度器 ---- */
    scheduler.start();

    /* ---- 全局快捷键：随时开始/暂停一段专注 ---- */
    try {
      globalShortcut.register('CommandOrControl+Shift+S', () => {
        const st = timer.getState();
        if (!st.running) timer.start({ mode: 'pomodoro', phase: 'focus', subjectId: st.subjectId, materialId: st.materialId, taskId: st.taskId });
        else if (st.paused) timer.resume();
        else timer.pause();
        showWindow();
      });
    } catch (_) {}

    /* ---- 托盘文案每 30 秒跟上一次（今日时长、剩余时间） ---- */
    const trayTimer = setInterval(() => { updateTrayTitle(); refreshTrayMenu(); }, 30000);
    if (trayTimer.unref) trayTimer.unref();

    /* ---- 系统事件触发一次规则扫描 ---- */
    powerMonitor.on('resume', () => setTimeout(() => scheduler.check(), 3000));
    powerMonitor.on('unlock-screen', () => setTimeout(() => scheduler.check(), 3000));

    sendToRenderer('app:data', ctx.snapshot());

    /* ---- 开发期自检：STUDY_HUB_SELFTEST=1 npm start ---- */
    if (process.env.STUDY_HUB_SELFTEST) {
      const selftest = require('./src/main/selftest');
      const outDir = process.env.STUDY_HUB_SHOTS || path.join(ROOT, '.selftest');
      mainWindow.once('ready-to-show', async () => {
        let report;
        try {
          report = await selftest.run(Object.assign({ mainWindow }, ctx), outDir);
        } catch (err) {
          report = { ok: false, errors: [{ where: 'selftest-crash', error: String(err && err.stack || err) }] };
        }
        console.log('\n===== SELFTEST REPORT =====');
        console.log(JSON.stringify(report, null, 2));
        try {
          fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
        } catch (_) {}
        isQuitting = true;
        store.flush();
        app.exit(report.ok ? 0 : 1);
      });
    }
  });

  app.on('window-all-closed', () => {
    // 有托盘时窗口全关也不退出，提醒才能继续跑
    if (process.platform !== 'darwin' && !ctx.store?.read().profile.minimizeToTray) app.quit();
  });

  app.on('activate', () => showWindow());

  app.on('before-quit', () => {
    isQuitting = true;
    try { globalShortcut.unregisterAll(); } catch (_) {}
    try { ctx.timer?.shutdown(); } catch (_) {}
    try { ctx.scheduler?.stop(); } catch (_) {}
    try { ctx.store?.flush(); } catch (_) {}
  });
}

/* ------------------------------------------------------------------ *
 * 窗口
 * ------------------------------------------------------------------ */

function createWindow() {
  const opts = {
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#f5f7fb',
    title: '学习中心',
    icon: asset('icon.png') || undefined,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false   // 界面在后台时也保持每秒刷新计时，避免回到前台时数字跳变
    }
  };
  if (process.platform === 'darwin') {
    opts.titleBarStyle = 'hiddenInset';
    opts.trafficLightPosition = { x: 14, y: 16 };
  }

  mainWindow = new BrowserWindow(opts);
  mainWindow.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  // 外链一律走系统浏览器，不在应用内开新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', (e) => {
    const minimize = ctx.store ? ctx.store.read().profile.minimizeToTray : true;
    if (!isQuitting && minimize) {
      e.preventDefault();
      mainWindow.hide();
      notifyTrayHint();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (process.platform === 'darwin' && app.dock) app.dock.show();
}

let trayHinted = false;
function notifyTrayHint() {
  if (trayHinted) return;
  trayHinted = true;
  ctx.notifier?.send({
    kind: 'info',
    title: '学习中心还在后台运行',
    body: '窗口已收进菜单栏，提醒和计时照常工作。需要退出请用菜单栏图标里的「退出」。',
    route: 'dashboard'
  });
}

function sendToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

/* ------------------------------------------------------------------ *
 * 托盘
 * ------------------------------------------------------------------ */

function createTray() {
  if (process.platform === 'darwin' && app.dock) app.dock.setMenu(trayDockMenu());

  let image = null;
  const p = asset(process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png');
  if (p) {
    image = nativeImage.createFromPath(p);
    if (process.platform === 'darwin') image.setTemplateImage(true);
  }
  if (!image || image.isEmpty()) image = nativeImage.createEmpty();

  tray = new Tray(image);
  tray.setToolTip('学习中心');
  tray.on('click', () => {
    if (process.platform === 'darwin') tray.popUpContextMenu();
    else showWindow();
  });
  tray.on('double-click', () => showWindow());
  refreshTrayMenu();
}

function trayDockMenu() {
  return Menu.buildFromTemplate([
    { label: '开始专注', click: () => startFocusFromTray() },
    { label: '显示主窗口', click: () => showWindow() }
  ]);
}

function startFocusFromTray() {
  const st = ctx.timer.getState();
  if (!st.running) ctx.timer.start({ mode: 'pomodoro', phase: 'focus', subjectId: st.subjectId || '', materialId: st.materialId || '' });
  else if (st.paused) ctx.timer.resume();
  else ctx.timer.pause();
  showWindow();
}

function updateTrayTitle() {
  if (!tray || process.platform !== 'darwin') return;
  const st = ctx.timer.getState();
  if (st.running && st.mode === 'pomodoro' && !st.paused) {
    const sec = Math.ceil(st.remainingMs / 1000);
    const m = Math.floor(sec / 60), s = sec % 60;
    tray.setTitle(` ${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`);
    tray.setToolTip(st.phase === 'focus' ? '专注中' : '休息中');
  } else {
    const today = ctx.timer.todayMinutes();
    tray.setTitle(today ? ` ${today}m` : '');
    tray.setToolTip(`学习中心 · 今日 ${U.humanMin(today)}`);
  }
}

/** 托盘里显示的复习队列摘要 */
function reviewTrayLabel() {
  const q = A.reviewQueue(ctx.store.read(), U.dayKey());
  if (!q.total) return '今天没有待复习';
  return q.overdue.length ? `待复习 ${q.total} 个（逾期 ${q.overdue.length}）` : `待复习 ${q.total} 个`;
}

function refreshTrayMenu() {
  if (!tray) return;
  const st = ctx.timer.getState();
  const today = A.sumRange(ctx.store.read(), U.dayKey(), U.dayKey());
  const ov = A.overview(ctx.store.read());

  const startItem = st.running
    ? { label: st.paused ? '继续专注' : '暂停专注', click: () => { st.paused ? ctx.timer.resume() : ctx.timer.pause(); refreshTrayMenu(); } }
    : { label: '开始专注', click: () => { startFocusFromTray(); refreshTrayMenu(); } };

  const template = [
    { label: `今日已学 ${U.humanMin(today.minutes)} / 目标 ${U.humanMin(ov.dailyGoalMin)}`, enabled: false },
    { label: `连续 ${ov.streak.current} 天 · 本周评分 ${ov.score.score}`, enabled: false },
    { label: reviewTrayLabel(), enabled: false },
    { type: 'separator' },
    startItem,
    { label: st.running ? '结束本段并记录' : '开始正计时', click: () => { st.running ? ctx.timer.stop() : ctx.timer.start({ mode: 'stopwatch' }); refreshTrayMenu(); } },
    { type: 'separator' },
    { label: '打开学习中心', click: () => showWindow() },
    { label: '开始一段专注（前台）', click: () => { showWindow(); sendToRenderer('app:navigate', 'focus'); } },
    { label: '今日任务', click: () => { showWindow(); sendToRenderer('app:navigate', 'plans'); } },
    { label: '今日复习', click: () => { showWindow(); sendToRenderer('app:navigate', 'srs'); } },
    { label: '本周复盘', click: () => { showWindow(); sendToRenderer('app:navigate', 'review'); } },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; ctx.store.flush(); app.quit(); } }
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ *
 * 应用菜单
 * ------------------------------------------------------------------ */

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const go = (view) => () => { showWindow(); sendToRenderer('app:navigate', view); };

  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about', label: '关于 学习中心' },
        { type: 'separator' },
        { label: '偏好设置…', accelerator: 'CmdOrCtrl+,', click: go('settings') },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏 学习中心' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出 学习中心' }
      ]
    }] : []),
    {
      label: '文件',
      submenu: [
        { label: '导出数据…', click: () => { showWindow(); sendToRenderer('app:navigate', 'settings'); } },
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit', label: '退出' }])
      ]
    },
    {
      label: '学习',
      submenu: [
        {
          label: '开始 / 暂停专注',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => {
            const st = ctx.timer.getState();
            if (!st.running) ctx.timer.start({ mode: 'pomodoro', phase: 'focus' });
            else if (st.paused) ctx.timer.resume();
            else ctx.timer.pause();
            showWindow();
          }
        },
        { label: '结束本段并记录', accelerator: 'CmdOrCtrl+Shift+E', click: () => { ctx.timer.stop(); refreshTrayMenu(); } },
        { label: '记一次分心', accelerator: 'CmdOrCtrl+Shift+D', click: () => ctx.timer.markDistraction() },
        { type: 'separator' },
        { label: '开始正计时', click: () => { showWindow(); sendToRenderer('app:navigate', 'focus'); } }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '仪表盘', accelerator: 'CmdOrCtrl+1', click: go('dashboard') },
        { label: '专注', accelerator: 'CmdOrCtrl+2', click: go('focus') },
        { label: '学习计划', accelerator: 'CmdOrCtrl+3', click: go('plans') },
        { label: '学习资料', accelerator: 'CmdOrCtrl+4', click: go('materials') },
        { label: '复习', accelerator: 'CmdOrCtrl+5', click: go('srs') },
        { label: '时间统计', accelerator: 'CmdOrCtrl+6', click: go('stats') },
        { label: '监督复盘', accelerator: 'CmdOrCtrl+7', click: go('review') },
        { label: '设置', accelerator: 'CmdOrCtrl+8', click: go('settings') },
        { type: 'separator' },
        { role: 'reload', label: '重新加载界面' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    ...(isMac ? [{ role: 'windowMenu', label: '窗口' }] : []),
    {
      label: '帮助',
      submenu: [
        { label: '打开数据目录', click: () => { fs.mkdirSync(ctx.dataDir, { recursive: true }); shell.openPath(ctx.dataDir); } },
        { label: '数据存放在哪里？', click: () => {
          dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: '数据位置',
            message: '所有学习数据都在你自己的电脑上',
            detail: `主数据文件：\n${ctx.store.file}\n\n自动备份：\n${ctx.store.backupDir}\n\n不会上传到任何服务器。在设置页可以导出成 JSON 带走。`,
            buttons: ['好']
          });
        } },
        { label: '测试提醒通道', click: () => ctx.notifier.send({ kind: 'info', title: '通知通道正常', body: '系统通知与窗口浮层都能收到。', force: true }) }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { ctx };
