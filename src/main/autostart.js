'use strict';
/**
 * autostart.js —— 把提醒守护注册成系统级后台任务
 *
 * macOS：写一个 LaunchAgent plist 到 ~/Library/LaunchAgents/，每 5 分钟拉起一次守护。
 *        plist 里用 ELECTRON_RUN_AS_NODE=1 让 Electron 二进制退化成纯 Node 来跑守护脚本
 *        —— 这样不需要用户额外装 Node，也几乎不占内存（一次运行约 80ms）。
 * Windows：用任务计划程序的 MINUTE 触发。任务计划没法给子进程注入环境变量，
 *        所以改成让应用自己以 --reminder-scan 模式启动（主进程里会提前处理并退出），
 *        全程不创建窗口，也就不用写含中文路径的 .bat。
 *
 * 这个模块只做「注册/卸载/查状态」，不关心规则 —— 规则在 src/shared/rules.js。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const LABEL = 'tech.studyhub.reminder';
const WIN_TASK = 'StudyHubReminder';
/** 巡检间隔（秒）。2 分钟对「准点提醒」够用，守护本身也很轻 */
const INTERVAL_SEC = 120;

/** 守护脚本的绝对路径（dev 与打包后都成立） */
function daemonScript() {
  return path.join(__dirname, '..', 'daemon', 'reminder-daemon.js');
}

function plistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', LABEL + '.plist');
}

function run(cmd, args, timeout = 20000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err ? (err.code ?? 1) : 0,
          error: err ? String(err.message || err) : '',
          stdout: String(stdout || '').trim(),
          stderr: String(stderr || '').trim()
        });
      });
    } catch (err) {
      resolve({ ok: false, code: -1, error: String(err && err.message || err), stdout: '', stderr: '' });
    }
  });
}

function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/* ------------------------------------------------------------------ *
 * plist 生成
 * ------------------------------------------------------------------ */

