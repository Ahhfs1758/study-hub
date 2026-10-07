'use strict';
/** 日期/时间工具：一律按「本机本地时区」归日，避免 UTC 跨日把凌晨的学习记到前一天。 */

function pad(n) { return String(n).padStart(2, '0'); }

/** 'YYYY-MM-DD'（本地时区） */
function dayKey(d = new Date()) {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}

/** 'YYYY-MM'（本地时区） */
function monthKey(d = new Date()) {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}`;
}

function parseDayKey(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 0, 0, 0, 0);
}

function startOfDay(d = new Date()) {
  const x = d instanceof Date ? new Date(d) : new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d, n) {
  const x = new Date(d instanceof Date ? d.getTime() : new Date(d).getTime());
  x.setDate(x.getDate() + n);
  return x;
}

/** 按给定「一周从周几开始」求该周第一天 */
function startOfWeek(d = new Date(), weekStart = 1) {
  const x = startOfDay(d);
  const diff = (x.getDay() - weekStart + 7) % 7;
  return addDays(x, -diff);
}

function minutesBetween(a, b) {
  return Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000));
}

/** 生成 [fromKey, toKey] 之间所有日期键（含两端） */
function rangeKeys(fromKey, toKey) {
  const out = [];
  let cur = parseDayKey(fromKey);
  const end = parseDayKey(toKey);
  let guard = 0;
  while (cur <= end && guard++ < 4000) {
    out.push(dayKey(cur));
    cur = addDays(cur, 1);
  }
  return out;
}

function hhmm(d = new Date()) {
  const x = d instanceof Date ? d : new Date(d);
  return `${pad(x.getHours())}:${pad(x.getMinutes())}`;
}

/** 人类可读的时长：95 → '1小时35分' */
function humanMin(min) {
  const m = Math.max(0, Math.round(min || 0));
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} 小时 ${r} 分` : `${h} 小时`;
}

/** 同一自然周判断 */
function isSameWeek(a, b, weekStart = 1) {
  return dayKey(startOfWeek(a, weekStart)) === dayKey(startOfWeek(b, weekStart));
}

module.exports = {
  pad, dayKey, monthKey, parseDayKey, startOfDay, addDays, startOfWeek,
  minutesBetween, rangeKeys, hhmm, humanMin, isSameWeek
};
