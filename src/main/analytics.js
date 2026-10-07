'use strict';
/**
 * analytics.js —— 统计与「监督复盘」的全部推导逻辑
 *
 * 原则：所有指标都能被解释。UI 上每一个数字都应当能追溯到「哪些记录算进来的」，
 * 所以这里只做纯函数式聚合，不依赖任何 UI 状态。
 */

const U = require('./util');

/* ------------------------------------------------------------------ *
 * 计划任务：重复规则判定
 * ------------------------------------------------------------------ */

/** 某个任务在 key 这一天是否「应当做」 */
function taskDueOn(task, plan, key) {
  const dow = U.parseDayKey(key).getDay();
  const start = task.date || (plan && plan.startDate) || key;
  if (key < start) return false;
  switch (task.repeat) {
    case 'daily':
      return true;
    case 'weekdays':
      return dow >= 1 && dow <= 5;
    case 'weekly':
      return (task.weekdays && task.weekdays.length ? task.weekdays : [1]).includes(dow);
    case 'monthly':
      return U.parseDayKey(key).getDate() === U.parseDayKey(start).getDate();
    case 'none':
    default:
      return key === start;
  }
}

/** 某个任务在 key 这一天是否已完成 */
function taskDoneOn(task, key) {
  if (Array.isArray(task.doneDates) && task.doneDates.includes(key)) return true;
  if (task.repeat === 'none' || !task.repeat) return task.done === true && !!task.doneAt && String(task.doneAt).slice(0, 10) === key;
  return false;
}

/** 汇总某天应做/已完成的任务清单 */
function tasksOn(db, key) {
  const due = [];
  for (const plan of db.plans || []) {
    if (plan.status === 'archived') continue;
    if (plan.startDate && key < plan.startDate) continue;
    if (plan.endDate && key > plan.endDate) continue;
    for (const task of plan.tasks || []) {
      if (task.archived) continue;
      if (taskDueOn(task, plan, key)) {
        due.push({ task, plan, done: taskDoneOn(task, key) });
      }
    }
  }
  return due;
}

/* ------------------------------------------------------------------ *
 * 基础聚合
 * ------------------------------------------------------------------ */

function sessionDayKey(s) { return U.dayKey(new Date(s.start)); }

/** 一段时间内的分钟数 / 场次（按本地日期闭区间） */
function sumRange(db, fromKey, toKey, filter) {
  let minutes = 0, count = 0, interruptions = 0, scoreSum = 0, scoreN = 0;
  for (const s of db.sessions || []) {
    const k = sessionDayKey(s);
    if (k < fromKey || k > toKey) continue;
    if (filter && !filter(s, k)) continue;
    minutes += s.minutes || 0;
    count += 1;
    interruptions += s.interruptions || 0;
    if (typeof s.focusScore === 'number') { scoreSum += s.focusScore; scoreN++; }
  }
  return { minutes, count, interruptions, avgScore: scoreN ? Math.round(scoreSum / scoreN) : null };
}

/** 逐日序列（含无记录的日子，值为 0，方便直接画图） */
function dailySeries(db, days = 30) {
  const today = new Date();
  const from = U.dayKey(U.addDays(today, -(days - 1)));
  const to = U.dayKey(today);
  const keys = U.rangeKeys(from, to);
  const map = new Map(keys.map((k) => [k, { date: k, minutes: 0, sessions: 0, interruptions: 0, bySubject: {} }]));
  for (const s of db.sessions || []) {
    const k = sessionDayKey(s);
    const row = map.get(k);
    if (!row) continue;
    row.minutes += s.minutes || 0;
    row.sessions += 1;
    row.interruptions += s.interruptions || 0;
    if (s.subjectId) row.bySubject[s.subjectId] = (row.bySubject[s.subjectId] || 0) + (s.minutes || 0);
  }
  return keys.map((k) => map.get(k));
}

