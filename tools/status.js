#!/usr/bin/env node
'use strict';
/**
 * status.js —— 只读地看一眼当前数据状态
 *
 * 🔴 为什么必须单独做一个只读入口：
 *
 * `Store.init()` 会做几件**写操作** —— 累加 `meta.openCount`、更新 `meta.lastOpenAt`、
 * 可能滚动备份、可能迁移结构，最后 `save()` 落盘。也就是说
 *
 *     const s = new Store(dataDir); s.init(); s.read()
 *
 * **看起来是「读」数据，实际会改写数据文件**。
 *
 * 应用正在运行时这么干尤其危险：应用把整个库放在内存里，随时会按内存状态整体落盘。
 * 第二个进程的写入要么被应用的下一写覆盖掉（白写），要么在时序上盖掉应用刚落下的改动
 * （丢数据）。这是双进程共享一个 JSON 文件的固有风险，不是能靠小心避免的。
 *
 * 所以：**任何「只是看一眼」的需求，都必须走这个脚本**，它只做
 * `readFileSync + JSON.parse`，一个字节都不写。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const A = require('../src/main/analytics');
const U = require('../src/main/util');

function defaultDataDir() {
  const name = '学习中心';
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', name);
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), name);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), name);
}

/** 纯读：不构造 Store，因此不会触发任何写 */
function readOnly(dir) {
  const file = path.join(dir, 'study-hub.json');
  if (!fs.existsSync(file)) return { file, exists: false };
  const raw = fs.readFileSync(file, 'utf8');
  return { file, exists: true, bytes: Buffer.byteLength(raw), db: JSON.parse(raw), mtime: fs.statSync(file).mtime };
}

function alive(dir) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(dir, 'app-alive.json'), 'utf8'));
    const age = Date.now() - info.at;
    let running = false;
    try { process.kill(info.pid, 0); running = true; } catch (err) { if (err && err.code === 'EPERM') running = true; }
    return { ...info, ageSec: Math.round(age / 1000), stale: age > 90000, processExists: running };
  } catch (_) { return null; }
}

function daemonState(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'daemon-state.json'), 'utf8')); } catch (_) { return null; }
}

/**
 * 把读到的文件归一化成「一组空间」。
 * v5 是 { tenants, libs, activeTenantId }，v4 及更早是单库（顶层直接是 subjects…）。
 * 这个脚本是给人「看一眼」用的，所以两种结构都得认 —— 否则升级后
 * 在旧数据上跑会读到 undefined，报一堆「科目 undefined」（而其实文件没坏）。
 */
function spacesOf(raw) {
  if (raw && raw.libs && typeof raw.libs === 'object') {
    const list = raw.tenants || [];
    return {
      version: raw.version,
      activeId: raw.activeTenantId,
      list: Object.keys(raw.libs).map((id) => {
        const t = list.find((x) => x.id === id) || {};
        return { id, name: t.name || id, field: t.field || '', level: t.level || '', db: raw.libs[id] };
      })
    };
  }
  /* v4 老文件：显示成「我的学习」—— 那正是它升级后的名字，
     写「单库结构」对用户是术语噪音，他关心的只是「我的数据在哪一个空间里」。 */
  return { version: raw.version, activeId: '', list: [{ id: '', name: '我的学习', db: raw }] };
}

