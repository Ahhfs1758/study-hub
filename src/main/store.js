'use strict';
/**
 * store.js —— 数据持久化层
 *
 * 设计要点：
 *  1. 单文件 JSON + 原子写（写 .tmp 再 rename），避免崩溃时半截文件把整个库写坏。
 *  2. 写入去抖（默认 400ms），高频操作（每秒推送计时、批量打卡）不会打爆磁盘。
 *  3. 每次落盘前滚动备份，保留最近 N 份，误删可回滚。
 *  4. 所有集合的读写都经这里，主进程其它模块不直接碰文件系统。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dayKey, addDays, parseDayKey } = require('./util');

const SCHEMA_VERSION = 4;
const MAX_BACKUPS = 14;

function uid(prefix = '') {
  return prefix + crypto.randomBytes(6).toString('hex');
}

function nowISO() {
  return new Date().toISOString();
}

/* ------------------------------------------------------------------ *
 * 默认值
 * ------------------------------------------------------------------ */

function defaultProfile() {
  return {
    name: '',
    dailyGoalMin: 120,
    weeklyGoalMin: 720,
    weekStart: 1, // 0=周日 1=周一
    pomodoro: {
      focus: 25,
      short: 5,
      long: 20,
      roundsBeforeLong: 4,
      autoStartBreak: true,
      autoStartFocus: false
    },
    notify: {
      enabled: true,
      sound: true,
      taskReminder: true,
      taskReminderTime: '20:00',
      dailyDigest: true,
      dailyDigestTime: '21:30',
      idleMaterialDays: 30,
      overrunMin: 90,
      breakOverrunMin: 10
    },
    launchAtLogin: false,
    minimizeToTray: true,
    confirmQuit: true,
    /** 勾掉计划任务时自动把它排进复习队列 */
    reviewAutoAdd: true
  };
}

function defaultDB() {
  return {
    version: SCHEMA_VERSION,
    createdAt: nowISO(),
    profile: defaultProfile(),
    subjects: [],
    materials: [],
    plans: [],
    sessions: [],
    reminders: [],
    reviews: [],
    timer: null,
    scheduler: { lastFired: {}, overrunAt: 0, breakOverrunAt: 0, breakOverrunStage: 0 },
    meta: { demo: false, lastOpenAt: null, openCount: 0, lastBackupAt: null, daemonSeq: 0 }
  };
}

/* ------------------------------------------------------------------ *
 * 迁移
 * ------------------------------------------------------------------ */

/** 把任意版本的旧库补齐成当前结构。只做结构性补齐，不猜业务数据。 */
function migrate(db) {
  const fresh = defaultDB();
  const out = Object.assign({}, fresh, db);

  // profile：逐层合并，保证新增开关项有默认值
  out.profile = Object.assign({}, fresh.profile, db.profile || {});
  out.profile.pomodoro = Object.assign({}, fresh.profile.pomodoro, (db.profile || {}).pomodoro || {});
  out.profile.notify = Object.assign({}, fresh.profile.notify, (db.profile || {}).notify || {});
  out.meta = Object.assign({}, fresh.meta, db.meta || {});
  out.scheduler = Object.assign({}, fresh.scheduler, db.scheduler || {});
  if (!out.scheduler.lastFired || typeof out.scheduler.lastFired !== 'object') out.scheduler.lastFired = {};

  for (const k of ['subjects', 'materials', 'plans', 'sessions', 'reminders', 'reviews']) {
    if (!Array.isArray(out[k])) out[k] = [];
  }

  // v1/v2 → v3：materials 增加 doneUnits / totalUnits，plans 任务统一 doneDates 数组
  out.materials = out.materials.map((m) => ({
    doneUnits: 0,
    totalUnits: 0,
    openCount: 0,
    timeSpentMin: 0,
    status: 'todo',
    progress: 0,
    tags: [],
    ...m
  }));

  out.plans = out.plans.map((p) => ({
    status: 'active',
    priority: 2,
    milestones: [],
    ...p,
    tasks: (p.tasks || []).map((t) => ({
      estMin: 30,
      repeat: 'none',
      weekdays: [],
      doneDates: [],
      done: false,
      ...t,
      doneDates: Array.isArray(t.doneDates) ? t.doneDates : []
    }))
  }));

  out.sessions = out.sessions.map((s) => ({
    mode: 'pomodoro',
    interruptions: 0,
    focusScore: null,
    ...s
  }));

  // v2/v3 → v4：新增复习（间隔重复）集合
  out.reviews = out.reviews.map((r) => ({
    stage: 0,
    lapses: 0,
    mastered: false,
    archived: false,
    note: '',
    materialId: '',
    history: [],
    ...r,
    history: Array.isArray(r.history) ? r.history : [],
    lastAt: r.lastAt || r.learnedAt || null
  }));

  out.version = SCHEMA_VERSION;
  return out;
}