/** 按科目拆分 */
function subjectBreakdown(db, fromKey, toKey) {
  const acc = new Map();
  for (const s of db.sessions || []) {
    const k = sessionDayKey(s);
    if (k < fromKey || k > toKey) continue;
    const id = s.subjectId || '__none__';
    const cur = acc.get(id) || { subjectId: id, minutes: 0, sessions: 0 };
    cur.minutes += s.minutes || 0;
    cur.sessions += 1;
    acc.set(id, cur);
  }
  const total = [...acc.values()].reduce((a, b) => a + b.minutes, 0) || 1;
  return [...acc.values()]
    .map((r) => {
      const sub = (db.subjects || []).find((x) => x.id === r.subjectId);
      return {
        ...r,
        name: sub ? sub.name : '未分类',
        color: sub ? sub.color : '#94a3b8',
        pct: Math.round((r.minutes / total) * 1000) / 10
      };
    })
    .sort((a, b) => b.minutes - a.minutes);
}

/** 打卡热力图：返回近 weeks*7 天的等级 0-4 */
function heatmap(db, weeks = 18) {
  const today = new Date();
  const from = U.dayKey(U.addDays(today, -(weeks * 7 - 1)));
  const series = dailySeries(db, weeks * 7);
  const goal = db.profile.dailyGoalMin || 120;
  return series.map((r) => {
    const ratio = r.minutes / goal;
    let level = 0;
    if (r.minutes > 0) level = 1;
    if (ratio >= 0.35) level = 2;
    if (ratio >= 0.7) level = 3;
    if (ratio >= 1) level = 4;
    return { date: r.date, minutes: r.minutes, level };
  });
}

/** 一天里各时段的学习分布（近 days 天，按开始小时归桶） */
function hourlyDistribution(db, days = 30) {
  const today = new Date();
  const from = U.dayKey(U.addDays(today, -(days - 1)));
  const buckets = new Array(24).fill(0);
  for (const s of db.sessions || []) {
    const k = sessionDayKey(s);
    if (k < from) continue;
    const h = new Date(s.start).getHours();
    buckets[h] += s.minutes || 0;
  }
  return buckets;
}

/** 连续打卡天数：默认「当天有效学习 ≥ 10 分钟」算打卡 */
function streak(db, minMin = 10) {
  const byDay = new Map();
  for (const s of db.sessions || []) {
    const k = sessionDayKey(s);
    byDay.set(k, (byDay.get(k) || 0) + (s.minutes || 0));
  }
  const today = U.dayKey();
  const has = (k) => (byDay.get(k) || 0) >= minMin;

  let current = 0;
  // 今天还没学不算断，从昨天开始往前数
  let cursor = has(today) ? new Date() : U.addDays(new Date(), -1);
  if (!has(U.dayKey(cursor)) && !has(today)) {
    // 昨天也没学 → 连续为 0
    current = 0;
  } else {
    let guard = 0;
    while (has(U.dayKey(cursor)) && guard++ < 3650) {
      current++;
      cursor = U.addDays(cursor, -1);
    }
  }

  // 历史最长
  const keys = [...byDay.keys()].sort();
  let best = 0, run = 0, prev = null;
  for (const k of keys) {
    if (!has(k)) { run = 0; prev = k; continue; }
    if (prev && U.dayKey(U.addDays(U.parseDayKey(prev), 1)) === k) run++;
    else run = 1;
    best = Math.max(best, run);
    prev = k;
  }
  return { current, best, activeDays: [...byDay.keys()].filter(has).length };
}

/* ------------------------------------------------------------------ *
 * 专注力评分
 * ------------------------------------------------------------------ */

/**
 * 专注力评分（0-100），四个维度加权，全部可解释：
 *   目标达成 45%  —— 每个已过完的日子取 min(1, 当日分钟/日目标)，再求平均
 *   计划执行 30%  —— 期间应做的计划任务里完成的比例
 *   连续专注 15%  —— 1 - min(1, 中断次数 / 场次 / 2)
 *   无欠账   10%  —— 1 - 逾期未完成任务占比
 */