function main() {
  const args = process.argv.slice(2);
  const di = args.indexOf('--data-dir');
  const dir = (di > -1 && args[di + 1]) || defaultDataDir();
  const json = args.includes('--json');

  const r = readOnly(dir);
  if (!r.exists) {
    const out = { dataDir: dir, exists: false, note: '还没有数据文件 —— 应用没启动过' };
    console.log(json ? JSON.stringify(out, null, 2) : `${dir}\n  还没有数据文件（应用没启动过）`);
    process.exit(0);
  }

  const all = spacesOf(r.db);
  const today = U.dayKey();
  const a = alive(dir);
  const ds = daemonState(dir);
  const LEVEL = { undergrad: '本科', grad: '研究生', any: '通用' };

  /** 逐空间取统计。analytics 只认「一个库」，所以这里逐个进去算 —— 不需要它知道租户。 */
  const spaces = all.list.map((sp) => {
    const db = sp.db;
    const q = A.reviewQueue(db, today);
    const tasks = A.tasksOn(db, today);
    const ov = A.overview(db);
    return {
      id: sp.id,
      name: sp.name,
      field: sp.field,
      level: LEVEL[sp.level] || sp.level || '',
      active: sp.id === all.activeId || (!all.activeId && sp.id === ''),
      demo: !!(db.meta && db.meta.demo),
      counts: {
        subjects: (db.subjects || []).length, materials: (db.materials || []).length,
        plans: (db.plans || []).length, sessions: (db.sessions || []).length,
        reminders: (db.reminders || []).length, reviews: (db.reviews || []).length
      },
      today: {
        minutes: A.sumRange(db, today, today).minutes,
        goalMin: (db.profile || {}).dailyGoalMin || 120,
        tasksTotal: tasks.length,
        tasksUndone: tasks.filter((x) => !x.done).length,
        reviewDue: q.total,
        reviewOverdue: q.overdue.length
      },
      streak: ov.streak.current,
      weekScore: ov.score.score
    };
  });
  const cur = spaces.find((x) => x.active) || spaces[0] || null;

  const out = {
    dataDir: dir,
    file: r.file,
    bytes: r.bytes,
    mtime: r.mtime.toISOString(),
    schema: all.version,
    spaceCount: spaces.length,
    activeSpaceId: all.activeId,
    activeSpace: cur ? cur.name : null,
    spaces,
    // 顶层这几项保留「当前空间」的口径，方便脚本沿用旧字段
    demo: cur ? cur.demo : false,
    counts: cur ? cur.counts : {},
    today: cur ? cur.today : {},
    streak: cur ? cur.streak : 0,
    weekScore: cur ? cur.weekScore : 0,
    app: a
      ? { pid: a.pid, heartbeatAgoSec: a.ageSec, running: a.processExists && !a.stale, stale: a.stale }
      : { running: false, note: '没有心跳文件' },
    daemon: ds ? { runs: ds.runs, lastFired: ds.lastFiredCount, lastError: ds.lastError } : null
  };

  if (json) { console.log(JSON.stringify(out, null, 2)); return; }

  const L = [];
  L.push('学习中心 · 当前状态（只读）');
  L.push('');
  L.push('数据：' + r.file);
  L.push(`  schema v${all.version} · ${(r.bytes / 1024).toFixed(1)} KB · 改于 ${r.mtime.toLocaleString('zh-CN')}`);
  L.push(`  学科空间 ${spaces.length} 个${cur ? `，当前是「${cur.name}」` : ''}`);
  L.push('');
  L.push('各空间：');
  spaces.forEach((sp) => {
    const mark = sp.active ? '▸' : ' ';
    L.push(`${mark} ${sp.name}${sp.level || sp.field ? `（${[sp.level, sp.field].filter(Boolean).join(' · ')}）` : ''}${sp.demo ? ' [示例数据]' : ''}`);
    L.push(`    科目 ${sp.counts.subjects} · 资料 ${sp.counts.materials} · 计划 ${sp.counts.plans} · 复习 ${sp.counts.reviews} · 提醒 ${sp.counts.reminders} · 记录 ${sp.counts.sessions}`);
    L.push(`    今日已学 ${U.humanMin(sp.today.minutes)}/${U.humanMin(sp.today.goalMin)} · 任务 ${sp.today.tasksTotal} 项（未完成 ${sp.today.tasksUndone}）· 待复习 ${sp.today.reviewDue} 个${sp.today.reviewOverdue ? `（逾期 ${sp.today.reviewOverdue}）` : ''}`);
    L.push(`    连续 ${sp.streak} 天 · 本周评分 ${sp.weekScore}`);
  });
  L.push('');
  L.push(`当前空间「${cur ? cur.name : '—'}」今日：`);
  L.push(`  已学 ${U.humanMin(cur.today.minutes)} / 目标 ${U.humanMin(cur.today.goalMin)}`);
  L.push(`  任务 ${cur.today.tasksTotal} 项（未完成 ${cur.today.tasksUndone}）`);
  L.push(`  待复习 ${cur.today.reviewDue} 个${cur.today.reviewOverdue ? `（逾期 ${cur.today.reviewOverdue}）` : ''}`);
  L.push(`  连续打卡 ${cur.streak} 天 · 本周评分 ${cur.weekScore}`);
  L.push('');
  L.push('运行状态：');
  L.push(out.app.running
    ? `  ✓ 应用正在运行（pid ${out.app.pid}，心跳 ${out.app.heartbeatAgoSec} 秒前）`
    : `  · 应用未在运行${out.app.note ? '（' + out.app.note + '）' : ''}${out.app.stale ? ' [心跳已过期]' : ''}`);
  if (out.daemon) L.push(`  后台提醒守护：巡检过 ${out.daemon.runs} 次${out.daemon.lastError ? '，上次有报错：' + out.daemon.lastError : ''}`);
  console.log(L.join('\n'));
}

if (require.main === module) main();
module.exports = { readOnly, defaultDataDir };
