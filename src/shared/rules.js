'use strict';
/**
 * rules.js —— 提醒规则的唯一真值
 *
 * 为什么单独抽一层：提醒有两条投递路径 —— 应用运行时由主进程的 scheduler 发，
 * 应用完全退出后由常驻的提醒守护发。如果两处各写一套规则，迟早会不一致
 * （改了应用里的提醒时间，关掉应用后还是按老时间提醒，这种 bug 极难被发现）。
 * 所以规则只在这里定义一次，两边都调 evaluate()。
 *
 * 幂等：入参 firedAt 是 { 规则键: 'YYYY-MM-DD' }，表示「这个规则上次是哪天触发的」。
 * 日频规则用 firedAt[key] === 今天 判断；周频规则自己比日期差。这样同一个引擎
 * 既能表达「每天只提醒一次」，也能表达「每 7 天才提醒一次」。
 *
 * 本模块刻意不依赖 electron，也不依赖任何运行时状态 —— 纯函数，可以脱离应用单测。
 */

const A = require('../main/analytics');
const U = require('../main/util');

const { humanMin } = U;

/** 距离今天的 hh:mm 过了多少分钟；还没到返回 -1 */
function minutesPast(hhmm, now = new Date()) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m) || hhmm === '') return -1;
  const target = new Date(now);
  target.setHours(h, m, 0, 0);
  const diff = Math.floor((now.getTime() - target.getTime()) / 60000);
  return diff >= 0 ? diff : -1;
}

/** 两个日期键相差几天（b - a），都按本地时区 */
function dayDiff(aKey, bKey) {
  return Math.round((U.parseDayKey(bKey) - U.parseDayKey(aKey)) / 86400000);
}

/** 定时提醒今天是否该响 */
function reminderDueToday(r, now) {
  const dow = now.getDay();
  switch (r.repeat) {
    case 'once': return r.date === U.dayKey(now);
    case 'daily': return true;
    case 'weekdays': return dow >= 1 && dow <= 5;
    case 'weekly': return (r.weekdays || []).includes(dow);
    default: return true;
  }
}

/** 定时提醒的正文：能带上一点上下文就带上，比干巴巴一句「该学习了」有用 */
function reminderBody(r, db) {
  if (r.type === 'review') {
    const today = U.dayKey();
    const agg = A.sumRange(db, today, today);
    return agg.minutes
      ? `今天已学 ${humanMin(agg.minutes)}，花一分钟记一下收获与卡点。`
      : '今天还没有学习记录，想想要不要现在补一段。';
  }
  const sub = (db.subjects || []).find((s) => s.id === r.subjectId);
  if (sub) {
    const wkStart = U.dayKey(U.startOfWeek(new Date(), db.profile.weekStart));
    const row = A.subjectBreakdown(db, wkStart, U.dayKey()).find((x) => x.subjectId === sub.id);
    return `本周「${sub.name}」已投入 ${humanMin(row ? row.minutes : 0)}，开始今天的吧。`;
  }
  return '打开学习中心，选一个科目开始计时。';
}

/* ------------------------------------------------------------------ *
 * 规则体
 * ------------------------------------------------------------------ */

/** 一天里已设定好的固定窗口，错过太久就不补 —— 早上 8 点收到「昨晚该复盘」没有意义 */
const CATCH_UP_MIN = 15;
const LATE_WINDOW_MIN = 120;

/**
 * 评估所有「与计时器无关」的提醒规则。
 *
 * @param {object} db   数据快照（只读）
 * @param {object} ctx
 * @param {object} ctx.firedAt  { 规则键: 'YYYY-MM-DD' }
 * @param {Date}   [ctx.now]
 * @param {boolean}[ctx.includeSnoozed] 是否包含需要长冷却的规则（资料闲置等）
 * @returns {Array<{key,kind,title,body,route,force,silent,reason}>}
 */