function focusScore(db, fromKey, toKey) {
  const goal = db.profile.dailyGoalMin || 120;
  const todayKey = U.dayKey();
  const effectiveTo = toKey > todayKey ? todayKey : toKey;
  const keys = U.rangeKeys(fromKey, effectiveTo);
  const perDay = new Map(keys.map((k) => [k, 0]));
  for (const s of db.sessions || []) {
    const k = sessionDayKey(s);
    if (perDay.has(k)) perDay.set(k, perDay.get(k) + (s.minutes || 0));
  }
  let goalRate = 0;
  for (const k of keys) goalRate += Math.min(1, perDay.get(k) / goal);
  goalRate = keys.length ? goalRate / keys.length : 0;

  let dueTotal = 0, dueDone = 0, overdue = 0;
  for (const k of keys) {
    for (const row of tasksOn(db, k)) {
      dueTotal++;
      if (row.done) dueDone++;
      else if (k < todayKey) overdue++;
    }
  }
  const planRate = dueTotal ? dueDone / dueTotal : 0;

  const agg = sumRange(db, fromKey, effectiveTo);
  const breakRate = agg.count ? Math.min(1, (agg.interruptions / agg.count) / 2) : 0;
  const debtRate = dueTotal ? Math.min(1, overdue / dueTotal) : 0;

  const score = Math.round(100 * (0.45 * goalRate + 0.30 * planRate + 0.15 * (1 - breakRate) + 0.10 * (1 - debtRate)));

  return {
    score: Math.max(0, Math.min(100, score)),
    parts: {
      goalRate: Math.round(goalRate * 100),
      planRate: Math.round(planRate * 100),
      continuity: Math.round((1 - breakRate) * 100),
      noDebt: Math.round((1 - debtRate) * 100)
    },
    dueTotal, dueDone, overdue,
    days: keys.length
  };
}

/* ------------------------------------------------------------------ *
 * 间隔重复（艾宾浩斯复习）
 * ------------------------------------------------------------------ */

/**
 * 复习间隔（天）。这条序列是间隔重复的核心：
 * 每次成功回忆后，下一次的间隔翻倍左右，把复习点压在「快要忘记但还没忘」的位置。
 * 7 轮走完约 4 个月，此时内容基本进入长期记忆。
 */
const REVIEW_INTERVALS = [1, 2, 4, 7, 15, 30, 60];

function reviewActive(r) { return !r.archived && !r.mastered; }

/** 按 stage 算出下一次复习日期 */
function nextReviewAt(stage, fromKey) {
  const idx = Math.min(Math.max(0, stage), REVIEW_INTERVALS.length - 1);
  return U.dayKey(U.addDays(U.parseDayKey(fromKey), REVIEW_INTERVALS[idx]));
}

/**
 * 推进一个复习项。纯函数：返回 { stage, nextAt, lastAt, mastered, lapses } 之类的增量，
 * 由调用方落到 store。这样算法本身可以脱离存储单测。
 *
 * @param {object} item
 * @param {'good'|'fuzzy'|'forgot'} result
 * @param {string} todayKey
 */
function advanceReview(item, result, todayKey) {
  const stage0 = Math.max(0, item.stage || 0);
  let stage = stage0;
  let mastered = false;
  let lapses = item.lapses || 0;

  if (result === 'good') {
    const next = stage0 + 1;
    if (next >= REVIEW_INTERVALS.length) { mastered = true; stage = REVIEW_INTERVALS.length; }
    else stage = next;
  } else if (result === 'fuzzy') {
    stage = stage0;                 // 保持当前档，用同样的间隔再来一轮
  } else {
    stage = 0;                      // 忘了 → 回到第一档重来
    lapses += 1;
  }

  return {
    stage,
    mastered,
    lapses,
    lastAt: todayKey,
    nextAt: mastered ? null : nextReviewAt(stage, todayKey)
  };
}

/** 今日待复习队列 */
function reviewQueue(db, key) {
  const today = key || U.dayKey();
  const due = [];
  const overdue = [];
  const upcoming = [];
  for (const r of db.reviews || []) {
    if (!reviewActive(r)) continue;
    if (!r.nextAt) continue;
    if (r.nextAt < today) overdue.push(r);
    else if (r.nextAt === today) due.push(r);
    else upcoming.push(r);
  }
  overdue.sort((a, b) => (a.nextAt || '').localeCompare(b.nextAt || ''));
  due.sort((a, b) => b.stage - a.stage);      // 强度高的先过，趁还没忘
  upcoming.sort((a, b) => (a.nextAt || '').localeCompare(b.nextAt || ''));
  return { due, overdue, upcoming, total: due.length + overdue.length };
}

