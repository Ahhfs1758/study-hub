'use strict';
/**
 * ipc.js —— 主进程能力对渲染层的唯一出口
 *
 * 约定：
 *  - 每个 handler 只做「校验入参 → 改 store → 广播新快照」三件事，不在里面写业务推导。
 *  - 任何会改变数据的调用结束后都广播 app:data，前端拿到全量快照重渲染。
 *    个人应用的库只有几百 KB，全量广播换来的是「界面永远不会和后端不一致」。
 */

const fs = require('fs');
const path = require('path');
const { app, dialog, shell, BrowserWindow } = require('electron');

const A = require('./analytics');
const U = require('./util');
const M = require('./materials');
const P = require('./preview');
const { uid, nowISO } = require('./store');

function register(ctx) {
  const { store, timer, notifier, scheduler, autostart, dataDir, vaultDir } = ctx;
  const ipcMain = require('electron').ipcMain;

  const snapshot = () => ({
    db: store.read(),
    overview: A.overview(store.read()),
    timer: timer.getState(),
    unread: notifier.unreadCount(),
    review: A.reviewStats(store.read(), 14),
    dataDir,
    platform: process.platform,
    version: app.getVersion(),
    demo: !!store.read().meta.demo,
    lastError: store._lastError || null
  });

  const broadcast = () => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('app:data', snapshot());
    }
  };
  ctx.broadcast = broadcast;
  ctx.snapshot = snapshot;

  const focusedWin = () => BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;

  /* ------------------------------------------------------------------ *
   * 应用
   * ------------------------------------------------------------------ */
  ipcMain.handle('app:snapshot', () => snapshot());

  /* ------------------------------------------------------------------ *
   * 科目
   * ------------------------------------------------------------------ */
  ipcMain.handle('subjects:list', () => store.list('subjects'));
  ipcMain.handle('subjects:add', (_e, data) => {
    const row = store.insert('subjects', {
      name: String(data.name || '').trim() || '未命名科目',
      color: data.color || '#2563eb',
      goalMinPerWeek: Number(data.goalMinPerWeek) || 0
    });
    broadcast();
    return row;
  });
  ipcMain.handle('subjects:update', (_e, { id, patch }) => {
    const r = store.patch('subjects', id, patch);
    broadcast();
    return r;
  });
  ipcMain.handle('subjects:remove', (_e, id) => {
    store.update((db) => {
      db.subjects = db.subjects.filter((s) => s.id !== id);
      // 不删关联数据，只把归属置空——历史记录比科目本身更值钱
      db.materials.forEach((m) => { if (m.subjectId === id) m.subjectId = ''; });
      db.plans.forEach((p) => { if (p.subjectId === id) p.subjectId = ''; });
      db.sessions.forEach((s) => { if (s.subjectId === id) s.subjectId = ''; });
      db.reminders.forEach((r) => { if (r.subjectId === id) r.subjectId = ''; });
    }, { immediate: true });
    broadcast();
    return true;
  });

  /* ------------------------------------------------------------------ *
   * 资料
   * ------------------------------------------------------------------ */
  ipcMain.handle('materials:list', () => store.list('materials'));
  ipcMain.handle('materials:add', (_e, data) => {
    const row = store.insert('materials', {
      title: String(data.title || '').trim() || '未命名资料',
      type: data.type || 'other',
      subjectId: data.subjectId || '',
      tags: Array.isArray(data.tags) ? data.tags : [],
      note: data.note || '',
      body: data.body || '',
      url: data.url || '',
      path: data.path || '',
      ext: data.ext || '',
      size: data.size || 0,
      status: data.status || 'todo',
      progress: Number(data.progress) || 0,
      totalUnits: Number(data.totalUnits) || 0,
      doneUnits: Number(data.doneUnits) || 0,
      unitLabel: data.unitLabel || '',
      openCount: 0,
      timeSpentMin: 0,
      lastOpenedAt: null
    });
    broadcast();
    return row;
  });
  ipcMain.handle('materials:update', (_e, { id, patch }) => {
    const r = store.patch('materials', id, patch);
    broadcast();
    return r;
  });
  ipcMain.handle('materials:remove', (_e, id) => {
    store.remove('materials', id);
    broadcast();
    return true;
  });
  ipcMain.handle('materials:open', async (_e, id) => {
    const m = store.find('materials', id);
    if (!m) return { ok: false, message: '资料不存在' };
    const r = await M.openMaterial(m);
    if (r.ok) {
      store.patch('materials', id, {
        openCount: (m.openCount || 0) + 1,
        lastOpenedAt: nowISO(),
        status: m.status === 'todo' ? 'doing' : m.status
      });
      broadcast();
    }
    return r;
  });
  ipcMain.handle('materials:log-open', (_e, id) => {
    const m = store.find('materials', id);
    if (!m) return false;
    store.patch('materials', id, {
      openCount: (m.openCount || 0) + 1,
      lastOpenedAt: nowISO()
    });
    broadcast();
    return true;
  });
  ipcMain.handle('materials:reveal', (_e, id) => {
    const m = store.find('materials', id);
    return m ? M.revealInFolder(m.path) : { ok: false, message: '资料不存在' };
  });

  ipcMain.handle('materials:pick-files', async () => {
    const win = focusedWin();
    const res = await dialog.showOpenDialog(win, {
      title: '选择要加入资料库的文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '文档与资料', extensions: Object.keys(M.DOC_EXT) },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (res.canceled) return [];
    return res.filePaths.map((f) => {
      const ext = M.extOf(f);
      let st = null;
      try { st = fs.statSync(f); } catch (_) {}
      return {
        title: path.basename(f, path.extname(f)),
        path: f, ext, type: M.typeOfExt(ext),
        size: st ? st.size : 0, sizeText: st ? M.humanSize(st.size) : ''
      };
    });
  });

  ipcMain.handle('materials:pick-folder', async () => {
    const win = focusedWin();
    const res = await dialog.showOpenDialog(win, {
      title: '选择要扫描的文件夹',
      properties: ['openDirectory']
    });
    if (res.canceled || !res.filePaths.length) return null;
    const dir = res.filePaths[0];
    return { dir, name: path.basename(dir), files: M.scanFolder(dir) };
  });

  ipcMain.handle('materials:scan-folder', (_e, { dir }) => M.scanFolder(dir));

  /* ------------------------------------------------------------------ *
   * 计划
   * ------------------------------------------------------------------ */
  ipcMain.handle('plans:list', () => store.list('plans'));
  ipcMain.handle('plans:add', (_e, data) => {
    const row = store.insert('plans', {
      title: String(data.title || '').trim() || '未命名计划',
      subjectId: data.subjectId || '',
      desc: data.desc || '',
      startDate: data.startDate || U.dayKey(),
      endDate: data.endDate || U.dayKey(U.addDays(new Date(), 29)),
      priority: Number(data.priority) || 2,
      status: data.status || 'active',
      milestones: [],
      tasks: []
    });
    broadcast();
    return row;
  });
  ipcMain.handle('plans:update', (_e, { id, patch }) => {
    const r = store.patch('plans', id, patch);
    broadcast();
    return r;
  });
  ipcMain.handle('plans:remove', (_e, id) => {
    store.remove('plans', id);
    broadcast();
    return true;
  });

  const withPlan = (planId, fn) => store.update((db) => {
    const plan = db.plans.find((p) => p.id === planId);
    if (!plan) return null;
    plan.updatedAt = nowISO();
    return fn(plan, db);
  }, { immediate: true });

  ipcMain.handle('plans:add-task', (_e, { planId, data }) => {
    const t = withPlan(planId, (plan) => {
      const task = {
        id: uid('task_'),
        title: String(data.title || '').trim() || '未命名任务',
        date: data.date || plan.startDate || U.dayKey(),
        repeat: data.repeat || 'none',
        weekdays: Array.isArray(data.weekdays) ? data.weekdays : [],
        estMin: Number(data.estMin) || 30,
        materialId: data.materialId || '',
        done: false,
        doneDates: [],
        createdAt: nowISO()
      };
      plan.tasks.push(task);
      return task;
    });
    broadcast();
    return t;
  });
  ipcMain.handle('plans:update-task', (_e, { planId, taskId, patch }) => {
    const t = withPlan(planId, (plan) => {
      const task = plan.tasks.find((x) => x.id === taskId);
      if (task) Object.assign(task, patch);
      return task || null;
    });
    broadcast();
    return t;
  });
  ipcMain.handle('plans:remove-task', (_e, { planId, taskId }) => {
    withPlan(planId, (plan) => { plan.tasks = plan.tasks.filter((x) => x.id !== taskId); });
    broadcast();
    return true;
  });
  ipcMain.handle('plans:toggle-task', (_e, { planId, taskId, dateKey }) => {
    const key = dateKey || U.dayKey();
    const result = store.update((db) => {
      const plan = db.plans.find((p) => p.id === planId);
      if (!plan) return null;
      const task = plan.tasks.find((x) => x.id === taskId);
      if (!task) return null;
      task.doneDates = Array.isArray(task.doneDates) ? task.doneDates : [];
      const i = task.doneDates.indexOf(key);
      const marking = i < 0;
      if (marking) task.doneDates.push(key);
      else task.doneDates.splice(i, 1);
      if (task.repeat === 'none' || !task.repeat) {
        task.done = task.doneDates.length > 0;
        task.doneAt = task.done ? new Date().toISOString() : null;
      }
      plan.updatedAt = nowISO();

      /* 勾掉任务时自动排一次复习 —— 这是让「计划」和「记住」真正接上的那一环。
         没有这一步，用户会把书看完然后忘光，系统却显示「100% 完成」。 */
      let addedReview = null;
      if (marking && db.profile.reviewAutoAdd !== false) {
        const title = task.title;
        const dup = db.reviews.find((r) => r.title === title && !r.archived && !r.mastered);
        if (!dup) {
          addedReview = {
            id: uid('rev_'),
            title,
            subjectId: plan.subjectId || '',
            materialId: task.materialId || '',
            note: '来自计划「' + plan.title + '」，完成于 ' + key,
            stage: 0, lapses: 0, mastered: false, archived: false,
            learnedAt: key, lastAt: key,
            nextAt: A.nextReviewAt(0, key),
            history: [],
            createdAt: nowISO(), updatedAt: nowISO(),
            auto: true
          };
          db.reviews.push(addedReview);
        }
      }
      return { task, addedReview };
    }, { immediate: true });
    broadcast();
    return result ? result.task : null;
  });
  ipcMain.handle('plans:add-milestone', (_e, { planId, data }) => {
    const m = withPlan(planId, (plan) => {
      plan.milestones = plan.milestones || [];
      const ms = { id: uid('ms_'), title: String(data.title || '').trim() || '阶段目标', due: data.due || '', done: false };
      plan.milestones.push(ms);
      return ms;
    });
    broadcast();
    return m;
  });
  ipcMain.handle('plans:toggle-milestone', (_e, { planId, msId }) => {
    const m = withPlan(planId, (plan) => {
      const ms = (plan.milestones || []).find((x) => x.id === msId);
      if (ms) ms.done = !ms.done;
      return ms || null;
    });
    broadcast();
    return m;
  });
  ipcMain.handle('plans:remove-milestone', (_e, { planId, msId }) => {
    withPlan(planId, (plan) => { plan.milestones = (plan.milestones || []).filter((x) => x.id !== msId); });
    broadcast();
    return true;
  });
  ipcMain.handle('plans:today', (_e, dateKey) => {
    const key = dateKey || U.dayKey();
    return A.tasksOn(store.read(), key).map((r) => ({
      taskId: r.task.id, planId: r.plan.id, plan: r.plan.title, planSubject: r.plan.subjectId,
      title: r.task.title, estMin: r.task.estMin, repeat: r.task.repeat, done: r.done,
      materialId: r.task.materialId || ''
    }));
  });

  /* ------------------------------------------------------------------ *
   * 学习记录
   * ------------------------------------------------------------------ */
  ipcMain.handle('sessions:list', (_e, range) => {
    const all = store.list('sessions');
    if (!range || (!range.from && !range.to)) return all;
    const from = range.from || '0000-01-01';
    const to = range.to || '9999-12-31';
    return all.filter((s) => {
      const k = U.dayKey(new Date(s.start));
      return k >= from && k <= to;
    });
  });
  ipcMain.handle('sessions:add', (_e, data) => {
    const minutes = Math.max(1, Number(data.minutes) || 0);
    const end = data.end ? new Date(data.end) : new Date();
    const start = data.start ? new Date(data.start) : new Date(end.getTime() - minutes * 60000);
    const row = store.insert('sessions', {
      subjectId: data.subjectId || '',
      materialId: data.materialId || '',
      planId: data.planId || '',
      taskId: data.taskId || '',
      start: start.toISOString(),
      end: end.toISOString(),
      minutes,
      mode: 'manual',
      phase: 'free',
      interruptions: Number(data.interruptions) || 0,
      focusScore: data.focusScore == null ? null : Number(data.focusScore),
      note: data.note || ''
    });
    // 手工补录也要回写资料与任务，保持和其它入口一致
    store.update((db) => {
      if (row.materialId) {
        const m = db.materials.find((x) => x.id === row.materialId);
        if (m) {
          m.timeSpentMin = (m.timeSpentMin || 0) + minutes;
          m.lastOpenedAt = row.end;
          if (m.status === 'todo') m.status = 'doing';
        }
      }
      if (row.taskId) {
        for (const plan of db.plans) {
          const t = (plan.tasks || []).find((x) => x.id === row.taskId);
          if (!t) continue;
          const key = U.dayKey(new Date(row.end));
          t.doneDates = t.doneDates || [];
          if (!t.doneDates.includes(key)) t.doneDates.push(key);
          break;
        }
      }
    }, { immediate: true });
    broadcast();
    return row;
  });
  ipcMain.handle('sessions:update', (_e, { id, patch }) => {
    const r = store.patch('sessions', id, patch);
    broadcast();
    return r;
  });
  ipcMain.handle('sessions:remove', (_e, id) => {
    store.remove('sessions', id);
    broadcast();
    return true;
  });

  /* ------------------------------------------------------------------ *
   * 提醒
   * ------------------------------------------------------------------ */
  ipcMain.handle('reminders:list', () => store.list('reminders'));
  ipcMain.handle('reminders:add', (_e, data) => {
    const row = store.insert('reminders', {
      title: String(data.title || '').trim() || '学习提醒',
      time: data.time || '19:30',
      repeat: data.repeat || 'daily',
      weekdays: Array.isArray(data.weekdays) ? data.weekdays : [],
      date: data.date || '',
      type: data.type || 'study',
      subjectId: data.subjectId || '',
      enabled: data.enabled !== false,
      lastFired: ''
    });
    broadcast();
    return row;
  });
  ipcMain.handle('reminders:update', (_e, { id, patch }) => {
    const r = store.patch('reminders', id, patch);
    broadcast();
    return r;
  });
  ipcMain.handle('reminders:remove', (_e, id) => {
    store.remove('reminders', id);
    broadcast();
    return true;
  });

  /* ------------------------------------------------------------------ *
   * 复习（间隔重复）
   * ------------------------------------------------------------------ */

  const addReview = (data) => {
    const today = U.dayKey();
    const learned = data.learnedAt || today;
    const row = store.insert('reviews', {
      title: String(data.title || '').trim() || '未命名知识点',
      subjectId: data.subjectId || '',
      materialId: data.materialId || '',
      note: data.note || '',
      stage: 0,
      lapses: 0,
      mastered: false,
      archived: false,
      learnedAt: learned,
      lastAt: learned,
      // 新加入的条目第一次复习安排在第二天 —— 当天刚学完就复习没有意义
      nextAt: A.nextReviewAt(0, learned),
      history: []
    });
    broadcast();
    return row;
  };

  ipcMain.handle('reviews:list', () => store.list('reviews'));
  ipcMain.handle('reviews:queue', (_e, key) => {
    const q = A.reviewQueue(store.read(), key || U.dayKey());
    const brief = (r) => ({
      id: r.id, title: r.title, subjectId: r.subjectId, materialId: r.materialId, note: r.note,
      stage: r.stage, lapses: r.lapses, nextAt: r.nextAt, lastAt: r.lastAt,
      attempts: (r.history || []).length, learnedAt: r.learnedAt
    });
    return { due: q.due.map(brief), overdue: q.overdue.map(brief), upcoming: q.upcoming.slice(0, 40).map(brief), total: q.total };
  });
  ipcMain.handle('reviews:stats', (_e, horizon) => A.reviewStats(store.read(), Number(horizon) || 14));
  ipcMain.handle('reviews:curve', (_e, stages) => A.retentionCurve(Number(stages) || 7, 30));
  ipcMain.handle('reviews:add', (_e, data) => addReview(data || {}));
  ipcMain.handle('reviews:update', (_e, { id, patch }) => {
    const p = { ...patch };
    // 改「首次学习日」要连带把下一次复习日重排，否则会留下一个未来的空档
    if (p.learnedAt && !p.nextAt) {
      const r = store.find('reviews', id);
      if (r && (r.history || []).length === 0) p.nextAt = A.nextReviewAt(0, p.learnedAt);
    }
    const row = store.patch('reviews', id, p);
    broadcast();
    return row;
  });
  ipcMain.handle('reviews:remove', (_e, id) => {
    store.remove('reviews', id);
    broadcast();
    return true;
  });

  /** 评分：good / fuzzy / forgot —— 间隔重复的核心动作 */
  ipcMain.handle('reviews:grade', (_e, { id, result, dateKey }) => {
    const today = dateKey || U.dayKey();
    const row = store.update((db) => {
      const r = db.reviews.find((x) => x.id === id);
      if (!r) return null;
      const next = A.advanceReview(r, result, today);
      Object.assign(r, next, { updatedAt: nowISO() });
      r.history = Array.isArray(r.history) ? r.history : [];
      // 同一天重复评分只保留最后一次，免得一天里连点三次把历史撑爆
      const last = r.history[r.history.length - 1];
      if (last && last.date === today) last.result = result;
      else r.history.push({ date: today, result });
      // 归档的条目被重新复习时自动回到队列
      if (next.mastered) r.mastered = true;
      return r;
    }, { immediate: true });
    broadcast();
    return row;
  });
  ipcMain.handle('reviews:add-from-material', (_e, materialId) => {
    const m = store.find('materials', materialId);
    if (!m) return { ok: false, message: '资料不存在' };
    const exists = store.list('reviews').find((r) => r.materialId === materialId && !r.archived && !r.mastered);
    if (exists) return { ok: true, row: exists, already: true };
    return { ok: true, row: addReview({ title: m.title, subjectId: m.subjectId, materialId, note: m.note || '' }) };
  });
  ipcMain.handle('reviews:reset', (_e, id) => {
    const row = store.update((db) => {
      const r = db.reviews.find((x) => x.id === id);
      if (!r) return null;
      r.stage = 0; r.lapses = 0; r.mastered = false; r.nextAt = A.nextReviewAt(0, U.dayKey());
      r.lastAt = U.dayKey();
      return r;
    }, { immediate: true });
    broadcast();
    return row;
  });

  /* ------------------------------------------------------------------ *
   * 资料预览
   * ------------------------------------------------------------------ */
  ipcMain.handle('preview:probe', (_e, id) => {
    const m = store.find('materials', id);
    if (!m) return { ok: false, message: '资料不存在' };
    if (!m.path) {
      // 没有本地文件时，正文和备注都算内容 —— 笔记就是 Markdown
      if (m.body) return { ok: true, kind: 'inline-note', title: m.title, body: m.body, note: m.note || '' };
      if (m.note) return { ok: true, kind: 'inline-note', title: m.title, body: m.note, note: '', fromNote: true };
      if (m.url) return { ok: true, kind: 'link', url: m.url, title: m.title };
      return { ok: false, message: '这份资料既没有文件路径、也没有链接或笔记内容。可以在详情里补上。' };
    }
    const info = P.probe(m.path);
    return { ok: true, ...info, title: m.title, path: m.path };
  });

  ipcMain.handle('preview:read', (_e, { id, mode }) => {
    const m = store.find('materials', id);
    if (!m || !m.path) return { ok: false, message: '这份资料没有本地文件' };
    if (mode === 'image') {
      const r = P.readImage(m.path);
      if (r.ok) store.patch('materials', id, { openCount: (m.openCount || 0) + 1, lastOpenedAt: nowISO(), status: m.status === 'todo' ? 'doing' : m.status });
      broadcast();
      return { ...r, title: m.title };
    }
    const r = P.readText(m.path);
    if (r.ok) {
      store.patch('materials', id, { openCount: (m.openCount || 0) + 1, lastOpenedAt: nowISO(), status: m.status === 'todo' ? 'doing' : m.status });
      broadcast();
    }
    return { ...r, title: m.title, name: require('path').basename(m.path) };
  });

  /** 内联预览 -> 打开（PDF 走独立窗口，其他走系统默认程序） */
  ipcMain.handle('preview:open-native', async (_e, id) => {
    const m = store.find('materials', id);
    if (!m) return { ok: false, message: '资料不存在' };
    if (!m.path) return { ok: false, message: '这份资料没有本地文件' };
    const info = P.probe(m.path);
    const r = info.kind === 'pdf' ? P.openPdfWindow(m.path, m.title) : await P.openExternal(m.path);
    if (r.ok) {
      store.patch('materials', id, { openCount: (m.openCount || 0) + 1, lastOpenedAt: nowISO(), status: m.status === 'todo' ? 'doing' : m.status });
      broadcast();
    }
    return r;
  });

  /* ------------------------------------------------------------------ *
   * 后台提醒守护
   * ------------------------------------------------------------------ */
  ipcMain.handle('autostart:detect', async () => {
    if (!autostart) return { supported: false };
    const info = await autostart.detect();
    return { ...info, recentLog: autostart.daemonLog(10) };
  });
  ipcMain.handle('autostart:install', async () => {
    if (!autostart) return { ok: false, message: '不支持' };
    const r = await autostart.install();
    broadcast();
    return r;
  });
  ipcMain.handle('autostart:uninstall', async () => {
    if (!autostart) return { ok: false, message: '不支持' };
    const r = await autostart.uninstall();
    broadcast();
    return r;
  });
  ipcMain.handle('autostart:test', async () => {
    if (!autostart) return { ok: false, message: '不支持' };
    const r = await autostart.runOnce();
    return { ok: r.ok, message: r.summary || r.stderr || r.error || '已执行', raw: r.stdout ? r.stdout.slice(0, 2000) : '' };
  });
  ipcMain.handle('autostart:log', () => (autostart ? autostart.daemonLog(40) : []));

  /* ------------------------------------------------------------------ *
   * 计时器
   * ------------------------------------------------------------------ */
  ipcMain.handle('timer:state', () => timer.getState());
  ipcMain.handle('timer:start', (_e, opts) => { const s = timer.start(opts || {}); broadcast(); return s; });
  ipcMain.handle('timer:pause', () => { const s = timer.pause(); broadcast(); return s; });
  ipcMain.handle('timer:resume', () => { const s = timer.resume(); broadcast(); return s; });
  ipcMain.handle('timer:stop', () => { const r = timer.stop(); broadcast(); return r; });
  ipcMain.handle('timer:reset', () => { const s = timer.reset(); broadcast(); return s; });
  ipcMain.handle('timer:distraction', () => { const s = timer.markDistraction(); broadcast(); return s; });

  /* ------------------------------------------------------------------ *
   * 统计
   * ------------------------------------------------------------------ */
  ipcMain.handle('stats:overview', () => A.overview(store.read()));
  ipcMain.handle('stats:daily', (_e, days) => A.dailySeries(store.read(), Number(days) || 30));
  ipcMain.handle('stats:subjects', (_e, { from, to }) => A.subjectBreakdown(store.read(), from, to));
  ipcMain.handle('stats:heatmap', (_e, weeks) => A.heatmap(store.read(), Number(weeks) || 18));
  ipcMain.handle('stats:hourly', (_e, days) => A.hourlyDistribution(store.read(), Number(days) || 30));
  ipcMain.handle('stats:weekly-report', (_e, offset) => A.weeklyReport(store.read(), Number(offset) || 0));
  ipcMain.handle('stats:material-report', () => A.materialReport(store.read()));
  ipcMain.handle('stats:plan-report', () => A.planReport(store.read()));
  ipcMain.handle('stats:score', (_e, { from, to }) => A.focusScore(store.read(), from, to));

  /* ------------------------------------------------------------------ *
   * 设置
   * ------------------------------------------------------------------ */
  ipcMain.handle('settings:get', () => store.read().profile);
  ipcMain.handle('settings:update', (_e, patch) => {
    store.update((db) => {
      const p = db.profile;
      if (patch.pomodoro) Object.assign(p.pomodoro, patch.pomodoro);
      if (patch.notify) Object.assign(p.notify, patch.notify);
      const shallow = { ...patch };
      delete shallow.pomodoro;
      delete shallow.notify;
      Object.assign(p, shallow);
    }, { immediate: true });
    if (typeof patch.launchAtLogin === 'boolean') {
      try {
        app.setLoginItemSettings({
          openAtLogin: patch.launchAtLogin,
          openAsHidden: false,
          args: []
        });
      } catch (_) {}
    }
    broadcast();
    return store.read().profile;
  });

  /* ------------------------------------------------------------------ *
   * 通知
   * ------------------------------------------------------------------ */
  ipcMain.handle('notify:history', () => notifier.history);
  ipcMain.handle('notify:clear', () => { notifier.clear(); broadcast(); return true; });
  ipcMain.handle('notify:read', () => { notifier.markAllRead(); broadcast(); return true; });
  ipcMain.handle('notify:test', () => {
    notifier.send({
      kind: 'info',
      title: '通知通道正常',
      body: '看到这条就说明系统通知和窗口浮层都能用。',
      route: 'dashboard',
      force: true
    });
    return true;
  });

  /** 自检用：数一数界面上一共有几个状态标记（浮层、错误卡） */
  ipcMain.handle('debug:ui-counts', async () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (!w) return { error: 'no window' };
    return w.webContents.executeJavaScript(`
      ({
        toasts: document.querySelectorAll('#toasts .toast').length,
        errorCards: document.querySelectorAll('#view .card').length ? Array.from(document.querySelectorAll('#view .card')).filter(c => c.textContent.includes('这个页面出错了')).length : 0,
        navBadges: document.querySelectorAll('.nav-item .badge').length,
        revCards: document.querySelectorAll('.rev-card').length,
        svgNodes: document.querySelectorAll('#view svg').length
      })
    `);
  });
  /** 自检用：在界面上真的点开一次预览弹窗，验证渲染链路 */
  ipcMain.handle('debug:open-preview', async (_e, id) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (!w) return { ok: false };
    return w.webContents.executeJavaScript(`
      (async () => {
        try {
          const m = (await window.api.materials.list()).find(x => x.id === ${JSON.stringify(id)});
          if (!m) return { ok: false, reason: 'material not found' };
          const mo = await window.SH.app.previewById(${JSON.stringify(id)});
          await new Promise(r => setTimeout(r, 500));
          const dlg = document.querySelector('.dialog');
          return {
            ok: !!dlg,
            title: dlg ? dlg.querySelector('h3').textContent : '',
            hasMarkdown: !!document.querySelector('.dialog .md-body'),
            mdHeadings: document.querySelectorAll('.dialog .md-body h1, .dialog .md-body h2').length,
            mdCode: document.querySelectorAll('.dialog .md-body pre').length,
            toolbar: document.querySelectorAll('.dialog .pv-toolbar > *').length,
            buttons: document.querySelectorAll('.dialog .pv-foot button').length
          };
        } catch (e) { return { ok: false, reason: String(e && e.message || e) }; }
      })()
    `);
  });

  /* ------------------------------------------------------------------ *
   * 系统
   * ------------------------------------------------------------------ */
  ipcMain.handle('system:info', () => ({
    dataDir, vaultDir,
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    version: app.getVersion(),
    userData: app.getPath('userData'),
    home: app.getPath('home'),
    documents: (() => { try { return app.getPath('documents'); } catch (_) { return ''; } })(),
    desktop: (() => { try { return app.getPath('desktop'); } catch (_) { return ''; } })()
  }));
  ipcMain.handle('system:open-external', (_e, url) => {
    const u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u)) return { ok: false, message: '只允许打开 http/https 链接' };
    shell.openExternal(u);
    return { ok: true };
  });
  ipcMain.handle('system:open-path', async (_e, p) => {
    if (!p || !fs.existsSync(p)) return { ok: false, message: '路径不存在' };
    const err = await shell.openPath(p);
    return err ? { ok: false, message: err } : { ok: true };
  });

  ipcMain.handle('system:export-data', async () => {
    const win = focusedWin();
    const res = await dialog.showSaveDialog(win, {
      title: '导出学习数据',
      defaultPath: `study-hub-${U.dayKey()}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePath) return { ok: false };
    fs.writeFileSync(res.filePath, JSON.stringify(store.read(), null, 2), 'utf8');
    return { ok: true, path: res.filePath };
  });

  ipcMain.handle('system:import-data', async () => {
    const win = focusedWin();
    const res = await dialog.showOpenDialog(win, {
      title: '导入学习数据（会覆盖当前数据，先自动备份）',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePaths.length) return { ok: false };
    try {
      const parsed = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'));
      if (!parsed || !Array.isArray(parsed.sessions)) throw new Error('文件结构不对，缺少 sessions 数组');
      store.flush();
      fs.copyFileSync(store.file, path.join(store.backupDir, `pre-import-${Date.now()}.json`));
      const { migrate } = require('./store');
      const next = migrate(parsed);
      store.update((db) => { Object.assign(db, next); }, { immediate: true });
      broadcast();
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });

  ipcMain.handle('system:clear-demo', () => {
    store.update((db) => {
      /* 全清，不只是清示例数据。
         早先这里写成 `db.sessions.filter(s => !s.seed)` —— 于是「清空」会删掉
         用户的全部科目/资料/计划，却**保留**用户自己产生的学习记录，
         结果是一堆 subjectId 指向已删科目的孤儿记录（时长还在，但哪一科都归不上）。
         要么全清、要么只清示例，两者混着来是最糟的组合。 */
      db.subjects = [];
      db.materials = [];
      db.plans = [];
      db.sessions = [];
      db.reminders = [];
      db.reviews = [];
      db.meta.demo = false;
      db.meta.daemonSeq = 0;
      // 调度器的「今天已触发」也要重置，否则清空后当天的提醒不会再响
      db.scheduler = { lastFired: {}, overrunAt: 0, breakOverrunAt: 0, breakOverrunStage: 0 };
    }, { immediate: true });
    broadcast();
    return true;
  });

  ipcMain.handle('system:reset-all', () => {
    store.flush();
    fs.copyFileSync(store.file, path.join(store.backupDir, `pre-reset-${Date.now()}.json`));
    const { defaultDB } = require('./store');
    store.update((db) => { Object.assign(db, defaultDB()); }, { immediate: true });
    broadcast();
    return true;
  });

  ipcMain.handle('system:backup-list', () => {
    try {
      return fs.readdirSync(store.backupDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .reverse()
        .map((f) => {
          const st = fs.statSync(path.join(store.backupDir, f));
          return { name: f, size: st.size, mtime: st.mtime.toISOString() };
        });
    } catch (_) { return []; }
  });

  ipcMain.handle('system:restore-backup', (_e, name) => {
    try {
      const safe = path.basename(String(name || ''));
      const full = path.join(store.backupDir, safe);
      if (!fs.existsSync(full)) return { ok: false, message: '备份文件不存在' };
      store.flush();
      fs.copyFileSync(store.file, path.join(store.backupDir, `pre-restore-${Date.now()}.json`));
      const { migrate } = require('./store');
      const next = migrate(JSON.parse(fs.readFileSync(full, 'utf8')));
      store.update((db) => { Object.assign(db, next); }, { immediate: true });
      broadcast();
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });

  /* ------------------------------------------------------------------ *
   * 窗口
   * ------------------------------------------------------------------ */
  const win0 = () => BrowserWindow.getAllWindows()[0];
  ipcMain.handle('win:hide', () => { const w = win0(); if (w) w.hide(); return true; });
  ipcMain.handle('win:minimize', () => { const w = win0(); if (w) w.minimize(); return true; });
  ipcMain.handle('win:maximize-toggle', () => {
    const w = win0(); if (!w) return false;
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
    return w.isMaximized();
  });
  ipcMain.handle('win:close', () => { const w = win0(); if (w) w.close(); return true; });

  return { snapshot, broadcast };
}

module.exports = { register };
