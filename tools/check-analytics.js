'use strict';
/**
 * 口径自检：直接以纯 Node 加载数据层与统计层，把关键数字打出来人工核对。
 * 这几层刻意不依赖 electron，就是为了能这样单独体检（store/analytics/util 都只依赖标准库）。
 *
 * 用法：node tools/check-analytics.js
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const { Store, seedDB } = require('../src/main/store');
const A = require('../src/main/analytics');
const U = require('../src/main/util');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-check-'));
const store = new Store(dir);
store.init();
seedDB(store);

const db = store.read();
const today = U.dayKey();
const ws = db.profile.weekStart;
const weekFrom = U.dayKey(U.startOfWeek(new Date(), ws));
const weekTo = U.dayKey(U.addDays(U.startOfWeek(new Date(), ws), 6));

console.log('今天           :', today);
console.log('本周           :', weekFrom, '→', weekTo);
console.log('日目标/周目标  :', db.profile.dailyGoalMin, '/', db.profile.weeklyGoalMin);
console.log('');
console.log('科目数 / 资料数/ 计划数 / 提醒数 :', db.subjects.length, db.materials.length, db.plans.length, db.reminders.length);
console.log('学习记录条数   :', db.sessions.length);
console.log('记录覆盖日期   :', [...new Set(db.sessions.map((s) => U.dayKey(new Date(s.start))))].sort().join(' '));
console.log('');

console.log('--- 计划任务 ---');
for (const plan of db.plans) {
  console.log(`计划「${plan.title}」 ${plan.startDate} → ${plan.endDate}  status=${plan.status}`);
  for (const t of plan.tasks) {
    console.log(`  · ${t.title}
      date=${t.date} repeat=${t.repeat} weekdays=${JSON.stringify(t.weekdays)} estMin=${t.estMin}
      doneDates=${JSON.stringify(t.doneDates)}`);
  }
  console.log('  里程碑:', plan.milestones.map((m) => `${m.title}(due ${m.due}, done=${m.done})`).join(' | '));
}

console.log('');
console.log('--- tasksOn 按天展开（今天前后各 4 天）---');
for (let off = -4; off <= 4; off++) {
  const k = U.dayKey(U.addDays(new Date(), off));
  const rows = A.tasksOn(db, k);
  console.log(`  ${k}: ${rows.length} 项  ${rows.map((r) => `${r.task.title.slice(0, 10)}${r.done ? '✓' : '✗'}`).join(', ')}`);
}

console.log('');
console.log('--- 概览 ---');
const ov = A.overview(db);
console.log(JSON.stringify({
  todayMinutes: ov.todayMinutes, todaySessions: ov.todaySessions,
  weekMinutes: ov.weekMinutes, weekSessions: ov.weekSessions,
  weekProgress: +ov.weekProgress.toFixed(3),
  streak: ov.streak, score: ov.score,
  todayTasks: ov.todayTasks.map((t) => `${t.title}(done=${t.done})`),
  weekTaskStats: ov.weekTaskStats,
  counts: ov.counts
}, null, 2));

console.log('');
console.log('--- 本周 / 上周 周报 ---');
for (const off of [0, -1]) {
  const r = A.weeklyReport(db, off);
  console.log(JSON.stringify({
    offset: off, from: r.from, to: r.to,
    minutes: r.minutes, sessions: r.sessions, avgPerDay: r.avgPerDay, activeDays: r.activeDays,
    tasks: r.tasks, score: r.score,
    missed: r.missed.map((m) => `${m.date} ${m.title}`),
    subjects: r.subjects.map((s) => `${s.name} ${s.minutes}m ${s.pct}%`),
    series: r.series.map((d) => `${d.date.slice(5)}:${d.minutes}`)
  }, null, 2));
}

console.log('');
console.log('--- 各科目近 30 天 ---');
console.log(A.subjectBreakdown(db, U.dayKey(U.addDays(new Date(), -29)), today)
  .map((s) => `${s.name}: ${s.minutes} 分钟 (${s.pct}%, ${s.sessions} 段)`).join('\n'));

console.log('');
console.log('--- 计划体检 ---');
console.log(JSON.stringify(A.planReport(db).map((p) => ({
  title: p.title, daysLeft: p.daysLeft, due: p.due, done: p.done, overdue: p.overdue, rate: p.rate, risk: p.risk
})), null, 2));

console.log('');
console.log('--- 资料体检 ---');
const mr = A.materialReport(db);
console.log(JSON.stringify({
  total: mr.total, totalMin: mr.totalMin, finished: mr.finishedCount,
  neverOpened: mr.neverOpened.map((m) => m.title),
  idle: mr.idle.map((m) => `${m.title}(${m.idleFor}天)`),
  inProgress: mr.inProgress.map((m) => `${m.title} ${m.progress}%`)
}, null, 2));

console.log('');
console.log('--- 连续打卡 / 时段分布 ---');
console.log('streak:', JSON.stringify(A.streak(db)));
console.log('hourly:', A.hourlyDistribution(db, 30).map((v, i) => `${i}时:${v}`).filter((s) => !s.endsWith(':0')).join(' '));

/* ------------------------------------------------------------------ *
 * 复习（间隔重复）
 * ------------------------------------------------------------------ */
