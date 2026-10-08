#!/usr/bin/env node
'use strict';
/**
 * reminder-daemon.js —— 常驻提醒守护
 *
 * 解决的问题：Electron 应用完全退出后，任何进程内定时器都随之消失，
 * 「到点提醒」这个核心功能就断了。这个脚本由系统调度器（macOS launchd /
 * Windows 任务计划）每隔几分钟拉起一次，跑一遍规则、发系统通知、退出。
 * 不需要常驻内存，也不依赖 Electron。
 *
 * 与应用的协作（关键在于「双方各写各的文件」）：
 *   应用 → app-alive.json（心跳，30 秒一次）   应用 → study-hub.json（主数据）
 *   守护 → daemon-state.json（已触发记录 + 通知日志）
 * 两边都读对方，但都不写对方，因此不存在写冲突。合并已触发记录用 rules.mergeFired。
 *
 * 用法：
 *   reminder-daemon.js --once          跑一次扫描（调度器调用的就是这个）
 *   reminder-daemon.js --once --dry-run  只打印将要发的通知，不发、不落盘
 *   reminder-daemon.js --status        打印当前状态
 *   reminder-daemon.js --data-dir <路径>  指定数据目录（默认为各平台的 userData）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const rules = require('../shared/rules');
const { notify } = require('./notify-os');

const MAX_LOG = 300;
/** 心跳超过这个时间没更新，就认为应用已经退出，守护接管 */
const ALIVE_TTL_MS = 90 * 1000;

/* ------------------------------------------------------------------ *
 * 参数与路径
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = { once: false, dryRun: false, status: false, dataDir: '', quiet: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--once') out.once = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--status') out.status = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--force') out.force = true;      // 忽略心跳，强制扫描（自检用）
    else if (a === '--data-dir') out.dataDir = argv[++i] || '';
  }
  return out;
}

/** 与 Electron 的 app.getPath('userData') 保持一致 */
function defaultDataDir() {
  const appName = '学习中心';
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', appName);
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, appName);
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, appName);
}

/* ------------------------------------------------------------------ *
 * 状态文件
 * ------------------------------------------------------------------ */

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) { return fallback; }
}

function writeJSONAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function loadState(file) {
  const st = readJSON(file, null);
  return {
    seq: (st && st.seq) || 0,
    fired: (st && st.fired) || {},
    log: Array.isArray(st && st.log) ? st.log : [],
    runs: (st && st.runs) || 0,
    lastRunAt: (st && st.lastRunAt) || null,
    lastError: (st && st.lastError) || null,
    lastFiredCount: (st && st.lastFiredCount) || 0
  };
}

/* ------------------------------------------------------------------ *
 * 应用是否正在运行
 * ------------------------------------------------------------------ */

function appIsAlive(aliveFile) {
  const info = readJSON(aliveFile, null);
  if (!info || !info.pid || !info.at) return { alive: false, reason: '没有心跳文件' };
  if (Date.now() - info.at > ALIVE_TTL_MS) return { alive: false, reason: '心跳已过期（应用可能已退出）' };
  try {
    process.kill(info.pid, 0);              // 信号 0 = 只探测进程是否存在
    return { alive: true, pid: info.pid };
  } catch (err) {
    if (err && err.code === 'EPERM') return { alive: true, pid: info.pid };  // 存在但无权限，也算活着
    return { alive: false, reason: '心跳里的进程已不存在' };
  }
}

/**
 * 把读到的文件归一化成「一组待检查的空间」。
 *
 * v5 文件是 { tenants, libs, activeTenantId }，每个空间一个独立库；
 * v4 及更早是单库结构（顶层直接就是 reminders / plans / …）。
 *
 * 🔴 为什么要遍历**全部**空间而不是只看当前激活的那个：
 *    应用关掉之后，守护进程是唯一的提醒来源。如果只处理最后打开的空间，
 *    用户在别的空间设的提醒就永远不会响，而且没有任何提示。
 *
 * 已触发记录的键会加上「空间 id::」前缀 —— 否则两个空间里同名的规则键
 * （比如 task_warn、streak_warn 这种固定键）会互相顶掉，
 * 表现为「A 空间发过之后，B 空间同一条规则当天就再也不发了」。
 */
