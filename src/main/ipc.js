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

const A = require('./analytics');
const U = require('./util');
const M = require('./materials');
const P = require('./preview');
const C = require('./curriculum');
const { uid, nowISO, migrate, defaultLib } = require('./store');

/**
 * 生成全部 IPC handler。
 *
 * `host` 是「平台适配器」——所有依赖操作系统能力的操作都从它走：
 *   Electron 端：原生对话框、shell、BrowserWindow、app.getVersion
 *   浏览器端：文件下载/上传、window.open、无窗口概念的空实现
 *
 * 好处是**业务逻辑只有一份**。如果给网页版另写一套 handler，
 * 两边会立刻开始漂移 —— 「改了桌面版忘了同步网页版」是最难发现的 bug，
 * 因为两条路径都能跑，只是行为不一样。
 *
 * @param {object} ctx   store / timer / notifier / scheduler / autostart / dataDir / vaultDir
 * @param {object} host  平台适配器（src/main/host-electron.js 与 web/host-browser.js）
 * @returns {Record<string, Function>} 通道名 → 处理函数
 */
function createHandlers(ctx, host) {
  const { store, timer, notifier, scheduler, autostart, dataDir, vaultDir } = ctx;
  const H = {};

  const snapshot = () => ({
    db: store.read(),
    overview: A.overview(store.read()),
    timer: timer.getState(),
    unread: notifier.unreadCount(),
    review: A.reviewStats(store.read(), 14),
    dataDir,
    platform: host.platform,
    version: host.version,
    /** 前端据此决定要不要显示只有桌面版才有的入口（如「导入本地文件」） */
    capabilities: host.capabilities,
    demo: !!store.read().meta.demo,
    lastError: store._lastError || null,

    /* ---- 多租户（学科空间） ----
       快照里带全量空间列表，前端切换器与「学科空间」页都从这里取，
       不需要额外的往返。每个空间的统计量都很小（几个整数）。 */
    activeTenant: store.activeTenant(),
    activeTenantId: store.activeTenantId(),
    tenantCount: store.tenantCount(),
    tenants: store.listTenants(),
    tenantStats: store.listTenants().reduce((m, t) => { m[t.id] = store.tenantOverview(t.id); return m; }, {})
  });

  const broadcast = () => host.send('app:data', snapshot());
  ctx.broadcast = broadcast;
  ctx.snapshot = snapshot;

  /* ------------------------------------------------------------------ *
   * 应用
   * ------------------------------------------------------------------ */
  H['app:snapshot'] = () => snapshot();

  /* ------------------------------------------------------------------ *
   * 学科空间（多租户）
   *
   * 每个空间是一个**独立的学习库**（见 store.js 里那段说明）。这里的 handler
   * 只负责空间的增删改查与切换，不碰空间内部的业务数据 —— 那些通道
   * （subjects:* / plans:* / …）的作用域永远是「当前空间」，一行都不用改，
   * 也就没有「忘了加过滤」这种可能。
   * ------------------------------------------------------------------ */

  const tenantList = () => store.listTenants().map((t) => Object.assign({}, t, {
    active: t.id === store.activeTenantId(),
    stats: store.tenantOverview(t.id)
  }));

  H['tenants:list'] = () => tenantList();

  /** 模板目录：15 个跨学科领域 × 本科 / 研究生 */
  H['tenants:templates'] = () => C.listTemplates();

  H['tenants:create'] = (data) => {
    const d = data || {};
    const name = String(d.name || '').trim();
    if (!name) return { ok: false, message: '给这个空间起个名字' };
    const t = store.addTenant({
      name,
      field: d.field,
      level: d.level,
      kind: d.kind || 'custom',
      parents: d.parents,
      blurb: d.blurb,
      color: d.color
    });
    // 建完直接切过去：留在原来的空间会让人以为没建成功
    store.switchTenant(t.id);
    broadcast();
    return { ok: true, tenant: t, tenants: tenantList() };
  };

  H['tenants:from-template'] = (data) => {
    const d = data || {};
    let made;
    try {
      made = C.instantiate(d.templateId, d.level);
    } catch (err) {
      return { ok: false, message: err.message };
    }
    const t = store.addTenant(made.meta, made.lib);
    store.switchTenant(t.id);
    broadcast();
    return {
      ok: true,
      tenant: t,
      created: {
        subjects: made.lib.subjects.length,
        materials: made.lib.materials.length,
        plans: made.lib.plans.length,
        tasks: made.lib.plans.reduce((a, pl) => a + pl.tasks.length, 0),
        reviews: made.lib.reviews.length
      }
    };
  };

  H['tenants:update'] = ({ id, patch }) => {
    const t = store.updateTenant(id, patch);
    if (!t) return { ok: false, message: '这个学科空间不存在' };
    broadcast();
    return { ok: true, tenant: t };
  };

  H['tenants:remove'] = (id) => {
    const r = store.removeTenant(id);
    broadcast();
    return r;
  };

  H['tenants:switch'] = (id) => {
    if (id === store.activeTenantId()) return { ok: true, already: true };
    /* 🔴 专注进行中禁止切换。
       计时器状态在内存里，而专注记录会写进**当前**空间 ——
       这时候切走，这一段的时长与科目就会记到另一个学科名下，而且很难发现。 */
    const st = timer.getState();
    if (st && st.running) return { ok: false, message: '专注正在进行，先结束这一段再切换空间' };
    const r = store.switchTenant(id);
    if (r.ok) broadcast();
    return r;
  };

  /**
   * 跨空间对比：把每个空间放到同一把尺子上量。
   *
   * 用 withTenant 逐个进入再取统计 —— 这样每个空间的数字都是用它自己的
   * 数据算出来的，不需要在 analytics 里加租户参数。
   */
  H['tenants:compare'] = () => store.listTenants().map((t) => {
    const live = store.withTenant(t.id, () => {
      const lib = store.read();
      const days = A.dailySeries(lib, 7);
      const ov = A.overview(lib);
      return {
        last7: days.reduce((a, d) => a + (d.minutes || 0), 0),
        todayMin: ov.todayMinutes || 0,
        goal: lib.profile.dailyGoalMin || 120,
        streak: (ov.streak && ov.streak.current) || 0,
        score: (ov.score && ov.score.score) || 0
      };
    });
    const st = store.tenantOverview(t.id) || {};
    return Object.assign({
      id: t.id,
      name: t.name,
      field: t.field,
      level: t.level,
      color: t.color,
      parents: t.parents,
      active: t.id === store.activeTenantId()
    }, st, live);
  });

  /* ------------------------------------------------------------------ *
   * 科目
   * ------------------------------------------------------------------ */
  H['subjects:list'] = () => store.list('subjects');
  H['subjects:add'] = (data) => {
    const row = store.insert('subjects', {
      name: String(data.name || '').trim() || '未命名科目',
      color: data.color || '#2563eb',
      goalMinPerWeek: Number(data.goalMinPerWeek) || 0
    });
    broadcast();
    return row;
  };
  H['subjects:update'] = ({ id, patch }) => {
    const r = store.patch('subjects', id, patch);
    broadcast();
    return r;
  };
  H['subjects:remove'] = (id) => {
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
  };

  /* ------------------------------------------------------------------ *
   * 资料
   * ------------------------------------------------------------------ */
  H['materials:list'] = () => store.list('materials');
  H['materials:add'] = (data) => {
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
  };
  H['materials:update'] = ({ id, patch }) => {
    const r = store.patch('materials', id, patch);
    broadcast();
    return r;
  };
  H['materials:remove'] = (id) => {
    store.remove('materials', id);
    broadcast();
    return true;
  };
  H['materials:open'] = async (id) => {
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
  };
  H['materials:log-open'] = (id) => {
    const m = store.find('materials', id);
    if (!m) return false;
    store.patch('materials', id, {
      openCount: (m.openCount || 0) + 1,
      lastOpenedAt: nowISO()
    });
    broadcast();
    return true;
  };
  H['materials:reveal'] = (id) => {
    const m = store.find('materials', id);
    return m ? M.revealInFolder(m.path) : { ok: false, message: '资料不存在' };
  };

  H['materials:pick-files'] = async () => {
    if (!host.capabilities.nativeFilePicker) {
      return { unsupported: true, message: '网页版读不到你电脑上的文件（浏览器不允许）。可以改用「写笔记」或「添加链接」。' };
    }
    const res = await host.showOpenDialog({
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
  };

  H['materials:pick-folder'] = async () => {
    if (!host.capabilities.nativeFilePicker) {
      return { unsupported: true, message: '网页版读不到你电脑上的文件夹。' };
    }
    const res = await host.showOpenDialog({
      title: '选择要扫描的文件夹',
      properties: ['openDirectory']
    });
    if (res.canceled || !res.filePaths.length) return null;
    const dir = res.filePaths[0];
    return { dir, name: path.basename(dir), files: M.scanFolder(dir) };
  };

  H['materials:scan-folder'] = ({ dir }) => M.scanFolder(dir);

  /* ------------------------------------------------------------------ *
   * 计划
   * ------------------------------------------------------------------ */
  H['plans:list'] = () => store.list('plans');
  H['plans:add'] = (data) => {
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
  };
  H['plans:update'] = ({ id, patch }) => {
    const r = store.patch('plans', id, patch);
    broadcast();
    return r;
  };
  H['plans:remove'] = (id) => {
    store.remove('plans', id);
    broadcast();
    return true;
  };

  const withPlan = (planId, fn) => store.update((db) => {
    const plan = db.plans.find((p) => p.id === planId);
    if (!plan) return null;
    plan.updatedAt = nowISO();
    return fn(plan, db);
  }, { immediate: true });

  H['plans:add-task'] = ({ planId, data }) => {
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
  };
  H['plans:update-task'] = ({ planId, taskId, patch }) => {
    const t = withPlan(planId, (plan) => {
      const task = plan.tasks.find((x) => x.id === taskId);
      if (task) Object.assign(task, patch);
      return task || null;
    });
    broadcast();
    return t;
  };
  H['plans:remove-task'] = ({ planId, taskId }) => {
    withPlan(planId, (plan) => { plan.tasks = plan.tasks.filter((x) => x.id !== taskId); });
    broadcast();
    return true;
  };
  H['plans:toggle-task'] = ({ planId, taskId, dateKey }) => {
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
  };
  H['plans:add-milestone'] = ({ planId, data }) => {
    const m = withPlan(planId, (plan) => {
      plan.milestones = plan.milestones || [];
      const ms = { id: uid('ms_'), title: String(data.title || '').trim() || '阶段目标', due: data.due || '', done: false };
      plan.milestones.push(ms);
      return ms;
    });
    broadcast();
    return m;
  };
  H['plans:toggle-milestone'] = ({ planId, msId }) => {
    const m = withPlan(planId, (plan) => {
      const ms = (plan.milestones || []).find((x) => x.id === msId);
      if (ms) ms.done = !ms.done;
      return ms || null;
    });
    broadcast();
    return m;
  };
  H['plans:remove-milestone'] = ({ planId, msId }) => {
    withPlan(planId, (plan) => { plan.milestones = (plan.milestones || []).filter((x) => x.id !== msId); });
    broadcast();
    return true;
  };
  H['plans:today'] = (dateKey) => {
    const key = dateKey || U.dayKey();
    return A.tasksOn(store.read(), key).map((r) => ({
      taskId: r.task.id, planId: r.plan.id, plan: r.plan.title, planSubject: r.plan.subjectId,
      title: r.task.title, estMin: r.task.estMin, repeat: r.task.repeat, done: r.done,
      materialId: r.task.materialId || ''
    }));
  };

  /* ------------------------------------------------------------------ *
   * 学习记录
   * ------------------------------------------------------------------ */
  H['sessions:list'] = (range) => {
    const all = store.list('sessions');
    if (!range || (!range.from && !range.to)) return all;
    const from = range.from || '0000-01-01';
    const to = range.to || '9999-12-31';
    return all.filter((s) => {
      const k = U.dayKey(new Date(s.start));
      return k >= from && k <= to;
    });
  };
  H['sessions:add'] = (data) => {
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
  };
  H['sessions:update'] = ({ id, patch }) => {
    const r = store.patch('sessions', id, patch);
    broadcast();
    return r;
  };
  H['sessions:remove'] = (id) => {
    store.remove('sessions', id);
    broadcast();
    return true;
  };

  /* ------------------------------------------------------------------ *
   * 提醒
   * ------------------------------------------------------------------ */
  H['reminders:list'] = () => store.list('reminders');
  H['reminders:add'] = (data) => {
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
  };
  H['reminders:update'] = ({ id, patch }) => {
    const r = store.patch('reminders', id, patch);
    broadcast();
    return r;
  };
  H['reminders:remove'] = (id) => {
    store.remove('reminders', id);
    broadcast();
    return true;
  };

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

  H['reviews:list'] = () => store.list('reviews');
  H['reviews:queue'] = (key) => {
    const q = A.reviewQueue(store.read(), key || U.dayKey());
    const brief = (r) => ({
      id: r.id, title: r.title, subjectId: r.subjectId, materialId: r.materialId, note: r.note,
      stage: r.stage, lapses: r.lapses, nextAt: r.nextAt, lastAt: r.lastAt,
      attempts: (r.history || []).length, learnedAt: r.learnedAt
    });
    return { due: q.due.map(brief), overdue: q.overdue.map(brief), upcoming: q.upcoming.slice(0, 40).map(brief), total: q.total };
  };
  H['reviews:stats'] = (horizon) => A.reviewStats(store.read(), Number(horizon) || 14);
  H['reviews:curve'] = (stages) => A.retentionCurve(Number(stages) || 7, 30);
  H['reviews:add'] = (data) => addReview(data || {});
  H['reviews:update'] = ({ id, patch }) => {
    const p = { ...patch };
    // 改「首次学习日」要连带把下一次复习日重排，否则会留下一个未来的空档
    if (p.learnedAt && !p.nextAt) {
      const r = store.find('reviews', id);
      if (r && (r.history || []).length === 0) p.nextAt = A.nextReviewAt(0, p.learnedAt);
    }
    const row = store.patch('reviews', id, p);
    broadcast();
    return row;
  };
  H['reviews:remove'] = (id) => {
    store.remove('reviews', id);
    broadcast();
    return true;
  };

  /** 评分：good / fuzzy / forgot —— 间隔重复的核心动作 */
  H['reviews:grade'] = ({ id, result, dateKey }) => {
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
  };
  H['reviews:add-from-material'] = (materialId) => {
    const m = store.find('materials', materialId);
    if (!m) return { ok: false, message: '资料不存在' };
    const exists = store.list('reviews').find((r) => r.materialId === materialId && !r.archived && !r.mastered);
    if (exists) return { ok: true, row: exists, already: true };
    return { ok: true, row: addReview({ title: m.title, subjectId: m.subjectId, materialId, note: m.note || '' }) };
  };
  H['reviews:reset'] = (id) => {
    const row = store.update((db) => {
      const r = db.reviews.find((x) => x.id === id);
      if (!r) return null;
      r.stage = 0; r.lapses = 0; r.mastered = false; r.nextAt = A.nextReviewAt(0, U.dayKey());
      r.lastAt = U.dayKey();
      return r;
    }, { immediate: true });
    broadcast();
    return row;
  };

  /* ------------------------------------------------------------------ *
   * 资料预览
   * ------------------------------------------------------------------ */
  H['preview:probe'] = (id) => {
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
  };

  H['preview:read'] = ({ id, mode }) => {
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
  };

  /** 内联预览 -> 打开（PDF 走独立窗口，其他走系统默认程序） */
  H['preview:open-native'] = async (id) => {
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
  };

  /* ------------------------------------------------------------------ *
   * 后台提醒守护
   * ------------------------------------------------------------------ */
  H['autostart:detect'] = async () => {
    if (!autostart) return { supported: false };
    const info = await autostart.detect();
    return { ...info, recentLog: autostart.daemonLog(10) };
  };
  H['autostart:install'] = async () => {
    if (!autostart) return { ok: false, message: '不支持' };
    const r = await autostart.install();
    broadcast();
    return r;
  };
  H['autostart:uninstall'] = async () => {
    if (!autostart) return { ok: false, message: '不支持' };
    const r = await autostart.uninstall();
    broadcast();
    return r;
  };
  H['autostart:test'] = async () => {
    if (!autostart) return { ok: false, message: '不支持' };
    const r = await autostart.runOnce();
    return { ok: r.ok, message: r.summary || r.stderr || r.error || '已执行', raw: r.stdout ? r.stdout.slice(0, 2000) : '' };
  };
  H['autostart:log'] = () => (autostart ? autostart.daemonLog(40) : []);

  /* ------------------------------------------------------------------ *
   * 计时器
   * ------------------------------------------------------------------ */
  H['timer:state'] = () => timer.getState();
  H['timer:start'] = (opts) => { const s = timer.start(opts || {}); broadcast(); return s; };
  H['timer:pause'] = () => { const s = timer.pause(); broadcast(); return s; };
  H['timer:resume'] = () => { const s = timer.resume(); broadcast(); return s; };
  H['timer:stop'] = () => { const r = timer.stop(); broadcast(); return r; };
  H['timer:reset'] = () => { const s = timer.reset(); broadcast(); return s; };
  H['timer:distraction'] = () => { const s = timer.markDistraction(); broadcast(); return s; };

  /* ------------------------------------------------------------------ *
   * 统计
   * ------------------------------------------------------------------ */
  H['stats:overview'] = () => A.overview(store.read());
  H['stats:daily'] = (days) => A.dailySeries(store.read(), Number(days) || 30);
  H['stats:subjects'] = ({ from, to }) => A.subjectBreakdown(store.read(), from, to);
  H['stats:heatmap'] = (weeks) => A.heatmap(store.read(), Number(weeks) || 18);
  H['stats:hourly'] = (days) => A.hourlyDistribution(store.read(), Number(days) || 30);
  H['stats:weekly-report'] = (offset) => A.weeklyReport(store.read(), Number(offset) || 0);
  H['stats:material-report'] = () => A.materialReport(store.read());
  H['stats:plan-report'] = () => A.planReport(store.read());
  H['stats:score'] = ({ from, to }) => A.focusScore(store.read(), from, to);

  /* ------------------------------------------------------------------ *
   * 设置
   * ------------------------------------------------------------------ */
  H['settings:get'] = () => store.read().profile;
  H['settings:update'] = (patch) => {
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
  };

  /* ------------------------------------------------------------------ *
   * 通知
   * ------------------------------------------------------------------ */
  H['notify:history'] = () => notifier.history;
  H['notify:clear'] = () => { notifier.clear(); broadcast(); return true; };
  H['notify:read'] = () => { notifier.markAllRead(); broadcast(); return true; };
  H['notify:test'] = () => {
    notifier.send({
      kind: 'info',
      title: '通知通道正常',
      body: '看到这条就说明系统通知和窗口浮层都能用。',
      route: 'dashboard',
      force: true
    });
    return true;
  };

  /** 自检用：数一数界面上一共有几个状态标记（浮层、错误卡） */
  H['debug:ui-counts'] = async () => {
    if (!host.evalInPage) return { error: 'host 不支持 evalInPage' };
    return host.evalInPage(`
      ({
        toasts: document.querySelectorAll('#toasts .toast').length,
        errorCards: document.querySelectorAll('#view .card').length ? Array.from(document.querySelectorAll('#view .card')).filter(c => c.textContent.includes('这个页面出错了')).length : 0,
        navBadges: document.querySelectorAll('.nav-item .badge').length,
        revCards: document.querySelectorAll('.rev-card').length,
        svgNodes: document.querySelectorAll('#view svg').length
      })
    `);
  };
  /** 自检用：在界面上真的点开一次预览弹窗，验证渲染链路 */
  H['debug:open-preview'] = async (id) => {
    if (!host.evalInPage) return { ok: false, reason: 'host 不支持 evalInPage' };
    return host.evalInPage(`
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
  };

  /* ------------------------------------------------------------------ *
   * 系统
   * ------------------------------------------------------------------ */
  H['system:info'] = () => ({
    dataDir, vaultDir,
    platform: host.platform,
    arch: host.arch,
    electron: host.build.electron,
    node: host.build.node,
    chrome: host.build.chrome,
    version: host.version,
    userData: host.paths.userData,
    home: host.paths.home,
    documents: host.paths.documents || '',
    desktop: host.paths.desktop || '',
    runtime: host.runtimeName
  });
  H['system:open-external'] = (url) => {
    const u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u)) return { ok: false, message: '只允许打开 http/https 链接' };
    return host.openExternal(u);
  };
  H['system:open-path'] = async (p) => {
    if (!host.capabilities.openLocalPath) return { ok: false, message: '网页版打不开本机路径。' };
    if (!p || !fs.existsSync(p)) return { ok: false, message: '路径不存在' };
    return host.openPath(p);
  };

  H['system:export-data'] = async () => {
    // 语义化调用：桌面版弹保存框写文件，网页版触发浏览器下载。
    // 刻意不暴露「保存对话框」这种平台概念 —— 否则网页端只能假装实现。
    const t = store.activeTenant();
    const safe = String(t ? t.name : '学习中心').replace(/[\\/:*?"<>|]/g, '_').slice(0, 24);
    return host.saveText({
      title: '导出当前学科空间的数据',
      fileName: `study-hub-${safe}-${U.dayKey()}.json`,
      text: JSON.stringify(store.read(), null, 2)
    });
  };

  H['system:import-data'] = async () => {
    const picked = await host.pickTextFile({
      title: '导入学习数据（会覆盖当前数据，先自动备份）',
      extensions: ['json']
    });
    if (!picked || picked.canceled) return { ok: false };
    try {
      const parsed = JSON.parse(picked.text);
      store.flush();
      fs.copyFileSync(store.file, path.join(store.backupDir, `pre-import-${Date.now()}.json`));

      // 整库文件（含全部学科空间）：整体替换
      if (parsed && parsed.libs && typeof parsed.libs === 'object') {
        store.replaceRaw(parsed);
        broadcast();
        return { ok: true, scope: 'all' };
      }

      // 单空间文件：只替换当前空间的内容，其它空间不受影响
      if (!parsed || !Array.isArray(parsed.sessions)) throw new Error('文件结构不对，缺少 sessions 数组');
      const next = migrate(parsed);
      /* 原地改（逐键删除再赋值），不能 `db = next` ——
         store.db 与 raw.libs[active] 是同一个引用，整个替换会让它指向一个
         不再被保存的对象：界面看着有数据，重启就没了。 */
      store.update((db) => {
        for (const k of Object.keys(db)) delete db[k];
        Object.assign(db, next);
      }, { immediate: true });
      broadcast();
      return { ok: true, scope: 'one', space: (store.activeTenant() || {}).name };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  };

  H['system:clear-demo'] = () => {
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
  };

  H['system:reset-all'] = () => {
    store.flush();
    fs.copyFileSync(store.file, path.join(store.backupDir, `pre-reset-${Date.now()}.json`));
    const fresh = defaultLib();
    /* 只重置**当前学科空间**，其它空间原样保留。
       同样必须原地改：换对象会让 this.db 脱钩（见上面 import 的说明）。 */
    store.update((db) => {
      for (const k of Object.keys(db)) delete db[k];
      Object.assign(db, fresh);
    }, { immediate: true });
    broadcast();
    return true;
  };

  H['system:backup-list'] = () => {
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
  };

  H['system:restore-backup'] = (name) => {
    try {
      const safe = path.basename(String(name || ''));
      const full = path.join(store.backupDir, safe);
      if (!fs.existsSync(full)) return { ok: false, message: '备份文件不存在' };
      store.flush();
      fs.copyFileSync(store.file, path.join(store.backupDir, `pre-restore-${Date.now()}.json`));
      /* 备份里是**整份文件**（含全部学科空间）；v4 时代的老备份是单库，
         replaceRaw 会把它迁移成「一个空间」再装回去。 */
      store.replaceRaw(JSON.parse(fs.readFileSync(full, 'utf8')));
      broadcast();
      return { ok: true, spaces: store.tenantCount() };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  };

  /* ------------------------------------------------------------------ *
   * 窗口
   * ------------------------------------------------------------------ */
  /* 窗口控制：桌面版真的操作 BrowserWindow；网页版没有窗口概念，
     host.window.* 返回中性值（不抛异常），前端不会因此崩 */
  H['win:hide'] = () => host.window.hide();
  H['win:minimize'] = () => host.window.minimize();
  H['win:maximize-toggle'] = () => host.window.maximizeToggle();
  H['win:close'] = () => host.window.close();

  return H;
}

module.exports = { createHandlers };
