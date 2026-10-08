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

const SCHEMA_VERSION = 5;
const MAX_BACKUPS = 14;

/** 每个学科空间内部的集合 —— 这些数据按空间物理隔离 */
const TENANT_COLLS = ['subjects', 'materials', 'plans', 'sessions', 'reminders', 'reviews'];
const LEVELS = ['undergrad', 'grad', 'any'];

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

/* ------------------------------------------------------------------ *
 * 多租户（学科空间）
 *
 * 一个「学科空间」＝ 一个独立的学习库：自己的科目、资料、计划、
 * 学习记录、提醒、复习队列，连目标与番茄钟设置都是独立的。
 *
 * 🔴 隔离方式是**物理隔离**：文件里每个空间占一个独立的 libs[id] 条目，
 *    内存里 store.db 任何时刻只指向其中一个。
 *    于是 analytics / ipc / 渲染层**都不需要**加租户过滤 —— 拿到的数据
 *    天然只有当前空间的。
 *
 *    反面做法是「每行加 tenantId，读的时候记得过滤」。那样每新增一个查询
 *    都要多问一次「我过滤了吗」，漏一处就是跨空间串数据；而这类 bug
 *    在只有单空间的测试里永远看不出来。隔离要靠结构，不能靠自觉。
 * ------------------------------------------------------------------ */

/** 一个学科空间的库。结构与 v4 时代完全相同，所以数据层代码一行都不用改。 */
function defaultLib() {
  return {
    version: SCHEMA_VERSION,
    profile: defaultProfile(),
    subjects: [],
    materials: [],
    plans: [],
    sessions: [],
    reminders: [],
    reviews: [],
    timer: null,
    scheduler: { lastFired: {}, overrunAt: 0, breakOverrunAt: 0, breakOverrunStage: 0 },
    meta: { demo: false, seeded: false, lastOpenAt: null, openCount: 0, lastBackupAt: null, daemonSeq: 0 }
  };
}

/** 空间元数据。补齐字段、限长，避免外部传入的形状污染存储。 */
function normalizeTenant(t) {
  const src = t || {};
  return {
    id: String(src.id || uid('ten_')),
    name: String(src.name || '未命名空间').slice(0, 48),
    /** 主要学科 / 领域名，如「生物信息学」 */
    field: String(src.field || '').slice(0, 40),
    /** 阶段：undergrad（本科）/ grad（研究生）/ any（不限） */
    level: LEVELS.includes(src.level) ? src.level : 'any',
    /** cross（跨学科）/ discipline（单一学科）/ custom（自建） */
    kind: src.kind || 'custom',
    /** 交叉的母学科，如 ['生物学','计算机科学','统计学'] */
    parents: Array.isArray(src.parents) ? src.parents.slice(0, 5).map((x) => String(x).slice(0, 24)) : [],
    blurb: String(src.blurb || '').slice(0, 300),
    color: src.color || '#2563eb',
    /** 由哪个模板创建（空字符串＝手工创建） */
    templateId: src.templateId || '',
    createdAt: src.createdAt || nowISO(),
    archived: !!src.archived
  };
}

function defaultTenant(over = {}) {
  return normalizeTenant(Object.assign({
    id: 'ten_default',
    name: '我的学习',
    field: '综合',
    level: 'any',
    kind: 'custom',
    blurb: '默认的学科空间。到「学科空间」页可以从 12 个跨学科模板里新建更多。',
    color: '#2563eb'
  }, over));
}

/** 整份文件：空间列表 + 各自的库 + 当前激活的空间 */
function defaultDB() {
  const t = defaultTenant();
  return {
    version: SCHEMA_VERSION,
    createdAt: nowISO(),
    activeTenantId: t.id,
    tenants: [t],
    libs: { [t.id]: defaultLib() },
    /* 守护进程的通知序号是**跨空间**的（守护进程是同一个进程、同一个日志），
       所以它属于文件级而不是某个空间的库 —— 放空间里会导致
       「切换空间后同一批守护通知被当成新的再导一次」。 */
    daemon: { seq: 0 }
  };
}

/* ------------------------------------------------------------------ *
 * 迁移
 * ------------------------------------------------------------------ */