function spacesOf(raw) {
  if (raw && raw.libs && typeof raw.libs === 'object') {
    const list = raw.tenants || [];
    return Object.keys(raw.libs).map((id) => {
      const t = list.find((x) => x.id === id);
      return { id, name: (t && t.name) || id, db: raw.libs[id] };
    });
  }
  return [{ id: '', name: '', db: raw }];
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function run(opts) {
  const dataDir = opts.dataDir || defaultDataDir();
  const dbFile = path.join(dataDir, 'study-hub.json');
  const stateFile = path.join(dataDir, 'daemon-state.json');
  const aliveFile = path.join(dataDir, 'app-alive.json');

  const result = {
    dataDir, dbFile, stateFile,
    ok: false, skipped: '', fired: [], errors: [], at: new Date().toISOString()
  };

  const db = readJSON(dbFile, null);
  if (!db) {
    result.errors.push('读不到主数据文件，可能应用还没第一次启动过：' + dbFile);
    return result;
  }

  const spaces = spacesOf(db);

  const state = loadState(stateFile);
  const now = new Date();

  if (opts.status) {
    const alive = appIsAlive(aliveFile);
    result.ok = true;
    result.status = {
      dataDir,
      dbFound: true,
      appAlive: alive,
      runs: state.runs,
      lastRunAt: state.lastRunAt,
      lastError: state.lastError,
      lastFiredCount: state.lastFiredCount,
      spaces: spaces.map((sp) => sp.name || '(单库)'),
      spaceCount: spaces.length,
      firedKeys: Object.keys(state.fired).length,
      logEntries: state.log.length,
      seq: state.seq,
      platform: process.platform
    };
    return result;
  }

  // 应用正在跑就让位 —— 它有更完整的上下文（计时器状态），也不会有重复通知
  if (!opts.force && !opts.dryRun) {
    const alive = appIsAlive(aliveFile);
    if (alive.alive) {
      result.ok = true;
      result.skipped = `应用正在运行（pid ${alive.pid}），由应用负责提醒`;
      state.runs += 1;
      state.lastRunAt = result.at;
      state.lastError = null;
      state.lastFiredCount = 0;
      writeJSONAtomic(stateFile, state);
      return result;
    }
  }

  let items = [];
  try {
    for (const sp of spaces) {
      const prefix = sp.id ? sp.id + '::' : '';
      /* 把全局的已触发表投影成「这个空间视角」的一份：只留自己的前缀并去掉它，
         这样 rules 内部的「今天是否已发过」判断仍然准确
         （否则每轮都会重新判定为「未发过」，白算一遍）。 */
      const scoped = {};
      for (const [k, v] of Object.entries(state.fired)) {
        if (prefix) {
          if (k.startsWith(prefix)) scoped[k.slice(prefix.length)] = v;
        } else if (!k.includes('::')) {
          scoped[k] = v;
        }
      }
      for (const it of rules.evaluate(sp.db, { firedAt: scoped, now })) {
        items.push(Object.assign({}, it, { key: prefix + it.key, space: sp.name || '' }));
      }
    }
  } catch (err) {
    result.errors.push('规则评估失败：' + String(err && err.stack || err));
    state.runs += 1;
    state.lastRunAt = result.at;
    state.lastError = result.errors[0];
    writeJSONAtomic(stateFile, state);
    return result;
  }

  for (const it of items) {
    if (opts.dryRun) {
      result.fired.push({ ...it, dryRun: true });
      continue;
    }
    const sent = await notify({ title: it.title, body: it.body, silent: it.silent });
    state.seq += 1;
    const entry = {
      seq: state.seq,
      id: 'dm_' + state.seq,
      at: new Date().toISOString(),
      kind: it.kind,
      title: it.title,
      body: it.body,
      route: it.route,
      space: it.space || '',
      reason: it.reason,
      delivered: sent.ok,
      via: sent.via,
      error: sent.ok ? undefined : sent.error
    };
    state.log.unshift(entry);
    if (state.log.length > MAX_LOG) state.log.length = MAX_LOG;
    // 即使系统通知失败也记「已触发」：否则守护每次运行都会重试同一条，
    // 用户会看到同一个提醒反复弹出（或者在被静音的通道上反复失败）
    state.fired[it.key] = require('../main/util').dayKey(now);
    result.fired.push({ ...it, delivered: sent.ok, via: sent.via, error: sent.error });
    if (!sent.ok) result.errors.push(`${it.key}: 系统通知发送失败（${sent.via}）—— ${sent.error}`);
  }

  if (!opts.dryRun) {
    state.fired = rules.pruneFired(state.fired, 120);
    state.runs += 1;
    state.lastRunAt = result.at;
    state.lastFiredCount = result.fired.length;
    state.lastError = result.errors.length ? result.errors[0] : null;
    state.lastPlatform = process.platform;
    try {
      writeJSONAtomic(stateFile, state);
    } catch (err) {
      result.errors.push('写状态文件失败：' + String(err && err.message || err));
    }
  }

  result.ok = result.errors.length === 0;
  return result;
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  // 没给任何动作时默认跑一次，方便调度器配置得简单些
  if (!opts.once && !opts.status && !opts.dryRun) opts.once = true;

  run(opts).then((res) => {
    if (!opts.quiet) {
      if (opts.status) console.log(JSON.stringify(res.status, null, 2));
      else console.log(JSON.stringify(res, null, 2));
    }
    process.exit(res.ok ? 0 : 1);
  }).catch((err) => {
    if (!opts.quiet) console.error('守护进程异常：', err && err.stack || err);
    process.exit(2);
  });
}

module.exports = { run, defaultDataDir, appIsAlive, loadState, ALIVE_TTL_MS };
