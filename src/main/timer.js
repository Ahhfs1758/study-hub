'use strict';
/**
 * timer.js —— 番茄钟 / 正计时状态机
 *
 * 为什么放在主进程：渲染进程在窗口最小化或被系统挂起后计时器会被降频甚至暂停，
 * 而「到点提醒」恰恰发生在你没看窗口的时候。把状态机放在主进程，界面只是显示器，
 * 窗口关到托盘也照样准点响。
 */

const { EventEmitter } = require('events');
const { uid, nowISO } = require('./store');
const { dayKey } = require('./util');

const IDLE = {
  running: false,
  paused: false,
  mode: 'pomodoro',
  phase: 'focus',
  startedAt: 0,
  endsAt: 0,
  elapsedMs: 0,
  pausedTotalMs: 0,
  pausedAt: 0,
  round: 0,
  totalRounds: 0,
  subjectId: '',
  materialId: '',
  planId: '',
  taskId: '',
  interruptions: 0,
  lastEvent: ''
};

class StudyTimer extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.state = Object.assign({}, IDLE);
    this._tick = null;
  }

  /* ------------- 对外接口 ------------- */

  getState() {
    const s = this.state;
    const cfg = this.store.read().profile.pomodoro;
    let remainingMs = 0;
    let elapsedMs = 0;
    if (s.mode === 'pomodoro') {
      const total = this._phaseTotalMs(s.phase, cfg);
      const spent = s.running && !s.paused
        ? Date.now() - s.startedAt - s.pausedTotalMs
        : s.elapsedMs;
      elapsedMs = Math.max(0, spent);
      remainingMs = Math.max(0, total - elapsedMs);
    } else {
      const spent = s.running && !s.paused ? Date.now() - s.startedAt - s.pausedTotalMs : s.elapsedMs;
      elapsedMs = Math.max(0, spent);
      remainingMs = 0;
    }
    return {
      ...s,
      remainingMs,
      elapsedMs,
      phaseTotalMs: s.mode === 'pomodoro' ? this._phaseTotalMs(s.phase, cfg) : 0,
      roundTarget: cfg.roundsBeforeLong,
      serverTime: Date.now()
    };
  }

  start({ mode = 'pomodoro', phase = 'focus', subjectId = '', materialId = '', planId = '', taskId = '' } = {}) {
    const cfg = this.store.read().profile.pomodoro;
    const wasRunning = this.state.running || this.state.elapsedMs > 0;
    // 换科目/换任务时先结算上一段，避免记录串味
    if (wasRunning) this.stop({ reason: 'switch' });

    this.state = Object.assign({}, IDLE, {
      running: true,
      paused: false,
      mode,
      phase: mode === 'pomodoro' ? phase : 'focus',
      startedAt: Date.now(),
      round: this.state.round || 0,
      totalRounds: this.state.totalRounds || 0,
      subjectId, materialId, planId, taskId,
      lastEvent: 'start'
    });
    this.state.endsAt = Date.now() + (mode === 'pomodoro' ? this._phaseTotalMs(this.state.phase, cfg) : 0);
    this._ensureTick();
    this._emit('start');
    return this.getState();
  }

  pause() {
    const s = this.state;
    if (!s.running || s.paused) return this.getState();
    s.elapsedMs = Date.now() - s.startedAt - s.pausedTotalMs;
    if (s.mode === 'pomodoro') s.endsAt = Date.now() + Math.max(0, this._phaseTotalMs(s.phase, this.store.read().profile.pomodoro) - s.elapsedMs);
    s.paused = true;
    s.pausedAt = Date.now();
    s.interruptions += 1;            // 每一次手动暂停计为一次中断，进入专注力评分
    s.lastEvent = 'pause';
    this._emit('pause');
    return this.getState();
  }

  resume() {
    const s = this.state;
    if (!s.running || !s.paused) return this.getState();
    const gap = Date.now() - s.pausedAt;
    s.pausedTotalMs += gap;
    s.pausedAt = 0;
    s.paused = false;
    s.lastEvent = 'resume';
    this._emit('resume');
    return this.getState();
  }

  /** 结束当前这一段：完成的专注会写成学习记录 */
  stop({ reason = 'manual' } = {}) {
    const s = this.state;
    const cfg = this.store.read().profile.pomodoro;
    const wasFocus = s.mode === 'stopwatch' || s.phase === 'focus';
    const elapsed = s.running && !s.paused ? Date.now() - s.startedAt - s.pausedTotalMs : s.elapsedMs;
    const minutes = Math.round(elapsed / 60000);

    let session = null;
    if (wasFocus && minutes >= 1) {
      session = this._recordSession(minutes, reason === 'completed');
    }

    const keepRound = s.mode === 'pomodoro' ? s.round : 0;
    const keepTotal = s.totalRounds;
    this.state = Object.assign({}, IDLE, { round: keepRound, totalRounds: keepTotal, lastEvent: 'stop' });
    this._clearTick();
    this._emit('stop', { session, reason });
    return { state: this.getState(), session };
  }

  reset() {
    this.state = Object.assign({}, IDLE);
    this._clearTick();
    this._emit('reset');
    return this.getState();
  }

  /** 分心计数：界面上「我走神了」按钮 */
  markDistraction() {
    this.state.interruptions += 1;
    this._emit('distraction');
    return this.getState();
  }

  /** app 启动时恢复未走完的一段（崩溃/重启不丢时间） */
  restore() {
    const saved = this.store.read().timer;
    if (!saved || !saved.running) return null;
    // 只恢复 30 分钟内还在跑的时间段，太久远的视为已过期
    if (Date.now() - (saved.startedAt || 0) > 30 * 60 * 1000) {
      this.store.update((db) => { db.timer = null; }, { immediate: true });
      return null;
    }
    this.state = Object.assign({}, IDLE, saved);
    this._ensureTick();
    return this.getState();
  }

  /* ------------- 内部 ------------- */

  _phaseTotalMs(phase, cfg) {
    if (phase === 'focus') return (cfg.focus || 25) * 60000;
    if (phase === 'long') return (cfg.long || 20) * 60000;
    return (cfg.short || 5) * 60000;
  }

  _ensureTick() {
    if (this._tick) return;
    this._tick = setInterval(() => this._onTick(), 1000);
  }

  _clearTick() {
    if (this._tick) { clearInterval(this._tick); this._tick = null; }
  }

  _onTick() {
    const s = this.state;
    if (!s.running) { this._clearTick(); return; }
    if (s.paused) { this._emit('tick'); return; }

    const cfg = this.store.read().profile.pomodoro;
    const elapsed = Date.now() - s.startedAt - s.pausedTotalMs;

    if (s.mode === 'pomodoro' && elapsed >= this._phaseTotalMs(s.phase, cfg)) {
      this._completePhase();
      return;
    }
    // 每 15 秒把计时状态落一次盘，桌面崩溃后能接上
    if (Math.floor(elapsed / 1000) % 15 === 0) {
      const snap = this.getState();
      this.store.update((db) => {
        db.timer = {
          running: snap.running, paused: snap.paused, mode: snap.mode, phase: snap.phase,
          startedAt: snap.startedAt, endsAt: snap.endsAt, elapsedMs: snap.elapsedMs,
          pausedTotalMs: snap.pausedTotalMs, pausedAt: snap.pausedAt,
          round: snap.round, totalRounds: snap.totalRounds,
          subjectId: snap.subjectId, materialId: snap.materialId,
          planId: snap.planId, taskId: snap.taskId, interruptions: snap.interruptions
        };
      });
    }
    this._emit('tick');
  }

  _completePhase() {
    const s = this.state;
    const cfg = this.store.read().profile.pomodoro;

    if (s.phase === 'focus') {
      const minutes = Math.round(this._phaseTotalMs('focus', cfg) / 60000);
      this._recordSession(minutes, true);
      s.round += 1;
      s.totalRounds += 1;
      const long = s.round % (cfg.roundsBeforeLong || 4) === 0;
      s.phase = long ? 'long' : 'short';
      s.lastEvent = 'focus-complete';
      this._emit('phase-complete', { finished: 'focus', next: s.phase, long });
      this._startPhase(s.phase, cfg.autoStartBreak !== false);
    } else {
      const wasLong = s.phase === 'long';
      if (wasLong) s.round = 0;
      s.phase = 'focus';
      s.lastEvent = 'break-complete';
      this._emit('phase-complete', { finished: wasLong ? 'long' : 'short', next: 'focus', long: false });
      this._startPhase('focus', cfg.autoStartFocus === true);
    }
  }

  _startPhase(phase, autoRun) {
    const cfg = this.store.read().profile.pomodoro;
    const s = this.state;
    s.phase = phase;
    s.startedAt = Date.now();
    s.elapsedMs = 0;
    s.pausedTotalMs = 0;
    s.pausedAt = 0;
    s.endsAt = Date.now() + this._phaseTotalMs(phase, cfg);
    s.paused = !autoRun;
    s.running = true;
    if (!autoRun) {
      s.pausedAt = Date.now();
      s.pausedTotalMs = 0;
    }
    this._ensureTick();
    this.store.update((db) => { db.timer = { ...s }; });
    this._emit('tick');
  }

  _recordSession(minutes, completed) {
    const s = this.state;
    const end = new Date();
    const start = new Date(end.getTime() - minutes * 60000);

    // 单次专注的即时评分：完成度 + 中断惩罚
    const plannedMin = s.mode === 'pomodoro' ? Math.round(this._phaseTotalMs(s.phase, this.store.read().profile.pomodoro) / 60000) : minutes;
    const completion = plannedMin ? Math.min(1, minutes / plannedMin) : 1;
    const penalty = Math.min(0.5, s.interruptions * 0.08);
    const score = Math.max(30, Math.min(100, Math.round((completion * 70 + 30) * (1 - penalty))));

    const row = {
      id: uid('ses_'),
      subjectId: s.subjectId || '',
      materialId: s.materialId || '',
      planId: s.planId || '',
      taskId: s.taskId || '',
      start: start.toISOString(),
      end: end.toISOString(),
      minutes,
      mode: s.mode === 'stopwatch' ? 'stopwatch' : 'pomodoro',
      phase: s.mode === 'pomodoro' ? 'focus' : 'free',
      interruptions: s.interruptions,
      completed: !!completed,
      focusScore: score,
      note: ''
    };

    this.store.update((db) => {
      db.sessions.push(row);

      // 资料被使用过：累计投入时长、记录最近打开
      if (row.materialId) {
        const m = db.materials.find((x) => x.id === row.materialId);
        if (m) {
          m.timeSpentMin = (m.timeSpentMin || 0) + minutes;
          m.lastOpenedAt = row.end;
          m.openCount = (m.openCount || 0) + 1;
          if (m.status === 'todo') m.status = 'doing';
        }
      }
      // 任务打卡：把这次专注记到任务上
      if (row.taskId) {
        for (const plan of db.plans) {
          const t = (plan.tasks || []).find((x) => x.id === row.taskId);
          if (!t) continue;
          const key = dayKey(new Date(row.end));       // 本地时区归日
          t.doneDates = t.doneDates || [];
          if (!t.doneDates.includes(key)) t.doneDates.push(key);
          if (t.repeat === 'none' || !t.repeat) { t.done = true; t.doneAt = row.end; }
          break;
        }
      }
      db.timer = null;
    }, { immediate: true });

    return row;
  }

  _emit(name, payload) {
    this.emit(name, payload);
    this.emit('change', { name, payload, state: this.getState() });
  }

  /** 今日已投入（给托盘复用）。归日统一走 dayKey（本地时区），
   *  toLocaleDateString('sv-SE') 在部分系统的 locale 数据缺失时会退化成 en-US，得到 "10/7/2026"。 */
  todayMinutes() {
    const key = dayKey();
    return (this.store.read().sessions || [])
      .filter((s) => dayKey(new Date(s.start)) === key)
      .reduce((a, b) => a + (b.minutes || 0), 0);
  }

  shutdown() {
    this._clearTick();
  }
}

module.exports = { StudyTimer, IDLE, nowISO };