console.log('');
console.log('--- 间隔重复 ---');
console.log('间隔表:', A.REVIEW_INTERVALS.join(' / '), '天');

console.log('\n推进算法（从新加入开始，一路「记住了」）:');
{
  let item = { stage: 0, lapses: 0 };
  let k = today;
  const trace = [`stage0 → 次日 ${A.nextReviewAt(0, k)}`];
  for (let i = 0; i < 8; i++) {
    const r = A.advanceReview(item, 'good', k);
    trace.push(`第${i + 1}次 good → stage=${r.stage}${r.mastered ? '（已掌握）' : ''} next=${r.nextAt || '—'}`);
    item = { stage: r.stage, lapses: r.lapses };
    if (r.mastered) break;
  }
  trace.forEach((t) => console.log('  ' + t));
}
console.log('\n「忘了」的回退:');
{
  const r = A.advanceReview({ stage: 4, lapses: 1 }, 'forgot', today);
  console.log(`  stage4 + forgot → stage=${r.stage} next=${r.nextAt} lapses=${r.lapses}`);
  const r2 = A.advanceReview({ stage: 3, lapses: 0 }, 'fuzzy', today);
  console.log(`  stage3 + fuzzy  → stage=${r2.stage} next=${r2.nextAt}（保持同档，重新计时）`);
}

const q = A.reviewQueue(db, today);
console.log('\n今日队列:');
console.log(`  到期 ${q.due.length} / 逾期 ${q.overdue.length} / 未到期 ${q.upcoming.length}`);
[...q.overdue, ...q.due].forEach((r) => console.log(`    · ${r.title}  stage=${r.stage} next=${r.nextAt} lapses=${r.lapses}`));
q.upcoming.slice(0, 5).forEach((r) => console.log(`    待 ${r.nextAt}  ${r.title}`));

const rs = A.reviewStats(db, 14);
console.log('\n复习统计:', JSON.stringify({
  total: rs.total, active: rs.active, mastered: rs.mastered,
  attempts: rs.attempts, good: rs.good, fuzzy: rs.fuzzy, forgot: rs.forgot,
  retention: rs.retention, lapses: rs.lapses, avgStage: rs.avgStage,
  dueToday: rs.dueToday, overdue: rs.overdue, reviewedLast7: rs.reviewedLast7,
  byStage: rs.byStage, busiest: rs.busiest
}, null, 2));
console.log('未来 14 天负载:', rs.load.map((d) => `${d.date.slice(5)}:${d.count}`).join(' '));

console.log('\n记忆保持率自洽性检查:');
console.log(`  retention=${rs.retention}  ← 期望 round(good/attempts*100)=${rs.attempts ? Math.round((rs.good / rs.attempts) * 100) : 'n/a'}`);
console.log(`  byStage 合计=${rs.byStage.reduce((a, b) => a + b, 0)}  ← 期望 active+mastered=${rs.active + rs.mastered}`);
const lSum = rs.load.reduce((a, b) => a + b.count, 0);
const dueNow = rs.dueToday + rs.overdue;
console.log(`  load[0]=${rs.load[0].count}  ← 期望 dueToday+overdue=${dueNow}`);
console.log(`  load 合计=${lSum}`);

/* ------------------------------------------------------------------ *
 * 共享提醒规则引擎
 * ------------------------------------------------------------------ */
console.log('');
console.log('--- 提醒规则引擎（shared/rules.evaluate）---');
const rules = require('../src/shared/rules');

function evalAt(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const now = new Date();
  now.setHours(h, m, 0, 0);
  return { now, items: rules.evaluate(db, { firedAt: {}, now }) };
}

/**
 * 这里最值得自动化的检查是「同一条规则在一天内只会被算出来一次」。
 * 早先版本用「每 N 分钟一个唯一键」做节流，结果一晚上会往状态文件里写上百个键。
 */
for (const t of ['08:00', '12:00', '19:05', '20:05', '21:05', '21:35', '23:50']) {
  const { items } = evalAt(t);
  console.log(`  ${t}  命中 ${items.length} 条：${items.map((i) => `${i.key}(${i.kind})`).join(', ') || '—'}`);
}

console.log('\n定时提醒在不同时刻的命中情况（示例提醒 07:30 / 19:30 / 22:30）:');
for (const t of ['07:35', '07:50', '19:35', '22:35', '23:10']) {
  const { items } = evalAt(t);
  const rems = items.filter((i) => i.key.startsWith('rem_'));
  console.log(`  ${t} → ${rems.length ? rems.map((r) => r.title).join('；') : '无（超出 15 分钟补发窗口或未到点，符合设计）'}`);
}

console.log('\n合并已触发记录（应用 ∪ 守护，同键取较新）:');
console.log('  ', JSON.stringify(rules.mergeFired(
  { task_warn: '2026-10-06', digest: '2026-10-07' },
  { task_warn: '2026-10-07', idle_material: '2026-10-01' }
)));

console.log('\n修剪（只留最近 120 天）:');
console.log('  ', JSON.stringify(rules.pruneFired({ a: '2026-10-07', b: '2026-01-01', c: '2025-06-01' })));

fs.rmSync(dir, { recursive: true, force: true });