function buildPlist({ execPath, script, dataDir }) {
  const args = [execPath, script, '--once', '--quiet', '--data-dir', dataDir]
    .map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ELECTRON_RUN_AS_NODE</key>
    <string>1</string>
  </dict>
  <key>StartInterval</key>
  <integer>${INTERVAL_SEC}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(dataDir, 'daemon.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(dataDir, 'daemon.err.log'))}</string>
</dict>
</plist>
`;
}

/* ------------------------------------------------------------------ *
 * 对外接口
 * ------------------------------------------------------------------ */

class Autostart {
  /**
   * @param {object} o
   * @param {string} o.dataDir  Electron 的 userData 目录
   * @param {() => string} o.execPath  实际运行的二进制（打包后是 .app 内的可执行文件）
   */
  constructor({ dataDir, execPath }) {
    this.dataDir = dataDir;
    this.getExecPath = execPath;
    this.platform = process.platform;
  }

  get supported() {
    return this.platform === 'darwin' || this.platform === 'win32';
  }

  get plistFile() { return plistPath(); }
  get daemonFile() { return daemonScript(); }

  /** 守护进程自己的状态文件，用于在界面上显示「上次巡检」 */
  daemonState() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dataDir, 'daemon-state.json'), 'utf8'));
    } catch (_) { return null; }
  }

  async detect() {
    const st = this.daemonState();
    const base = {
      platform: this.platform,
      supported: this.supported,
      intervalSec: INTERVAL_SEC,
      execPath: this.getExecPath(),
      daemonScript: this.daemonFile,
      dataDir: this.dataDir,
      installed: false,
      loaded: false,
      method: this.platform === 'darwin' ? 'launchd' : this.platform === 'win32' ? 'schtasks' : 'unsupported',
      file: this.platform === 'darwin' ? this.plistFile : WIN_TASK,
      daemonRuns: st ? st.runs : 0,
      daemonLastRunAt: st ? st.lastRunAt : null,
      daemonLastError: st ? st.lastError : null,
      daemonLastFired: st ? st.lastFiredCount : 0,
      daemonLogCount: st && st.log ? st.log.length : 0,
      detail: ''
    };

    if (this.platform === 'darwin') {
      base.installed = fs.existsSync(this.plistFile);
      if (base.installed) {
        const r = await run('/bin/launchctl', ['print', `gui/${process.getuid ? process.getuid() : 501}/${LABEL}`], 8000);
        base.loaded = r.ok;
        if (!r.ok && r.stderr) base.detail = r.stderr.split('\n')[0];
      }
      return base;
    }

    if (this.platform === 'win32') {
      const r = await run('schtasks', ['/Query', '/TN', WIN_TASK, '/FO', 'LIST'], 15000);
      base.installed = r.ok;
      base.loaded = r.ok;
      if (r.ok) {
        const m = /下次运行时间[:：]\s*(.+)/.exec(r.stdout);
        if (m) base.detail = m[1].trim();
      }
      return base;
    }

    return base;
  }

  async install() {
    if (!this.supported) {
      return { ok: false, message: `当前平台（${this.platform}）暂不支持注册后台提醒。` };
    }
    if (!fs.existsSync(this.daemonFile)) {
      return { ok: false, message: '找不到提醒守护脚本：' + this.daemonFile };
    }
    fs.mkdirSync(this.dataDir, { recursive: true });
    return this.platform === 'darwin' ? this._installMac() : this._installWin();
  }

  async uninstall() {
    if (this.platform === 'darwin') {
      const uid = process.getuid ? process.getuid() : 501;
      await run('/bin/launchctl', ['bootout', `gui/${uid}/${LABEL}`], 10000);
      await run('/bin/launchctl', ['unload', this.plistFile], 10000);
      try { fs.unlinkSync(this.plistFile); } catch (_) {}
      return { ok: true, message: '已取消后台提醒。应用不运行时将不会再收到提醒。' };
    }
    if (this.platform === 'win32') {
      const r = await run('schtasks', ['/Delete', '/TN', WIN_TASK, '/F'], 20000);
      return r.ok
        ? { ok: true, message: '已取消后台提醒。' }
        : { ok: false, message: '删除任务失败：' + (r.error || r.stderr) };
    }
    return { ok: false, message: '当前平台不支持。' };
  }

  async _installMac() {
    const plist = buildPlist({
      execPath: this.getExecPath(),
      script: this.daemonFile,
      dataDir: this.dataDir
    });
    try {
      fs.mkdirSync(path.dirname(this.plistFile), { recursive: true });
      fs.writeFileSync(this.plistFile, plist, 'utf8');
    } catch (err) {
      return { ok: false, message: '写入 LaunchAgent 失败：' + String(err && err.message || err) };
    }

    const uid = process.getuid ? process.getuid() : 501;
    // 先 bootout 一次，避免「已加载」状态下 bootstrap 报 Input/output error
    await run('/bin/launchctl', ['bootout', `gui/${uid}/${LABEL}`], 8000);
    let r = await run('/bin/launchctl', ['bootstrap', `gui/${uid}`, this.plistFile], 15000);
    let via = 'bootstrap';
    if (!r.ok) {
      // 老语法兜底：某些系统（或非 Aqua 会话）下 bootstrap 会失败，load -w 反而可用
      const r2 = await run('/bin/launchctl', ['load', '-w', this.plistFile], 15000);
      via = 'load -w';
      if (!r2.ok) {
        return {
          ok: false,
          message: '注册失败。\n' + (r.stderr || r.error) + '\n' + (r2.stderr || r2.error) +
            '\n\nplist 已经写好，可以在「终端」里手动执行：\nlaunchctl bootstrap gui/$(id -u) ' + this.plistFile
        };
      }
      r = r2;
    }

    const test = await this.runOnce();
    return {
      ok: true,
      message: '已开启后台提醒：系统会每 ' + Math.round(INTERVAL_SEC / 60) + ' 分钟检查一次，应用关掉也能收到提醒。' +
        '\n注册方式：launchctl ' + via +
        (test.ok ? '\n首次巡检已执行：' + (test.summary || '正常') : '\n注意：试跑报错 —— ' + (test.error || test.stderr || '未知原因'))
    };
  }

  async _installWin() {
    const exe = this.getExecPath();
    const tr = `"${exe}" --reminder-scan --quiet --data-dir "${this.dataDir}"`;
    let r = await run('schtasks', ['/Create', '/TN', WIN_TASK, '/SC', 'MINUTE', '/MO', String(Math.max(1, Math.round(INTERVAL_SEC / 60))), '/TR', tr, '/F'], 30000);
    if (!r.ok) {
      return { ok: false, message: '注册任务计划失败：\n' + (r.stderr || r.error) + '\n\n可以手工在「任务计划程序」里创建一个每 ' + Math.round(INTERVAL_SEC / 60) + ' 分钟运行一次的任务，命令：\n' + tr };
    }
    const test = await this.runOnce();
    return {
      ok: true,
      message: '已开启后台提醒：任务计划每 ' + Math.round(INTERVAL_SEC / 60) + ' 分钟检查一次，应用关掉也能收到提醒。' +
        (test.ok ? '\n首次巡检已执行：' + (test.summary || '正常') : '\n注意：试跑报错 —— ' + (test.error || test.stderr || '未知原因'))
    };
  }

  /**
   * 立刻跑一次守护（用于设置页的「测试后台提醒」按钮）。
   * 应用此时正在运行，所以加 --force 让守护无视心跳真的执行一次。
   */
  async runOnce({ force = true } = {}) {
    const exe = this.getExecPath();
    const args = [this.daemonFile, '--once', '--dry-run', '--force', '--data-dir', this.dataDir];
    // dry-run：只验证「能跑通、能读到数据、能算出该发什么」，不真的弹通知、不改状态
    const r = await run(exe, args, 30000);
    let summary = '';
    try {
      const parsed = JSON.parse(r.stdout);
      const n = (parsed.fired || []).length;
      summary = n
        ? `算出 ${n} 条待提醒（当前时刻没有到期规则，属正常）：` + (parsed.fired || []).map((x) => x.title).join('；')
        : '当前没有到期的提醒规则，链路正常';
      if (parsed.errors && parsed.errors.length) summary += '（有告警：' + parsed.errors[0] + '）';
    } catch (_) { summary = r.stdout ? r.stdout.split('\n')[0] : ''; }
    return { ...r, summary };
  }

  /** 读守护写下的通知日志，给设置页展示 */
  daemonLog(limit = 20) {
    const st = this.daemonState();
    return st && Array.isArray(st.log) ? st.log.slice(0, limit) : [];
  }
}

module.exports = { Autostart, LABEL, WIN_TASK, INTERVAL_SEC, buildPlist };
