'use strict';
/**
 * scheduler.js —— 应用运行时的提醒调度
 *
 * 规则本身在 src/shared/rules.js（与常驻的提醒守护共用同一份，避免两套规则漂移）。
 * 这里只负责三件事：
 *   1. 定期调用 evaluate()
 *   2. 落「今天已触发」标记（同时读守护进程的记录，避免应用和守护各提醒一次）
 *   3. 处理与实时计时器绑定的规则（这部分只有应用运行时才成立）
 */

const fs = require('fs');
const path = require('path');

const rules = require('../shared/rules');
const A = require('./analytics');
const U = require('./util');

const TICK_MS = 20 * 1000;
const HEARTBEAT_MS = 30 * 1000;
/** 守护进程超过这么久没看到心跳，就认为应用已经退出了 */
const ALIVE_TTL_MS = 90 * 1000;

class Scheduler {
  constructor({ store, notifier, timer, dataDir }) {
    this.store = store;
    this.notifier = notifier;
    this.timer = timer;
    this.dataDir = dataDir || (store ? path.dirname(store.file) : process.cwd());
    this._int = null;
    this._hb = null;
    this.aliveFile = path.join(this.dataDir, 'app-alive.json');
    this.daemonStateFile = path.join(this.dataDir, 'daemon-state.json');
  }

  start() {
    this._bindTimer();
    this._writeHeartbeat();
    this._hb = setInterval(() => this._writeHeartbeat(), HEARTBEAT_MS);
    if (this._hb.unref) this._hb.unref();
    // 启动后 4 秒跑第一次，让界面先渲染出来
    setTimeout(() => this.check(), 4000);
    this._int = setInterval(() => this.check(), TICK_MS);
    if (this._int.unref) this._int.unref();
  }

  stop() {
    if (this._int) { clearInterval(this._int); this._int = null; }
    if (this._hb) { clearInterval(this._hb); this._hb = null; }
    this._clearHeartbeat();
  }

  /* ------------------------------------------------------------------ *
   * 心跳：告诉守护进程「应用正在运行，你别抢着提醒」
   * ------------------------------------------------------------------ */

