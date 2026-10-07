'use strict';
/**
 * notifier.js —— 提醒投递
 *
 * 双通道：系统通知（macOS 通知中心 / Windows 操作中心）+ 窗口内浮层。
 * 之所以两条都发：系统通知会被「专注模式 / 请勿打扰」吞掉，窗口内浮层是保底；
 * 反过来，窗口最小化到托盘时窗口内浮层看不见，系统通知是保底。任何一条成功送达即可。
 */

const { Notification } = require('electron');
const { uid, nowISO } = require('./store');

class Notifier {
  constructor({ onActivate, store }) {
    this.onActivate = onActivate || (() => {});
    this.store = store;
    this.history = [];
    this.lastAt = new Map();     // 节流键 → 时间戳
    this.supported = (() => {
      try { return Notification.isSupported(); } catch (_) { return false; }
    })();
  }

  /** 冷却：同一个 key 在 ms 毫秒内只发一次 */
  throttled(key, ms) {
    const last = this.lastAt.get(key) || 0;
    if (Date.now() - last < ms) return true;
    this.lastAt.set(key, Date.now());
    return false;
  }

  /**
   * @param {object} o
   * @param {string} o.title 标题
   * @param {string} o.body  正文
   * @param {string} [o.kind] 分类：reminder | task | digest | idle | timer | warn
   * @param {string} [o.route] 点击后跳转的视图
   * @param {boolean} [o.silent] 是否静音
   * @param {boolean} [o.force] 忽略免打扰与总开关（用于番茄钟到点这类用户主动设置的）
   */
  send(o) {
    const notify = this.store ? this.store.read().profile.notify : { enabled: true, sound: true };
    if (!o.force && notify.enabled === false) return false;

    const item = {
      id: uid('ntf_'), at: nowISO(), kind: o.kind || 'info',
      title: o.title, body: o.body, route: o.route || '', read: false,
      reason: o.reason || ''
    };
    this.history.unshift(item);
    if (this.history.length > 200) this.history.length = 200;

    // 通道一：系统通知
    if (this.supported) {
      try {
        const n = new Notification({
          title: o.title,
          body: o.body,
          silent: o.silent === true || notify.sound === false,
          urgency: o.kind === 'warn' ? 'critical' : 'normal'
        });
        n.on('click', () => this.onActivate('focus', item));
        n.show();
      } catch (_) { /* 系统通知失败不影响窗口内浮层 */ }
    }

    // 通道二：窗口内浮层
    //
    // 注意这里**只**触发 'toast'。早先还额外触发了一个 'history' 事件，
    // 而主进程把两个事件都转发成渲染层的浮层，于是每条通知都会弹出两个一模一样的卡片。
    // 「记录进了历史」这件事不需要通知界面 —— 界面下次取快照时自然能看到。
    this.onActivate('toast', item);
    return true;
  }

  markAllRead() {
    this.history.forEach((h) => { h.read = true; });
  }

  unreadCount() {
    return this.history.filter((h) => !h.read).length;
  }

  /** 「记录已清空」也只通知主进程刷新角标，不弹浮层 */
  clear() {
    this.history = [];
    this.onActivate('history-cleared');
  }
}

module.exports = { Notifier };