/** 复习整体统计 */
function reviewStats(db, horizonDays = 14) {
  const today = U.dayKey();
  const all = db.reviews || [];
  const active = all.filter(reviewActive);
  const mastered = all.filter((r) => r.mastered && !r.archived);
  const archived = all.filter((r) => r.archived);

  let good = 0, fuzzy = 0, forgot = 0;
  const byStage = new Array(REVIEW_INTERVALS.length + 1).fill(0);
  let reviewedLast7 = 0;
  const weekAgo = U.dayKey(U.addDays(new Date(), -6));

  for (const r of all) {
    for (const hh of r.history || []) {
      if (hh.result === 'good') good++;
      else if (hh.result === 'fuzzy') fuzzy++;
      else forgot++;
      if (hh.date >= weekAgo) reviewedLast7++;
    }
    // 已掌握的单独放在最后一档 —— 之前只统计「在队列中」的条目，
    // 导致图表里「已掌握」永远是 0，而这恰恰是用户最想看到的那根柱子
    if (r.mastered && !r.archived) {
      byStage[REVIEW_INTERVALS.length]++;
    } else if (reviewActive(r)) {
      const s = Math.min(Math.max(0, r.stage || 0), REVIEW_INTERVALS.length - 1);
      byStage[s]++;
    }
  }

  const attempts = good + fuzzy + forgot;
  const retention = attempts ? Math.round((good / attempts) * 100) : null;

  // 未来 N 天的复习负载：间隔重复最怕「某天堆了 40 个」
  const load = [];
  const byDate = new Map();
  for (const r of active) {
    if (!r.nextAt) continue;
    byDate.set(r.nextAt, (byDate.get(r.nextAt) || 0) + 1);
  }
  for (let i = 0; i < horizonDays; i++) {
    const k = U.dayKey(U.addDays(new Date(), i));
    load.push({ date: k, count: byDate.get(k) || 0 });
  }
  // 逾期的一律压在今天，否则图上会出现「今天 0 个但实际有 8 个逾期」
  const q = reviewQueue(db, today);
  if (q.overdue.length) {
    load[0].count += q.overdue.length;
    load[0].overdue = q.overdue.length;
  }

  const busiest = load.reduce((a, b) => (b.count > a.count ? b : a), { count: 0, date: '' });

  return {
    total: all.length,
    active: active.length,
    mastered: mastered.length,
    archived: archived.length,
    attempts, good, fuzzy, forgot,
    retention,
    lapses: all.reduce((a, b) => a + (b.lapses || 0), 0),
    byStage,
    intervals: REVIEW_INTERVALS,
    dueToday: q.due.length,
    overdue: q.overdue.length,
    upcoming: q.upcoming.length,
    reviewedLast7,
    load,
    busiest,
    avgStage: active.length ? Math.round((active.reduce((a, b) => a + (b.stage || 0), 0) / active.length) * 10) / 10 : 0
  };
}

/**
 * 记忆保持曲线（用于「不复习 vs 按计划复习」的对比图）。
 * 用指数遗忘模型 R = e^(-t/S)，S 取该阶段对应的间隔 —— 目的不是精确预测，
 * 而是让「为什么要复习」这件事在图上看得见。
 */
function retentionCurve(stages = 7, days = 30) {
  const noReview = [];
  const withReview = [];
  for (let t = 0; t <= days; t++) {
    noReview.push({ t, r: Math.exp(-t / 1.5) });
    // 按计划复习：在每个复习点回忆成功，遗忘曲线被「重置」到接近 1
    let R = Math.exp(-t / 1.5);
    let acc = 0;
    for (const iv of REVIEW_INTERVALS.slice(0, stages)) {
      acc += iv;
      if (t >= acc) R = Math.exp(-(t - acc) / (1.5 + iv));
    }
    withReview.push({ t, r: R });
  }
  return { noReview, withReview };
}