/* ------------------------------------------------------------------ *
 * Store
 * ------------------------------------------------------------------ */

class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'study-hub.json');
    this.backupDir = path.join(dataDir, 'backups');
    this.db = defaultDB();
    this._timer = null;
    this._dirty = false;
    this._lastError = null;
  }

  init() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.backupDir, { recursive: true });
    if (fs.existsSync(this.file)) {
      try {
        const raw = fs.readFileSync(this.file, 'utf8');
        const parsed = JSON.parse(raw);
        this.db = migrate(parsed);
      } catch (err) {
        // 主文件读不出来：先把它挪到一边留证，再尝试最近一份备份
        this._lastError = `主数据文件损坏（${err.message}），已隔离并尝试从备份恢复`;
        const broken = this.file + '.broken-' + Date.now();
        try { fs.renameSync(this.file, broken); } catch (_) {}
        this.db = this._restoreLatestBackup() || defaultDB();
        this.save(true);
      }
    } else {
      this.db = defaultDB();
      this.save(true);
    }

    this.db.meta.openCount = (this.db.meta.openCount || 0) + 1;
    this.db.meta.lastOpenAt = nowISO();
    this._rollBackupIfNeeded();
    this.save(true);
    return this.db;
  }

  _restoreLatestBackup() {
    try {
      const files = fs.readdirSync(this.backupDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .reverse();
      for (const f of files) {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(this.backupDir, f), 'utf8'));
          if (parsed && Array.isArray(parsed.sessions)) return migrate(parsed);
        } catch (_) { /* 试下一份 */ }
      }
    } catch (_) {}
    return null;
  }

  _rollBackupIfNeeded() {
    const today = dayKey();          // 本地时区，不能用 toISOString（UTC 下凌晨会归到前一天）
    const target = path.join(this.backupDir, `study-hub-${today}.json`);
    if (fs.existsSync(target)) return;
    try {
      fs.writeFileSync(target, JSON.stringify(this.db, null, 2), 'utf8');
      this.db.meta.lastBackupAt = nowISO();
      const all = fs.readdirSync(this.backupDir).filter((f) => f.endsWith('.json')).sort();
      while (all.length > MAX_BACKUPS) {
        fs.unlinkSync(path.join(this.backupDir, all.shift()));
      }
    } catch (_) {}
  }

  /** 只读快照（深拷贝，防止调用方改到内存里的真值） */
  read() {
    return this.db;
  }

  /** 变更：mutator 直接改 db，返回是否落盘 */
  update(mutator, { immediate = false } = {}) {
    const ret = mutator(this.db);
    this._dirty = true;
    if (immediate) this.save(true);
    else this._scheduleSave();
    return ret;
  }

  _scheduleSave() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.save();
    }, 400);
    if (this._timer.unref) this._timer.unref();
  }

  save(immediate = false) {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (!immediate && !this._dirty) return;
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2), 'utf8');
      fs.renameSync(tmp, this.file); // 原子替换
      this._dirty = false;
    } catch (err) {
      this._lastError = '写入失败：' + err.message;
    }
  }

  /** 关闭前调用，确保内存里的改动落盘 */
  flush() {
    this.save(true);
  }

  /* ---------------- 通用集合工具 ---------------- */

  list(coll) {
    return this.db[coll] || [];
  }

  find(coll, id) {
    return this.list(coll).find((x) => x.id === id) || null;
  }

  insert(coll, obj) {
    const row = Object.assign({ id: uid(), createdAt: nowISO(), updatedAt: nowISO() }, obj);
    this.update((db) => { db[coll].push(row); });
    return row;
  }

  patch(coll, id, patch) {
    return this.update((db) => {
      const row = db[coll].find((x) => x.id === id);
      if (!row) return null;
      Object.assign(row, patch, { updatedAt: nowISO() });
      return row;
    });
  }

  remove(coll, id) {
    return this.update((db) => {
      const i = db[coll].findIndex((x) => x.id === id);
      if (i < 0) return false;
      db[coll].splice(i, 1);
      return true;
    });
  }

  /** 全量替换某一集合 */
  replaceAll(coll, rows) {
    this.update((db) => { db[coll] = rows; }, { immediate: true });
    return rows;
  }
}