function evaluate(db, ctx = {}) {
  const now = ctx.now || new Date();
  const firedAt = ctx.firedAt || {};
  const today = U.dayKey(now);
  const out = [];

  const firedToday = (k) => firedAt[k] === today;
  const notifyCfg = (db.profile && db.profile.notify) || {};
  const enabled = notifyCfg.enabled !== false;

  /** 某规则上次触发距今多少天；从未触发返回 Infinity */
  const daysSince = (k) => (firedAt[k] ? dayDiff(firedAt[k], today) : Infinity);

  /* 1) 用户自定义定时提醒 */
  for (const r of db.reminders || []) {
    if (!r.enabled) continue;
    const key = 'rem_' + r.id;
    if (firedToday(key)) continue;
    if (!reminderDueToday(r, now)) continue;
    const late = minutesPast(r.time, now);
    if (late < 0 || late > CATCH_UP_MIN) continue;
    out.push({
      key,
      kind: 'reminder',
      title: late > 2 ? `提醒 · ${r.title}（补）` : `该学习了 · ${r.title}`,
      body: reminderBody(r, db),
      route: r.type === 'review' ? 'review' : 'focus',
      force: true,
      reason: `定时提醒 ${r.time}`
    });
  }

  if (!enabled) return out;   // 用户在设置里关掉了提醒，后面的监督类规则一并停

  /* 2) 今日任务未完成预警 */
  if (notifyCfg.taskReminder) {
    const key = 'task_warn';
    const late = minutesPast(notifyCfg.taskReminderTime, now);
    if (!firedToday(key) && late >= 0 && late <= LATE_WINDOW_MIN) {
      const rows = A.tasksOn(db, today);
      const undone = rows.filter((r) => !r.done);
      const todayMin = A.sumRange(db, today, today).minutes;
      const goal = db.profile.dailyGoalMin || 120;
      if (rows.length && (undone.length || todayMin < goal)) {
        const names = undone.slice(0, 3).map((r) => r.task.title).join('、');
        out.push({
          key,
          kind: 'task',
          title: undone.length ? `今天还有 ${undone.length} 项没打勾` : '任务都完成了，时长还差一点',
          body: undone.length
            ? `未完成：${names}${undone.length > 3 ? ` 等 ${undone.length} 项` : ''}；今日已学 ${humanMin(todayMin)}`
            : `今日已学 ${humanMin(todayMin)}，距离目标还差 ${humanMin(goal - todayMin)}。要不要再来一轮？`,
          route: 'plans',
          reason: '任务预警时间已过'
        });
      }
    }
  }

  /* 3) 连续记录要断了 */
  {
    const key = 'streak_warn';
    const late = minutesPast('21:00', now);
    if (!firedToday(key) && late >= 0 && late <= LATE_WINDOW_MIN) {
      const min = A.sumRange(db, today, today).minutes;
      const st = A.streak(db);
      if (min < 10 && st.current >= 3) {
        out.push({
          key,
          kind: 'warn',
          title: `连续 ${st.current} 天的记录要断了`,
          body: '今天还没开始。哪怕 15 分钟也能把连续记录续上。',
          route: 'focus',
          reason: '连续打卡保护'
        });
      }
    }
  }

  /* 4) 带复习队列的提醒权重最高 —— 间隔重复一旦断档，前面的功夫就白费了 */
  {
    const key = 'review_due';
    const late = minutesPast('19:00', now);
    if (!firedToday(key) && late >= 0 && late <= LATE_WINDOW_MIN) {
      const q = A.reviewQueue(db, today);
      if (q.due.length + q.overdue.length > 0) {
        const n = q.due.length + q.overdue.length;
        out.push({
          key,
          kind: 'task',
          title: `今天有 ${n} 个知识点到复习时间了`,
          body: q.overdue.length
            ? `其中 ${q.overdue.length} 个已经逾期。间隔重复断一天，遗忘速度会明显加快。`
            : `${q.due.slice(0, 3).map((r) => r.title).join('、')}${n > 3 ? ' 等' : ''}。几分钟就能过一遍。`,
          route: 'srs',
          force: true,
          reason: '复习队列到期'
        });
      }
    }
  }

  /* 5) 每日复盘摘要 */
  if (notifyCfg.dailyDigest) {
    const key = 'digest';
    const late = minutesPast(notifyCfg.dailyDigestTime, now);
    if (!firedToday(key) && late >= 0 && late <= 30) {
      const agg = A.sumRange(db, today, today);
      const rows = A.tasksOn(db, today);
      const doneN = rows.filter((r) => r.done).length;
      const goal = db.profile.dailyGoalMin || 120;
      out.push({
        key,
        kind: 'digest',
        title: `今日复盘 · 学了 ${humanMin(agg.minutes)}`,
        body: `${agg.count} 段专注，任务 ${doneN}/${rows.length} 完成。` +
          (agg.minutes >= goal ? '达标了，早点休息。' : `距离目标还差 ${humanMin(goal - agg.minutes)}。`),
        route: 'review',
        force: true,
        reason: '每日复盘时间'
      });
    }
  }

  /* 6) 资料闲置体检（每周一次） */
  if (ctx.includeSnoozed !== false) {
    const key = 'idle_material';
    if (daysSince(key) >= 7 && now.getHours() >= 10) {
      const rep = A.materialReport(db, notifyCfg.idleMaterialDays);
      const n = rep.neverOpened.length + rep.idle.length;
      if (n > 0) {
        out.push({
          key,
          kind: 'idle',
          title: `有 ${n} 份资料在吃灰`,
          body: [
            rep.neverOpened.length ? `${rep.neverOpened.length} 份从没打开过` : '',
            rep.idle.length ? `${rep.idle.length} 份超过 ${notifyCfg.idleMaterialDays} 天没碰` : ''
          ].filter(Boolean).join('；') + '。去资料库处理一下？',
          route: 'materials',
          reason: '资料闲置周检'
        });
      }
    }
  }

  /* 7) 计划风险（每周一次，只报逾期最多的那一个，不刷屏） */
  if (ctx.includeSnoozed !== false) {
    const key = 'plan_risk';
    if (daysSince(key) >= 3) {
      const rows = A.planReport(db).filter((p) => p.overdue >= 3);
      if (rows.length) {
        const worst = rows[0];
        out.push({
          key,
          kind: 'warn',
          title: `计划「${worst.title}」积压了 ${worst.overdue} 项`,
          body: `完成率只有 ${worst.rate}%。积压到这个程度，通常是任务切得太大 —— 建议今天就把它拆小。`,
          route: 'plans',
          reason: '计划逾期积压'
        });
      }
    }
  }

  return out;
}

/** 合并两份「已触发」记录，同一个键取较新的那天 */
function mergeFired(...maps) {
  const out = {};
  for (const m of maps) {
    if (!m || typeof m !== 'object') continue;
    for (const [k, v] of Object.entries(m)) {
      if (!v) continue;
      if (!out[k] || out[k] < v) out[k] = v;
    }
  }
  return out;
}

/** 只保留最近 N 天的触发记录，防止无限增长 */
function pruneFired(firedAt, days = 120) {
  const today = U.dayKey();
  const out = {};
  for (const [k, v] of Object.entries(firedAt || {})) {
    if (!v) continue;
    if (dayDiff(v, today) <= days) out[k] = v;
  }
  return out;
}

module.exports = { evaluate, mergeFired, pruneFired, minutesPast, reminderDueToday, reminderBody, dayDiff, CATCH_UP_MIN, LATE_WINDOW_MIN };