/* ------------------------------------------------------------------ *
 * 概览 / 周报
 * ------------------------------------------------------------------ */

function overview(db) {
  const now = new Date();
  const ws = db.profile.weekStart;
  const today = U.dayKey(now);
  const weekFrom = U.dayKey(U.startOfWeek(now, ws));
  const weekTo = U.dayKey(U.addDays(U.startOfWeek(now, ws), 6));
  const monthFrom = U.monthKey(now) + '-01';
  const monthTo = today;

  const t = sumRange(db, today, today);
  const w = sumRange(db, weekFrom, weekTo);
  const m = sumRange(db, monthFrom, monthTo);
  const all = sumRange(db, '1970-01-01', '2999-12-31');

  const todayTasks = tasksOn(db, today);
  const weekTasks = [];
  for (const k of U.rangeKeys(weekFrom, today)) weekTasks.push(...tasksOn(db, k));

  return {
    today,
    todayMinutes: t.minutes,
    todaySessions: t.count,
    dailyGoalMin: db.profile.dailyGoalMin,
    todayProgress: Math.min(1, t.minutes / (db.profile.dailyGoalMin || 120)),
    weekMinutes: w.minutes,
    weekSessions: w.count,
    weeklyGoalMin: db.profile.weeklyGoalMin,
    weekProgress: Math.min(1, w.minutes / (db.profile.weeklyGoalMin || 720)),
    monthMinutes: m.minutes,
    totalMinutes: all.minutes,
    totalSessions: all.count,
    streak: streak(db),
    score: focusScore(db, weekFrom, today),
    weekFrom, weekTo,
    todayTasks: todayTasks.map((r) => ({
      taskId: r.task.id, planId: r.plan.id, plan: r.plan.title,
      title: r.task.title, estMin: r.task.estMin, done: r.done, subjectId: r.plan.subjectId
    })),
    weekTaskStats: {
      total: weekTasks.length,
      done: weekTasks.filter((r) => r.done).length
    },
    counts: {
      subjects: (db.subjects || []).length,
      materials: (db.materials || []).length,
      plans: (db.plans || []).filter((p) => p.status === 'active').length,
      reminders: (db.reminders || []).filter((r) => r.enabled).length
    }
  };
}

function weeklyReport(db, offset = 0) {
  const ws = db.profile.weekStart;
  const todayKey = U.dayKey();
  const base = U.addDays(U.startOfWeek(new Date(), ws), offset * 7);
  const from = U.dayKey(base);
  const to = U.dayKey(U.addDays(base, 6));

  // 时长按整周展示（未来天数为 0），但「应做 / 完成 / 逾期」只统计到今天为止。
  // 否则当前周的完成率会被后面还没到的日子摊薄，看起来像「计划执行 0%」。
  const countTo = to > todayKey ? todayKey : to;
  const series = U.rangeKeys(from, to).map((k) => {
    const r = sumRange(db, k, k);
    return { date: k, minutes: r.minutes, sessions: r.count, interruptions: r.interruptions };
  });

  let dueTotal = 0, dueDone = 0, overdue = 0;
  const missed = [];
  for (const k of U.rangeKeys(from, countTo)) {
    for (const row of tasksOn(db, k)) {
      dueTotal++;
      if (row.done) dueDone++;
      else {
        overdue++;
        missed.push({ date: k, title: row.task.title, plan: row.plan.title });
      }
    }
  }
  const agg = sumRange(db, from, to);
  const daysElapsed = Math.max(1, U.rangeKeys(from, countTo).length);
  return {
    from, to, countTo,
    weeklyGoalMin: db.profile.weeklyGoalMin,
    minutes: agg.minutes,
    sessions: agg.count,
    // 日均按「已过的天数」算：当前周还没过完，除以 7 会显得毫无进展
    avgPerDay: Math.round(agg.minutes / daysElapsed),
    daysElapsed,
    activeDays: series.filter((d) => d.minutes > 0).length,
    interruptions: agg.interruptions,
    series,
    subjects: subjectBreakdown(db, from, to),
    tasks: { total: dueTotal, done: dueDone, overdue, rate: dueTotal ? Math.round((dueDone / dueTotal) * 100) : 0 },
    missed: missed.slice(0, 20).reverse(),
    score: focusScore(db, from, to)
  };
}