/* ------------------------------------------------------------------ *
 * 示例数据（首次启动用，设置页可一键清空）
 * ------------------------------------------------------------------ */

const SUBJECT_PALETTE = ['#2563eb', '#7c3aed', '#0d9488', '#d97706', '#dc2626', '#db2777', '#0891b2', '#65a30d'];

function seedDB(store) {
  const subjects = [
    { id: uid('sub_'), name: '高等数学', color: SUBJECT_PALETTE[0], goalMinPerWeek: 300, createdAt: nowISO() },
    { id: uid('sub_'), name: '英语', color: SUBJECT_PALETTE[1], goalMinPerWeek: 240, createdAt: nowISO() },
    { id: uid('sub_'), name: '数据结构', color: SUBJECT_PALETTE[2], goalMinPerWeek: 300, createdAt: nowISO() },
    { id: uid('sub_'), name: '专业课', color: SUBJECT_PALETTE[3], goalMinPerWeek: 180, createdAt: nowISO() }
  ];
  const [math, eng, ds, major] = subjects;

  const materials = [
    {
      id: uid('mat_'), subjectId: math.id, title: '《高等数学》同济第七版 · 上册',
      type: 'book', status: 'doing', progress: 45, totalUnits: 320, doneUnits: 144, unitLabel: '页',
      tags: ['教材', '必读'], note: '重点：极限、导数、中值定理。第 3 章需要二刷。',
      path: '', url: '', openCount: 6, timeSpentMin: 340, lastOpenedAt: nowISO()
    },
    {
      id: uid('mat_'), subjectId: ds.id, title: '数据结构与算法 · 学习笔记',
      type: 'note', status: 'doing', progress: 30, totalUnits: 20, doneUnits: 6, unitLabel: '章',
      tags: ['笔记'], note: '已整理：数组/链表/栈队列/哈希表。待整理：树、图、排序。',
      body: '## 已掌握\n- 数组与动态数组的均摊复杂度\n- 链表：单双链表、哨兵节点\n- 栈与队列：单调栈的应用场景\n\n## 存疑\n- 红黑树旋转的四种情形容易记混\n- KMP 的 next 数组推导需要再推一遍\n', path: '', url: '',
      openCount: 12, timeSpentMin: 210, lastOpenedAt: nowISO()
    },
    {
      id: uid('mat_'), subjectId: eng.id, title: '考研英语真题（2015-2024）',
      type: 'doc', status: 'todo', progress: 10, totalUnits: 10, doneUnits: 1, unitLabel: '套',
      tags: ['真题', '刷题'], note: '每周一套，重点分析长难句。', path: '', url: '', openCount: 1, timeSpentMin: 45
    },
    {
      id: uid('mat_'), subjectId: major.id, title: '专业课网课 · 第 1 章 导论',
      type: 'video', url: 'https://www.bilibili.com/', status: 'todo', progress: 0,
      totalUnits: 12, doneUnits: 0, unitLabel: '讲', tags: ['网课'], note: '', path: '',
      openCount: 0, timeSpentMin: 0
    },
    {
      id: uid('mat_'), subjectId: ds.id, title: '算法可视化网站 VisuAlgo',
      type: 'link', url: 'https://visualgo.net/zh', status: 'doing', progress: 0,
      tags: ['工具'], note: '理解排序/图算法动效很有用。', path: '', openCount: 3, timeSpentMin: 30
    }
  ];

  const today = new Date();
  /** 相对今天的日期键。必须按本地时区算 —— 用 toISOString 会在 GMT+8 的凌晨把日期归到前一天，
   *  于是种子任务的起始日、打卡日、学习记录会互相错位一天（表现为「完成了却显示未完成」）。 */
  const dstr = (offset) => dayKey(addDays(today, offset));

  /** 从昨天往回找最近 n 个「符合条件」的日期键。
   *  种子数据的打卡日必须真实满足任务的重复规则，否则任务列表里会出现
   *  「周六的任务却在周日打过卡」这种一眼假的演示数据。 */
  const recentDays = (n, pred, maxBack = 90) => {
    const out = [];
    for (let i = 1; i <= maxBack && out.length < n; i++) {
      const d = addDays(today, -i);
      if (!pred || pred(d)) out.push(dayKey(d));
    }
    return out;
  };
  const isSat = (d) => d.getDay() === 6;

  const plan = {
    id: uid('plan_'),
    title: '示例 · 期末冲刺 21 天',
    subjectId: math.id,
    desc: '这是一份示例计划，用来演示「目标 → 阶段 → 每日任务」的拆解方式。可以在设置里一键清空示例数据。',
    startDate: dstr(-14),
    endDate: dstr(6),
    priority: 1,
    status: 'active',
    milestones: [
      { id: uid('ms_'), title: '完成高数上册第 4-6 章', due: dstr(-4), done: true },
      { id: uid('ms_'), title: '真题第一轮（近 5 年）', due: dstr(2), done: false },
      { id: uid('ms_'), title: '错题二刷 + 公式默写', due: dstr(6), done: false }
    ],
    tasks: [
      { id: uid('task_'), title: '页 145-170：不定积分练习', date: dstr(0), repeat: 'none', estMin: 60, done: false, doneDates: [], materialId: materials[0].id },
      // 重复任务从计划开始日算起；打卡日按 repeating 规则真实生成，而不是随手挑几天
      { id: uid('task_'), title: '背单词 100 个（含复习词）', date: dstr(-14), repeat: 'daily', weekdays: [], estMin: 30, done: false, doneDates: recentDays(5) },
      { id: uid('task_'), title: '整理红黑树笔记', date: dstr(0), repeat: 'none', estMin: 45, done: false, doneDates: [], materialId: materials[1].id },
      { id: uid('task_'), title: '英语真题一套（阅读限时）', date: dstr(-14), repeat: 'weekly', weekdays: [6], estMin: 90, done: false, doneDates: recentDays(2, isSat) }
    ],
    createdAt: nowISO(),
    updatedAt: nowISO()
  };

  // 近 21 天的学习记录：用确定性伪随机造出有起伏但整体向好的曲线
  const sessions = [];
  let seedN = 20261007;
  const rnd = () => { seedN = (seedN * 1103515245 + 12345) & 0x7fffffff; return seedN / 0x7fffffff; };
  for (let offset = -20; offset <= 0; offset++) {
    const d = new Date(today);
    d.setDate(d.getDate() + offset);
    const dow = d.getDay();
    const base = dow === 0 || dow === 6 ? 150 : 100;
    const drift = (offset + 20) * 5;                 // 越接近今天越用功
    const dayTotal = Math.max(0, Math.round(base + drift + (rnd() - 0.5) * 110));
    if (dayTotal < 15) continue;
    let left = dayTotal;
    const pool = subjects.slice();
    let i = 0;
    while (left > 15 && i < 4) {
      const sub = pool[Math.floor(rnd() * pool.length)];
      let mins = i === 0 ? Math.min(left, 50 + Math.round(rnd() * 40)) : Math.min(left, 25 + Math.round(rnd() * 30));
      mins = Math.max(20, Math.min(mins, 90));
      left -= mins;
      const st = new Date(d);
      st.setHours(9 + i * 2 + Math.floor(rnd() * 2), Math.floor(rnd() * 60), 0, 0);
      const en = new Date(st.getTime() + mins * 60000);
      sessions.push({
        id: uid('ses_'),
        subjectId: sub.id,
        materialId: null,
        planId: null,
        taskId: null,
        start: st.toISOString(),
        end: en.toISOString(),
        minutes: mins,
        mode: 'pomodoro',
        interruptions: Math.floor(rnd() * 2),
        focusScore: 70 + Math.floor(rnd() * 28),
        note: '',
        seed: true
      });
      i++;
    }
  }

  const reminders = [
    { id: uid('rem_'), title: '早读：背单词', time: '07:30', repeat: 'weekdays', weekdays: [1, 2, 3, 4, 5], date: '', type: 'study', subjectId: eng.id, enabled: true, lastFired: '' },
    { id: uid('rem_'), title: '晚间专注时段', time: '19:30', repeat: 'daily', weekdays: [], date: '', type: 'study', subjectId: ds.id, enabled: true, lastFired: '' },
    { id: uid('rem_'), title: '睡前一分钟复盘', time: '22:30', repeat: 'daily', weekdays: [], date: '', type: 'review', subjectId: '', enabled: true, lastFired: '' }
  ];

  /* 复习队列：造出「今天到期 / 已逾期 / 未到期 / 已掌握」四种状态，
     这样演示数据一打开就能看出间隔重复是怎么运转的。 */
  const IV = [1, 2, 4, 7, 15, 30, 60];

  /**
   * 从「下次复习日」往回推导整条历史。
   * 直接正着造很容易造出「逾期 12 天」这种一眼假的演示数据 —— 人手写的日期
   * 很少真的满足间隔规律，所以这里让日期由算法反推，只指定「当前第几轮」和「何时到期」。
   */
  const mkRev = (stage, nextAtKey, extra = {}) => {
    const hist = [];
    let cursor = nextAtKey;
    for (let s = stage; s >= 1; s--) {
      const reviewDate = dayKey(addDays(parseDayKey(cursor), -IV[Math.min(s, IV.length - 1)]));
      hist.unshift({ date: reviewDate, result: 'good' });
      cursor = reviewDate;
    }
    const learnedAt = dayKey(addDays(parseDayKey(cursor), -IV[0]));
    return {
      stage,
      mastered: false,
      lapses: 0,
      history: hist,
      learnedAt,
      lastAt: hist.length ? hist[hist.length - 1].date : learnedAt,
      nextAt: nextAtKey,
      ...extra
    };
  };

  /** 已掌握：7 轮全部走完，没有下次 */
  const mkMastered = (lastReviewKey) => {
    const hist = [];
    let cursor = lastReviewKey;
    for (let s = IV.length; s >= 1; s--) {
      hist.unshift({ date: cursor, result: 'good' });
      cursor = dayKey(addDays(parseDayKey(cursor), -IV[s - 1]));
    }
    return {
      stage: IV.length,
      mastered: true,
      lapses: 0,
      history: hist,
      learnedAt: cursor,
      lastAt: lastReviewKey,
      nextAt: null
    };
  };

  const reviews = [
    // 已掌握：走完 7 轮，前后横跨约 4 个月
    { id: uid('rev_'), title: '拉格朗日中值定理的三种情形', subjectId: math.id, materialId: materials[0].id, note: '关键是「闭区间连续、开区间可导」两个条件不能少。', ...mkMastered(dstr(-30)) },
    // 今天到期
    { id: uid('rev_'), title: '红黑树的插入修复（旋转变色）', subjectId: ds.id, materialId: materials[1].id, note: '记不住就看「新节点一定是红色」这一条往外推。', ...mkRev(2, dstr(0)) },
    // 逾期 2 天
    { id: uid('rev_'), title: 'KMP 的 next 数组推导', subjectId: ds.id, materialId: materials[1].id, note: '自己推一遍比背结论有用得多。', ...mkRev(1, dstr(-2)) },
    // 逾期 1 天
    { id: uid('rev_'), title: '单调栈的适用场景', subjectId: ds.id, materialId: '', note: '一句话：找「左右第一个比它大/小」的元素就用它。', ...mkRev(2, dstr(-1), { lapses: 1, history: [{ date: dstr(-9), result: 'forgot' }] }) },
    // 未到期
    { id: uid('rev_'), title: '不定积分常用换元法', subjectId: math.id, materialId: materials[0].id, note: '', ...mkRev(3, dstr(4)) },
    // 刚加入，明天第一次复习
    { id: uid('rev_'), title: '英语长难句：后置定语的识别', subjectId: eng.id, materialId: materials[2].id, note: '', ...mkRev(0, dstr(1)) },
    // 忘了回炉
    { id: uid('rev_'), title: '专业课：第三讲的三个核心假设', subjectId: major.id, materialId: '', note: '上次整段忘光了，这次拆成三条分开记。', stage: 0, lapses: 1, mastered: false, history: [{ date: dstr(-3), result: 'forgot' }], learnedAt: dstr(-12), lastAt: dstr(-3), nextAt: dstr(0) }
  ].map((r) => ({
    lapses: 0, mastered: false, archived: false, createdAt: nowISO(), updatedAt: nowISO(),
    learnedAt: r.learnedAt || dstr(-7),
    ...r
  }));

  store.update((db) => {
    db.subjects = subjects;
    db.materials = materials;
    db.plans = [plan];
    db.sessions = sessions;
    db.reminders = reminders;
    db.reviews = reviews;
    db.meta.demo = true;
  }, { immediate: true });
}

module.exports = { Store, defaultDB, defaultProfile, migrate, seedDB, uid, nowISO, SCHEMA_VERSION };