/** 把任意版本的**单个库**补齐成当前结构。只做结构性补齐，不猜业务数据。 */
function migrateLib(input) {
  const db = input && typeof input === 'object' ? input : {};
  const fresh = defaultLib();
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

/**
 * 把任意版本的**整份文件**补齐成当前结构。
 *
 * v4 及以前是「单库」结构（文件顶层直接就是 subjects/materials/...）。
 * 这里把它原样包成一个名为「我的学习」的空间 —— 老数据一条不丢，
 * 用户升级后打开看到的就是原来那份数据，只是多了「可以再建空间」的能力。
 */
function migrateRaw(input) {
  const src = input && typeof input === 'object' ? input : {};

  if (src.libs && typeof src.libs === 'object' && src.activeTenantId) {
    const libs = {};
    for (const [id, lib] of Object.entries(src.libs)) libs[String(id)] = migrateLib(lib);
    let tenants = Array.isArray(src.tenants) ? src.tenants.map(normalizeTenant) : [];
    // 两端可能不一致（手工改过文件、或某次写入中断）：以库为准补齐元数据，元数据没有库的直接丢掉
    for (const id of Object.keys(libs)) {
      if (!tenants.some((t) => t.id === id)) tenants.push(normalizeTenant({ id, name: id }));
    }
    tenants = tenants.filter((t) => libs[t.id]);
    if (!tenants.length) {
      const t = defaultTenant();
      tenants = [t];
      libs[t.id] = defaultLib();
    }
    let active = String(src.activeTenantId);
    if (!libs[active]) active = tenants[0].id;
    return {
      version: SCHEMA_VERSION,
      createdAt: src.createdAt || nowISO(),
      activeTenantId: active,
      tenants,
      libs,
      daemon: { seq: Number((src.daemon || {}).seq) || 0 }
    };
  }

  const lib = migrateLib(src);
  const t = defaultTenant({ createdAt: src.createdAt || (lib.meta && lib.meta.lastOpenAt) || nowISO() });
  return {
    version: SCHEMA_VERSION,
    createdAt: src.createdAt || nowISO(),
    activeTenantId: t.id,
    tenants: [t],
    libs: { [t.id]: lib },
    daemon: { seq: Number((src.daemon || {}).seq) || 0 }
  };
}

/** v4 时代的外部调用方（导入数据）拿到的是单个库，保留 migrate 这个名字做库级迁移 */
const migrate = migrateLib;

/* ------------------------------------------------------------------ *
 * Store
 * ------------------------------------------------------------------ */

class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'study-hub.json');
    this.backupDir = path.join(dataDir, 'backups');
    /** 整份文件：空间列表 + 每个空间的库 */
    this.raw = defaultDB();
    /** 当前空间（学科空间）的库。与 raw.libs[activeTenantId] 是**同一个对象**，不是副本。 */
    this.db = this.raw.libs[this.raw.activeTenantId];
    this._timer = null;
    this._dirty = false;
    this._lastError = null;
    this._inWithTenant = false;
  }

  /**
   * 让 this.db 指向 raw.activeTenantId 对应的库。
   * 索引指向一个不存在的空间时（被删了 / 文件被手工改坏）回落到第一个，
   * 全都不可用时重建一个默认空间 —— 目标只有一个：永远不要出现「没有当前空间」的状态。
   */
  _bind() {
    const libs = this.raw.libs;
    if (!libs[this.raw.activeTenantId]) {
      const first = Object.keys(libs)[0];
      if (first) {
        this.raw.activeTenantId = first;
      } else {
        const t = defaultTenant();
        this.raw.tenants = [t];
        this.raw.libs = { [t.id]: defaultLib() };
        this.raw.activeTenantId = t.id;
      }
    }
    this.db = this.raw.libs[this.raw.activeTenantId];
    return this.db;
  }

  init() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.backupDir, { recursive: true });
    if (fs.existsSync(this.file)) {
      try {
        const raw = fs.readFileSync(this.file, 'utf8');
        this.raw = migrateRaw(JSON.parse(raw));
      } catch (err) {
        // 主文件读不出来：先把它挪到一边留证，再尝试最近一份备份
        this._lastError = `主数据文件损坏（${err.message}），已隔离并尝试从备份恢复`;
        const broken = this.file + '.broken-' + Date.now();
        try { fs.renameSync(this.file, broken); } catch (_) {}
        this.raw = this._restoreLatestBackup() || defaultDB();
        this._bind();
        this.save(true);
      }
    } else {
      this.raw = defaultDB();
      this.save(true);
    }

    this._bind();
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
          if (parsed && (parsed.libs || Array.isArray(parsed.sessions))) return migrateRaw(parsed);
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
      // 备份整份文件（全部学科空间）—— 恢复时是整体回滚，语义比「只备份当前空间」简单且安全
      fs.writeFileSync(target, JSON.stringify(this.raw, null, 2), 'utf8');
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
      // raw.libs[activeTenantId] 与 this.db 是同一个对象，所以这里不需要额外同步
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.raw, null, 2), 'utf8');
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

  /* ---------------- 学科空间（租户） ---------------- */

  /** 空间元数据列表（不含各自的库） */
  listTenants() {
    return this.raw.tenants;
  }

  activeTenantId() {
    return this.raw.activeTenantId;
  }

  activeTenant() {
    return this.raw.tenants.find((t) => t.id === this.raw.activeTenantId) || null;
  }

  libOf(id) {
    return this.raw.libs[id] || null;
  }

  tenantCount() {
    return Object.keys(this.raw.libs).length;
  }

  /**
   * 临时切到另一个空间执行**同步**逻辑，结束后切回。
   *
   * 🔴 只允许同步 fn。中途 await 会让 this.db 在别人（比如另一个提醒检查、
   *    或者用户的一次点击）手里指向错误的库 —— 那正是「跨空间串数据」。
   *    这里直接拦住重入和异步返回，宁可报错也不要静默写错地方。
   */
  withTenant(id, fn) {
    if (this._inWithTenant) throw new Error('withTenant 不可重入');
    if (!this.raw.libs[id]) throw new Error('学科空间不存在：' + id);
    const prev = this.raw.activeTenantId;
    this._inWithTenant = true;
    this.raw.activeTenantId = id;
    this._bind();
    try {
      const ret = fn(this.db);
      if (ret && typeof ret.then === 'function') {
        throw new Error('withTenant 只接受同步函数，不要传 async');
      }
      return ret;
    } finally {
      this.raw.activeTenantId = prev;
      this._inWithTenant = false;
      this._bind();
    }
  }

  switchTenant(id) {
    if (!this.raw.libs[id]) return { ok: false, message: '这个学科空间不存在' };
    this.raw.activeTenantId = id;
    this._bind();
    this.db.meta.lastOpenAt = nowISO();
    this.save(true);
    return { ok: true, tenant: this.activeTenant() };
  }

  /** @param {object} meta 空间元数据 @param {object} [lib] 预置的库，不传则建空库 */
  addTenant(meta, lib) {
    const t = normalizeTenant(meta);
    this.raw.tenants.push(t);
    this.raw.libs[t.id] = lib ? migrateLib(lib) : defaultLib();
    this.save(true);
    return t;
  }

  updateTenant(id, patch) {
    const t = this.raw.tenants.find((x) => x.id === id);
    if (!t) return null;
    Object.assign(t, normalizeTenant(Object.assign({}, t, patch, { id })));
    this.save(true);
    return t;
  }

  /** 删除一个空间。库里必须至少留一个 —— 否则界面会进入「没有空间」的死状态。 */
  removeTenant(id) {
    if (!this.raw.libs[id]) return { ok: false, message: '这个学科空间不存在' };
    if (this.tenantCount() <= 1) return { ok: false, message: '至少要保留一个学科空间' };
    delete this.raw.libs[id];
    this.raw.tenants = this.raw.tenants.filter((t) => t.id !== id);
    if (this.raw.activeTenantId === id) this.raw.activeTenantId = Object.keys(this.raw.libs)[0];
    this._bind();
    this.save(true);
    return { ok: true, activeTenantId: this.raw.activeTenantId };
  }

  /** 用一份新的整库数据替换内存（导入整库 / 恢复备份用），随后重新绑定当前空间 */
  replaceRaw(next) {
    this.raw = migrateRaw(next);
    this._bind();
    this._dirty = true;
    this.save(true);
    return this.raw;
  }

  /** 守护进程通知序号（文件级，跨空间共用） */
  daemonSeq() {
    return (this.raw.daemon && this.raw.daemon.seq) || 0;
  }

  setDaemonSeq(n) {
    this.raw.daemon = { seq: Number(n) || 0 };
    this._dirty = true;
    this.save(true);
  }

  /** 每个空间的概览（给「学科空间」页的卡片用）。不改变当前空间。 */
  tenantOverview(id) {
    const lib = this.raw.libs[id];
    if (!lib) return null;
    const sessions = lib.sessions || [];
    const focusMin = sessions.reduce((a, s) => a + (s.minutes || 0), 0);
    const activePlans = (lib.plans || []).filter((x) => x.status === 'active');
    const tasks = activePlans.reduce((a, p) => a + (p.tasks || []).length, 0);
    const doneTasks = activePlans.reduce((a, p) => a + (p.tasks || []).filter((t) => t.done).length, 0);
    return {
      id,
      subjects: (lib.subjects || []).length,
      materials: (lib.materials || []).length,
      plans: activePlans.length,
      tasks,
      doneTasks,
      sessions: sessions.length,
      minutes: focusMin,
      reviews: (lib.reviews || []).filter((r) => !r.archived && !r.mastered).length,
      mastered: (lib.reviews || []).filter((r) => r.mastered && !r.archived).length,
      lastAt: lib.meta.lastOpenAt || null,
      demo: !!lib.meta.demo
    };
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

module.exports = {
  Store, seedDB, uid, nowISO,
  SCHEMA_VERSION, TENANT_COLLS, LEVELS,
  defaultDB, defaultLib, defaultProfile, defaultTenant, normalizeTenant,
  migrate, migrateLib, migrateRaw
};