/* ------------------------------------------------------------------ *
 * 资料体检 & 计划体检
 * ------------------------------------------------------------------ */

function materialReport(db, idleDays) {
  const days = idleDays || db.profile.notify.idleMaterialDays || 30;
  const now = Date.now();
  const neverOpened = [];
  const idle = [];
  const inProgress = [];
  const finished = [];
  let totalMin = 0;

  for (const m of db.materials || []) {
    totalMin += m.timeSpentMin || 0;
    if (!m.openCount) neverOpened.push(m);
    const last = m.lastOpenedAt ? new Date(m.lastOpenedAt).getTime() : (m.createdAt ? new Date(m.createdAt).getTime() : now);
    const idleFor = Math.floor((now - last) / 86400000);
    if (m.openCount && idleFor >= days && m.status !== 'done') idle.push({ ...m, idleFor });
    if (m.status === 'doing') inProgress.push(m);
    if (m.status === 'done') finished.push(m);
  }

  return {
    total: (db.materials || []).length,
    totalMin,
    neverOpened: neverOpened.slice(0, 20).map(brief),
    idle: idle.sort((a, b) => b.idleFor - a.idleFor).slice(0, 20).map((m) => ({ ...brief(m), idleFor: m.idleFor })),
    inProgress: inProgress.slice(0, 20).map(brief),
    finishedCount: finished.length,
    idleDays: days
  };
}

function brief(m) {
  return {
    id: m.id, title: m.title, type: m.type, status: m.status,
    progress: m.progress || 0, subjectId: m.subjectId,
    openCount: m.openCount || 0, timeSpentMin: m.timeSpentMin || 0,
    lastOpenedAt: m.lastOpenedAt || null
  };
}

function planReport(db) {
  const todayKey = U.dayKey();
  const rows = [];
  for (const plan of db.plans || []) {
    let due = 0, done = 0, overdue = 0;
    const overdueList = [];
    for (const task of plan.tasks || []) {
      if (task.archived) continue;
      if (plan.startDate && todayKey < plan.startDate) continue;
      const spanEnd = task.repeat && task.repeat !== 'none'
        ? todayKey
        : (task.date || todayKey);
      for (const k of U.rangeKeys(task.date || plan.startDate || todayKey, spanEnd < todayKey ? spanEnd : todayKey)) {
        if (!taskDueOn(task, plan, k)) continue;
        due++;
        if (taskDoneOn(task, k)) done++;
        else if (k < todayKey) { overdue++; overdueList.push({ date: k, title: task.title, taskId: task.id }); }
      }
    }
    const daysLeft = plan.endDate ? Math.ceil((U.parseDayKey(plan.endDate) - U.parseDayKey(todayKey)) / 86400000) : null;
    rows.push({
      id: plan.id, title: plan.title, subjectId: plan.subjectId, status: plan.status,
      priority: plan.priority, startDate: plan.startDate, endDate: plan.endDate,
      daysLeft, due, done, overdue,
      rate: due ? Math.round((done / due) * 100) : 0,
      milestones: (plan.milestones || []).map((m) => ({ id: m.id, title: m.title, due: m.due, done: !!m.done })),
      overdueList: overdueList.slice(-8),
      risk: overdue >= 5 ? 'high' : overdue >= 2 ? 'mid' : 'low'
    });
  }
  return rows.sort((a, b) => b.overdue - a.overdue || a.priority - b.priority);
}

module.exports = {
  taskDueOn, taskDoneOn, tasksOn,
  sumRange, dailySeries, subjectBreakdown, heatmap, hourlyDistribution,
  streak, focusScore, overview, weeklyReport, materialReport, planReport,
  REVIEW_INTERVALS, reviewActive, nextReviewAt, advanceReview, reviewQueue, reviewStats, retentionCurve
};