  _writeHeartbeat() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.aliveFile, JSON.stringify({ pid: process.pid, at: Date.now(), atISO: new Date().toISOString() }), 'utf8');
    } catch (_) {}
  }

  _clearHeartbeat() {
    try { fs.unlinkSync(this.aliveFile); } catch (_) {}
  }

  /* ------------------------------------------------------------------ *
   * 已触发记录：应用自己的 + 守护进程的，取并集
   * ------------------------------------------------------------------ */

  /** 读过守护进程的状态文件（只读，不写 —— 两个进程各写各的文件，不会有写冲突） */
  readDaemonState() {
    try {
      return JSON.parse(fs.readFileSync(this.daemonStateFile, 'utf8'));
    } catch (_) { return null; }
  }

  mergedFired() {
    const mine = this.store.read().scheduler.lastFired || {};
    const theirs = (this.readDaemonState() || {}).fired || {};
    return rules.mergeFired(mine, theirs);
  }

  _mark(key) {
    this.store.update((db) => {
      db.scheduler.lastFired = rules.pruneFired(db.scheduler.lastFired || {});
      db.scheduler.lastFired[key] = U.dayKey();
    });
  }

  /** 把守护进程在应用关闭期间发过的通知补进应用的提醒记录里 */
  syncDaemonLog() {
    const st = this.readDaemonState();
    if (!st || !Array.isArray(st.log) || !st.log.length) return 0;
    const cursor = this.store.read().meta.daemonSeq || 0;
    const fresh = st.log.filter((e) => (e.seq || 0) > cursor);
    if (!fresh.length) return 0;

    for (const e of fresh) {
      this.notifier.history.unshift({
        id: e.id || ('dm_' + e.seq),
        at: e.at,
        kind: e.kind || 'info',
        title: e.title,
        body: e.body,
        route: e.route || '',
        read: false,
        fromDaemon: true
      });
    }
    if (this.notifier.history.length > 200) this.notifier.history.length = 200;

    const maxSeq = fresh.reduce((a, b) => Math.max(a, b.seq || 0), cursor);
    this.store.update((db) => { db.meta.daemonSeq = maxSeq; }, { immediate: true });
    this.notifier.onActivate('history-imported', { count: fresh.length });
    return fresh.length;
  }

  /* ------------------------------------------------------------------ *
   * 扫描
   * ------------------------------------------------------------------ */

  check() {
    const db = this.store.read();
    const now = new Date();

    this.syncDaemonLog();

    const items = rules.evaluate(db, { firedAt: this.mergedFired(), now });
    const fired = [];
    for (const it of items) {
      // 再查一次：本轮前面的规则可能刚刚标记过
      if (this.mergedFired()[it.key] === U.dayKey(now)) continue;
      const sent = this.notifier.send({
        kind: it.kind,
        title: it.title,
        body: it.body,
        route: it.route,
        force: it.force,
        silent: it.silent,
        reason: it.reason
      });
      if (sent) { this._mark(it.key); fired.push(it.key); }
    }

    this._checkTimerGuards(now);

    if (fired.length) this.notifier.onActivate('scheduler', { fired });
    return fired;
  }

  /* ------------------------------------------------------------------ *
   * 番茄钟联动（只有应用运行时才存在这些状态）
   * ------------------------------------------------------------------ */

  _bindTimer() {
    if (!this.timer) return;
    this.timer.on('phase-complete', ({ finished, next, long }) => {
      const label = { focus: '专注', short: '短休', long: '长休' };
      if (finished === 'focus') {
        const st = this.timer.getState();
        this.notifier.send({
          kind: 'timer',
          title: '这一轮专注完成了',
          body: `已记录 ${Math.round((st.phaseTotalMs || 0) / 60000)} 分钟。接下来是${label[next]}${long ? '（长休）' : ''}，离开座位走两步。`,
          route: 'focus',
          force: true
        });
      } else {
        this.notifier.send({
          kind: 'timer',
          title: '休息结束，回来吧',
          body: '新一轮专注已经准备好，点「开始」继续。',
          route: 'focus',
          force: true
        });
      }
    });
  }

  _checkTimerGuards(now) {
    const t = this.timer;
    if (!t) return;
    const st = t.getState();
    if (!st.running) return;
    const cfg = this.store.read().profile.notify;
    const sc = this.store.read().scheduler;

    // 单段专注太久（默认 90 分钟没休息）—— 按「这一段专注」只提醒一次
    if (st.phase === 'focus' && !st.paused && st.mode === 'pomodoro') {
      const overMin = cfg.overrunMin || 90;
      if (st.elapsedMs > overMin * 60000 && sc.overrunAt !== st.startedAt) {
        this.notifier.send({
          kind: 'warn',
          title: `已经连续专注 ${Math.round(st.elapsedMs / 60000)} 分钟`,
          body: '建议停下来休息 5 分钟。继续硬撑，后面效率掉得比休息的损失更大。',
          route: 'focus',
          force: true
        });
        this.store.update((db) => { db.scheduler.overrunAt = st.startedAt; });
      }
    }

    // 休息被无限延长 —— 到点一次、翻倍再一次，不逐分钟刷屏
    if (st.phase !== 'focus' && st.paused) {
      const pausedMin = Math.round((Date.now() - st.pausedAt) / 60000);
      const limit = cfg.breakOverrunMin || 10;
      const stage = pausedMin >= limit * 2 ? 2 : pausedMin >= limit ? 1 : 0;
      if (stage > 0 && (sc.breakOverrunAt !== st.startedAt || (sc.breakOverrunStage || 0) < stage)) {
        this.notifier.send({
          kind: 'warn',
          title: `休息已经 ${pausedMin} 分钟`,
          body: '休息超时是计划崩掉最常见的入口。切回专注吧。',
          route: 'focus',
          force: true
        });
        this.store.update((db) => {
          db.scheduler.breakOverrunAt = st.startedAt;
          db.scheduler.breakOverrunStage = stage;
        });
      }
    }
  }
}

module.exports = { Scheduler, minutesPast: rules.minutesPast, ALIVE_TTL_MS };
