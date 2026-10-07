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

  const db = r.db;
  const today = U.dayKey();
  const q = A.reviewQueue(db, today);
  const tasks = A.tasksOn(db, today);
  const ov = A.overview(db);
  const a = alive(dir);
  const ds = daemonState(dir);

  const out = {
    dataDir: dir,
    file: r.file,
    bytes: r.bytes,
    mtime: r.mtime.toISOString(),
    schema: db.version,
    demo: !!db.meta.demo,
    counts: {
      subjects: db.subjects.length, materials: db.materials.length, plans: db.plans.length,
      sessions: db.sessions.length, reminders: db.reminders.length, reviews: db.reviews.length
    },
    today: {
      minutes: A.sumRange(db, today, today).minutes,
      goalMin: db.profile.dailyGoalMin,
      tasksTotal: tasks.length,
      tasksUndone: tasks.filter((x) => !x.done).length,
      reviewDue: q.total,
      reviewOverdue: q.overdue.length
    },
    streak: ov.streak.current,
    weekScore: ov.score.score,
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
  L.push(`  schema v${db.version}${db.meta.demo ? '（含示例数据）' : ''} · ${(r.bytes / 1024).toFixed(1)} KB · 改于 ${r.mtime.toLocaleString('zh-CN')}`);
  L.push(`  科目 ${out.counts.subjects} · 资料 ${out.counts.materials} · 计划 ${out.counts.plans} · 复习 ${out.counts.reviews} · 提醒 ${out.counts.reminders} · 记录 ${out.counts.sessions} 条`);
  L.push('');
  L.push('今天：');
  L.push(`  已学 ${U.humanMin(out.today.minutes)} / 目标 ${U.humanMin(out.today.goalMin)}`);
  L.push(`  任务 ${out.today.tasksTotal} 项（未完成 ${out.today.tasksUndone}）`);
  L.push(`  待复习 ${out.today.reviewDue} 个${out.today.reviewOverdue ? `（逾期 ${out.today.reviewOverdue}）` : ''}`);
  L.push(`  连续打卡 ${out.streak} 天 · 本周评分 ${out.weekScore}`);
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
