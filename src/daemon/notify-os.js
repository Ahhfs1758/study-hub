'use strict';
/**
 * notify-os.js —— 不依赖 Electron 的系统通知
 *
 * 存在的唯一理由：提醒守护是纯 Node 进程（用 ELECTRON_RUN_AS_NODE 或独立 node 跑），
 * 拿不到 Electron 的 Notification 模块。所以这里直接调系统自带的命令：
 *   macOS   osascript  display notification
 *   Windows powershell 的 toast（Win10+ 自带，无需安装任何模块）
 *   Linux   notify-send
 *
 * 转义是这层的全部技术含量：通知正文里出现引号或反斜杠会把命令拼坏，
 * 最坏情况是「通知发不出去且守护进程静默失败」——用户以为没提醒是他自己没看。
 */

const { execFile } = require('child_process');

/** 把字符串变成可以安全嵌进 AppleScript 双引号字面量的形式 */
function escapeAppleScript(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, ' ');
}

/** 把字符串变成可以安全嵌进 PowerShell 单引号字面量的形式 */
function escapePowerShell(s) {
  return String(s == null ? '' : s)
    .replace(/'/g, "''")
    .replace(/[\r\n]+/g, ' ');
}

/** Toast 的 XML 里还需要再转义一层 XML 实体 */
function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    try {
      const child = execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
        resolve({ ok: !err, error: err ? String(err.message || err) : '', stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
      if (child.stdin) child.stdin.end();
    } catch (err) {
      resolve({ ok: false, error: String(err && err.message || err) });
    }
  });
}

/**
 * 发一条系统通知。
 * @param {{title:string, body:string, subtitle?:string, silent?:boolean, group?:string}} o
 * @param {string} [platform]
 * @returns {Promise<{ok:boolean, via:string, error?:string}>}
 */
async function notify(o, platform = process.platform) {
  const title = String(o.title || '学习中心').slice(0, 200);
  const body = String(o.body || '').slice(0, 600);

  if (platform === 'darwin') {
    const sound = o.silent ? '' : ' sound name "Ping"';
    const script =
      `display notification "${escapeAppleScript(body)}" ` +
      `with title "${escapeAppleScript(title)}"` +
      (o.subtitle ? ` subtitle "${escapeAppleScript(o.subtitle)}"` : '') +
      sound;
    const r = await run('/usr/bin/osascript', ['-e', script]);
    return { ...r, via: 'osascript' };
  }

  if (platform === 'win32') {
    // 用 WinRT Toast。Windows 10 1709+ 自带，不需要 BurntToast 之类的模块。
    const xml =
      `<toast scenario="reminder"><visual><binding template="ToastGeneric">` +
      `<text>${escapeXml(title)}</text>` +
      (body ? `<text>${escapeXml(body)}</text>` : '') +
      `</binding></visual>` +
      (o.silent ? '' : `<audio src="ms-winsoundevent:Notification.Reminder"/>`) +
      `</toast>`;
    const ps = [
      '$ErrorActionPreference = "Stop"',
      '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
      '[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]',
      `$x = New-Object Windows.Data.Xml.Dom.XmlDocument`,
      `$x.LoadXml('${escapePowerShell(xml)}')`,
      `$t = [Windows.UI.Notifications.ToastNotification]::new($x)`,
      `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('tech.studyhub.app').Show($t)`
    ].join('; ');
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], 15000);
    return { ...r, via: 'powershell-toast' };
  }

  if (platform === 'linux') {
    const args = ['-a', '学习中心'];
    if (o.silent) args.push('--hint=string:sound-name:none');
    args.push(title, body);
    const r = await run('notify-send', args);
    return { ...r, via: 'notify-send' };
  }

  return { ok: false, via: 'unsupported', error: '当前平台没有可用的系统通知命令：' + platform };
}

module.exports = { notify, escapeAppleScript, escapePowerShell, escapeXml };
