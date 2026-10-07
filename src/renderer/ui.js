/* ui.js —— 渲染层基础设施：DOM 构造、图标、格式化、浮层、弹窗
   全局挂在 window.SH 上。用经典 <script> 而不是 ES module，是因为 file:// 下
   Chrome 会以 CORS 为由拒绝加载 module 脚本，桌面离线应用没必要为此引构建工具。 */
(function () {
  'use strict';
  const SH = (window.SH = window.SH || {});
  SH.views = SH.views || {};
  SH.api = window.api;

  /* ------------------------------------------------------------------ *
   * DOM
   * ------------------------------------------------------------------ */
  function appendChildren(el, children) {
    for (const c of children) {
      if (c === null || c === undefined || c === false || c === '') continue;
      if (Array.isArray(c)) appendChildren(el, c);
      else if (c instanceof Node) el.appendChild(c);
      else el.appendChild(document.createTextNode(String(c)));
    }
  }

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    appendChildren(el, children);
    return el;
  }

  /** HTML 字符串 → DOM（SVG 也能正确建命名空间） */
  function html(str) {
    const t = document.createElement('template');
    t.innerHTML = String(str).trim();
    return t.content.firstElementChild;
  }
  function htmlAll(str) {
    const t = document.createElement('template');
    t.innerHTML = String(str).trim();
    return t.content;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

  /**
   * 把「可能是节点、可能是 HTML 字符串、可能是文本」的值统一成节点。
   * 存在的理由：图表函数返回的是 SVG 源码字符串，如果直接当子节点塞进 h()，
   * 会被当成纯文本原样显示出来（页面上就会出现一整段 <svg ...> 源码）。
   */
  function node(v) {
    if (v === null || v === undefined || v === false) return document.createTextNode('');
    if (v instanceof Node) return v;
    if (typeof v === 'string' && /^\s*</.test(v)) {
      const el = html(v);
      return el || document.createTextNode(v);
    }
    return document.createTextNode(String(v));
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ------------------------------------------------------------------ *
   * 图标（24×24 线性图标，统一 currentColor）
   * ------------------------------------------------------------------ */
  const P = {
    dashboard: '<rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/>',
    timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9.5V13l2.5 1.6"/><path d="M9.5 2.5h5"/>',
    plan: '<path d="M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1Z"/><path d="M8 6H6.5A1.5 1.5 0 0 0 5 7.5v11A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-11A1.5 1.5 0 0 0 17.5 6H16"/><path d="M9 12l1.6 1.6L14 10"/>',
    material: '<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h2.2c.5 0 1 .24 1.33.65l.94 1.2c.25.3.6.45.97.45h5.56A2.5 2.5 0 0 1 20 9.8v7.7A2.5 2.5 0 0 1 17.5 20h-11A2.5 2.5 0 0 1 4 17.5Z"/>',
    stats: '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>',
    review: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4"/><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2"/>',
    settings: '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h9M17 17h3"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="15" cy="17" r="2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    play: '<path d="M7 4.5l12 7.5-12 7.5z" fill="currentColor" stroke="none"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    edit: '<path d="M4 20h4l10-10-4-4L4 16z"/><path d="M14.5 5.5l4 4"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4A1.5 1.5 0 0 0 16.7 19l.8-12"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="M15.5 15.5L20 20"/>',
    folder: '<path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3l1.5 2h8.5a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
    file: '<path d="M14 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V7.5z"/><path d="M14 3.5V7a1 1 0 0 0 1 1h3"/>',
    book: '<path d="M5 4.5h9.5A2.5 2.5 0 0 1 17 7v13H7.5A2.5 2.5 0 0 1 5 17.5z"/><path d="M17 7h1.5a.5.5 0 0 1 .5.5v11a1 1 0 0 1-1 1H7"/>',
    video: '<rect x="3" y="6" width="12.5" height="12" rx="2.5"/><path d="M15.5 11l4.5-2.8v9.6L15.5 15z"/>',
    link: '<path d="M10 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7L11.3 6.4"/><path d="M14 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.3-1.2"/>',
    note: '<path d="M5 4.5h14v15H5z"/><path d="M8.5 9h7M8.5 12.5h7M8.5 16h4"/>',
    image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M4.5 17l4.5-4.5 3.5 3.5 2.5-2.5 4.5 4.5"/>',
    sheet: '<rect x="4" y="4.5" width="16" height="15" rx="2"/><path d="M4 9.5h16M4 14.5h16M10 4.5v15"/>',
    code: '<path d="M9 8l-4 4 4 4M15 8l4 4-4 4"/>',
    archive: '<rect x="3.5" y="4.5" width="17" height="5" rx="1.5"/><path d="M5.5 9.5v9A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-1.5v-9"/><path d="M11 13h2"/>',
    flame: '<path d="M12 3s5 4 5 9a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5 0 1.5.8 2.5 1.8 2.5C12 9 11 6.5 12 3z"/>',
    star: '<path d="M12 4l2.4 5 5.4.7-3.9 3.7 1 5.4L12 16.2 7.1 18.8l1-5.4L4.2 9.7 9.6 9z"/>',
    calendar: '<rect x="3.5" y="5.5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3.5v4M16 3.5v4"/>',
    bell: '<path d="M18 15.5V11a6 6 0 1 0-12 0v4.5L4.5 18h15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    up: '<path d="M6 15l6-6 6 6"/>',
    download: '<path d="M12 4v11"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M4.5 19.5h15"/>',
    upload: '<path d="M12 15V4"/><path d="M7.5 8.5L12 4l4.5 4.5"/><path d="M4.5 19.5h15"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4.5h-4.5"/>',
    external: '<path d="M14 4.5h5.5V10"/><path d="M19.5 4.5L11 13"/><path d="M18 14.5v4A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6h4"/>',
    alert: '<path d="M12 4.5l8.5 15h-17z"/><path d="M12 10v4.5M12 17.2v.3"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.3"/>',
    sparkle: '<path d="M12 3.5l1.7 4.3 4.3 1.7-4.3 1.7L12 15.5l-1.7-4.3L6 9.5l4.3-1.7z"/><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
    target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
    filter: '<path d="M4 6h16l-6.2 7.3V19l-3.6-1.8v-4z"/>',
    grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
    list: '<path d="M8 6.5h12M8 12h12M8 17.5h12"/><circle cx="4.5" cy="6.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.5" cy="17.5" r="1.2" fill="currentColor" stroke="none"/>',
    eye: '<path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.8"/>',
    wand: '<path d="M5 19l9-9"/><path d="M14.5 5.5l1 2.2 2.2 1-2.2 1-1 2.2-1-2.2-2.2-1 2.2-1z"/><path d="M5 8.5l.6 1.4 1.4.6-1.4.6L5 12.5l-.6-1.4L3 10.5l1.4-.6z"/>',
    pauseCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M10 9.5v5M14 9.5v5"/>',
    moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
    db: '<ellipse cx="12" cy="6.5" rx="7.5" ry="3"/><path d="M4.5 6.5v11c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3v-11"/><path d="M4.5 12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3"/>',
    award: '<circle cx="12" cy="9.5" r="5.5"/><path d="M8.5 14L7 21l5-2.5L17 21l-1.5-7"/>',
    coffee: '<path d="M4 8h12v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M16 9.5h1.8a2.7 2.7 0 0 1 0 5.4H16"/><path d="M4.5 21.5h11"/>'
  };

  const FILLED = { play: 1, stop: 1 };

  function icon(name, size) {
    const d = P[name] || P.info;
    const s = size || 24;
    return `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  }
  /** 返回 DOM 节点形式，方便 h() 直接塞进去 */
  function iconEl(name, size) { return html(icon(name, size)); }

  const MATERIAL_ICON = {
    doc: 'file', slide: 'file', sheet: 'sheet', note: 'note', book: 'book',
    video: 'video', audio: 'flame', image: 'image', archive: 'archive',
    code: 'code', link: 'link', folder: 'folder', other: 'file'
  };
  function materialIcon(type) { return MATERIAL_ICON[type] || 'file'; }

  /* ------------------------------------------------------------------ *
   * 格式化
   * ------------------------------------------------------------------ */
  function pad2(n) { return String(n).padStart(2, '0'); }

  /** 分钟 → 「1 小时 35 分」 */
  function dur(min) {
    const m = Math.max(0, Math.round(min || 0));
    if (m === 0) return '0 分钟';
    if (m < 60) return `${m} 分钟`;
    const hr = Math.floor(m / 60), r = m % 60;
    return r ? `${hr} 小时 ${r} 分` : `${hr} 小时`;
  }
  /** 分钟 → 「1:35」 */
  function hm(min) {
    const m = Math.max(0, Math.round(min || 0));
    return `${Math.floor(m / 60)}:${pad2(m % 60)}`;
  }
  function clock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60), s = total % 60;
    return `${pad2(m)}:${pad2(s)}`;
  }
  function dayKey(d) {
    const x = d ? new Date(d) : new Date();
    return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
  }
  function parseKey(k) { const [y, m, d] = String(k).split('-').map(Number); return new Date(y, m - 1, d); }
  const WD = ['日', '一', '二', '三', '四', '五', '六'];
  function dayLabel(k, withWeek) {
    const t = dayKey();
    const y = dayKey(new Date(Date.now() - 86400000));
    if (k === t) return '今天';
    if (k === y) return '昨天';
    const d = parseKey(k);
    return `${d.getMonth() + 1}月${d.getDate()}日${withWeek ? ' 周' + WD[d.getDay()] : ''}`;
  }
  function relTime(iso) {
    if (!iso) return '从未';
    const diff = Date.now() - new Date(iso).getTime();
    const day = Math.floor(diff / 86400000);
    if (day <= 0) {
      const h = Math.floor(diff / 3600000);
      if (h <= 0) return '刚刚';
      return `${h} 小时前`;
    }
    if (day === 1) return '昨天';
    if (day < 30) return `${day} 天前`;
    if (day < 365) return `${Math.floor(day / 30)} 个月前`;
    return `${Math.floor(day / 365)} 年前`;
  }
  function pct(v) { return `${Math.round((v || 0) * 100)}%`; }

  /* ------------------------------------------------------------------ *
   * 浮层提示
   * ------------------------------------------------------------------ */
  const toastRoot = () => document.getElementById('toasts');
  /** 同时最多显示几个浮层。超出时挤掉最旧的。
   *  必须设上限：定时提醒可能一次命中好几条（任务预警 + 复习到期 + 复盘摘要同时到点），
   *  不设限的话浮层会从屏幕顶端一直铺到中间，把界面全遮住。 */
  const TOAST_MAX = 3;
  const toastKeys = new Map();     // 内容指纹 → 最近一次显示时间，用来合并短时间内的重复内容

  function toast({ title, body, kind, timeout = 7000, onClick }) {
    const root = toastRoot();
    if (!root) return;

    // 15 秒内出现完全相同的内容就不再重复弹（守护进程与应用切换时容易撞车）
    const fp = `${title}|${body}`;
    const last = toastKeys.get(fp) || 0;
    if (Date.now() - last < 15000 && !onClick) return;
    toastKeys.set(fp, Date.now());
    if (toastKeys.size > 60) {
      const cutoff = Date.now() - 60000;
      for (const [k, v] of toastKeys) if (v < cutoff) toastKeys.delete(k);
    }

    const node = h('div', { class: 'toast ' + (kind === 'warn' || kind === 'danger' ? 'danger' : kind || '') },
      h('div', { class: 't-body' },
        h('div', { class: 't-title' }, title),
        body ? h('div', { class: 't-text' }, body) : null),
      h('div', { class: 't-close', html: icon('x', 15), onClick: () => remove() })
    );
    if (onClick) {
      node.style.cursor = 'pointer';
      node.addEventListener('click', (e) => { if (!e.target.closest('.t-close')) { onClick(); remove(); } });
    }
    let killed = false;
    const remove = () => {
      if (killed) return; killed = true;
      node.style.animation = 'fadeout .18s ease forwards';
      // 退场动画结束后才真正摘掉；动画期间只是视觉上淡出
      setTimeout(() => node.remove(), 190);
    };
    root.appendChild(node);

    /* 挤掉最旧的。
       🔴 这里必须**同步**从 DOM 里摘掉，不能用「设个动画、等 190ms 再 remove」那一套：
       因为 children.length 不会当场变小，while 的判断条件永远为真，而 firstElementChild
       始终是同一个元素 —— 整个渲染进程会被这个循环锁死，界面完全无响应。
       实测触发条件很容易达到：一次命中 4 条提醒规则就会走进这个分支。 */
    const excess = root.children.length - TOAST_MAX;
    for (let i = 0; i < excess; i++) {
      const oldest = root.firstElementChild;
      if (!oldest || oldest === node) break;
      oldest.remove();
    }

    if (timeout) setTimeout(remove, timeout);
    return remove;
  }

  /* ------------------------------------------------------------------ *
   * 弹窗
   * ------------------------------------------------------------------ */

  /**
   * @param {object} o
   * @param {() => void} [o.onClose] 弹窗被任何方式关掉时都会调用（点 X / 点遮罩 / 按 Esc）。
   *
   * 🔴 onClose 是必须的：formDialog / confirmDialog 都是「弹窗 + Promise」的组合，
   * 而 Promise 只挂在两个按钮上。少了 onClose，用户点遮罩或按 Esc 关掉弹窗时
   * **Promise 永远不会 resolve** —— 调用方那句 `await` 之后的代码一行都不会执行，
   * 表现为「操作静默失效、没有任何报错」，极难排查。
   */
  function modal({ title, body, footer, wide, onMount, onClose, closable = true }) {
    const root = document.getElementById('modalRoot');
    const dialog = h('div', { class: 'dialog' + (wide ? ' wide' : '') });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      mask.style.animation = 'fadein .12s ease reverse';
      setTimeout(() => mask.remove(), 110);
      document.removeEventListener('keydown', onKey);
      if (onClose) onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape' && closable) close(); };

    const head = h('header', null, h('h3', null, title), h('div', { class: 'grow', style: { flex: '1' } }),
      closable ? h('button', { class: 'btn ghost icon sm', html: icon('x', 15), onClick: close }) : null);
    const bodyEl = h('div', { class: 'dbody' });
    if (typeof body === 'string') bodyEl.innerHTML = body;
    else if (body) bodyEl.appendChild(body);
    dialog.appendChild(head);
    dialog.appendChild(bodyEl);
    if (footer) {
      const f = h('footer');
      if (typeof footer === 'string') f.innerHTML = footer;
      else if (Array.isArray(footer)) footer.forEach((x) => f.appendChild(x));
      else f.appendChild(footer);
      dialog.appendChild(f);
    }
    const mask = h('div', { class: 'mask', onClick: (e) => { if (e.target === mask && closable) close(); } }, dialog);
    root.appendChild(mask);
    document.addEventListener('keydown', onKey);
    if (onMount) onMount({ dialog, body: bodyEl, close });
    return { close, dialog, body: bodyEl };
  }

  function confirmDialog({ title, message, okText = '确定', danger }) {
    return new Promise((resolve) => {
      // settled 是必需的：点「确定」时先 close() 再 resolve(true)，而 close() 会触发
      // onClose → resolve(false)。没有这个闸门的话第一次 resolve 会把后面的覆盖掉，
      // 「确定」反而变成「取消」。
      let settled = false;
      const finish = (v) => { if (settled) return; settled = true; m.close(); resolve(v); };
      const m = modal({
        title,
        body: h('div', { style: { fontSize: '13.5px', lineHeight: '1.7' } }, message),
        onClose: () => { if (!settled) { settled = true; resolve(false); } },
        footer: [
          h('button', { class: 'btn', onClick: () => finish(false) }, '取消'),
          h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onClick: () => finish(true) }, okText)
        ]
      });
    });
  }

  /** 表单弹窗：fields 描述 → 返回 Promise<data|null> */
  function formDialog({ title, fields, okText = '保存', wide }) {
    return new Promise((resolve) => {
      const inputs = {};
      const form = h('div');
      for (const f of fields) {
        if (f.type === 'hidden') { inputs[f.name] = { value: f.value }; continue; }
        let control;
        const common = { class: f.type === 'textarea' ? 'textarea' : 'input' };
        if (f.type === 'textarea') control = h('textarea', { ...common, placeholder: f.placeholder || '' }, f.value || '');
        else if (f.type === 'select') {
          control = h('select', { class: 'select' },
            ...(f.options || []).map((o) => h('option', { value: o.value, selected: String(o.value) === String(f.value) }, o.label)));
        } else if (f.type === 'number') {
          control = h('input', { class: 'input', type: 'number', min: f.min, max: f.max, step: f.step || 1, value: f.value ?? '' });
        } else if (f.type === 'time') {
          control = h('input', { class: 'input', type: 'time', value: f.value || '19:30' });
        } else if (f.type === 'date') {
          control = h('input', { class: 'input', type: 'date', value: f.value || dayKey() });
        } else if (f.type === 'checkbox') {
          control = h('input', { type: 'checkbox', checked: f.value !== false });
        } else if (f.type === 'weekdays') {
          control = h('div', { class: 'seg' }, ...[0, 1, 2, 3, 4, 5, 6].map((i) => {
            const on = (f.value || []).includes(i);
            const b = h('button', { class: 'btn sm' + (on ? ' primary' : ''), type: 'button', dataset: { dow: i } }, '周' + WD[i]);
            b.addEventListener('click', () => {
              b.classList.toggle('primary');
            });
            return b;
          }));
        } else {
          control = h('input', { class: 'input', type: f.type || 'text', value: f.value ?? '', placeholder: f.placeholder || '' });
        }
        inputs[f.name] = control;
        form.appendChild(h('label', { class: 'field' },
          h('span', { class: 'lb' }, f.label),
          f.type === 'checkbox' ? h('div', { class: 'row' }, control, h('span', { class: 'small muted' }, f.hint || '')) : control,
          f.type !== 'checkbox' && f.hint ? h('span', { class: 'hint' }, f.hint) : null));
      }

      const read = () => {
        const out = {};
        for (const f of fields) {
          const c = inputs[f.name];
          if (f.type === 'checkbox') out[f.name] = c.checked;
          else if (f.type === 'number') out[f.name] = c.value === '' ? null : Number(c.value);
          else if (f.type === 'weekdays') out[f.name] = [...c.querySelectorAll('button.primary')].map((b) => Number(b.dataset.dow)).sort();
          else out[f.name] = c.value.trim ? c.value.trim() : c.value;
        }
        return out;
      };

      // 同 confirmDialog：点「确定」会先 close 再 resolve，必须有闸门挡住 onClose 的那次 null
      let settled = false;
      const finish = (v) => { if (settled) return; settled = true; m.close(); resolve(v); };
      const m = modal({
        title, wide,
        body: form,
        onClose: () => { if (!settled) { settled = true; resolve(null); } },
        footer: [
          h('button', { class: 'btn', onClick: () => finish(null) }, '取消'),
          h('button', { class: 'btn primary', onClick: () => finish(read()) }, okText)
        ]
      });
      const first = form.querySelector('input, textarea, select');
      if (first) setTimeout(() => first.focus(), 40);
      const submit = (e) => { if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); finish(read()); } };
      form.addEventListener('keydown', submit);
    });
  }

  /* ------------------------------------------------------------------ *
   * 小组件
   * ------------------------------------------------------------------ */
  function subjectDot(color) { return h('span', { class: 'subj-dot', style: { background: color || '#94a3b8' } }); }

  function empty(text, sub, iconName) {
    return h('div', { class: 'empty' },
      html(icon(iconName || 'sparkle', 40)),
      h('p', null, text),
      sub ? h('small', null, sub) : null);
  }

  function statCard({ label, value, unit, desc, icon: ic, accent, onClick }) {
    return h('div', { class: 'stat' + (accent ? ' accent' : ''), onClick, style: onClick ? { cursor: 'pointer' } : null },
      h('div', { class: 'k' }, ic ? html(icon(ic, 14)) : null, label),
      h('div', { class: 'v' }, String(value), unit ? h('small', null, unit) : null),
      desc ? h('div', { class: 'd', html: desc }) : null);
  }

  function progressBar(ratio, kind) {
    const r = Math.max(0, Math.min(1, ratio || 0));
    return h('div', { class: 'progress' + (kind ? ' ' + kind : '') }, h('i', { style: { width: (r * 100).toFixed(1) + '%' } }));
  }

  function switchRow(label, hint, checked, onChange) {
    const input = h('input', { type: 'checkbox', checked: !!checked });
    input.addEventListener('change', () => onChange(input.checked));
    return h('div', { class: 'set-row' },
      h('div', { class: 's-label' }, h('b', null, label), hint ? h('span', null, hint) : null),
      h('label', { class: 'switch' }, input, h('i')));
  }

  SH.h = h;
  SH.html = html;
  SH.htmlAll = htmlAll;
  SH.clear = clear;
  SH.node = node;
  SH.esc = esc;
  SH.icon = icon;
  SH.iconEl = iconEl;
  SH.materialIcon = materialIcon;
  SH.toast = toast;
  SH.modal = modal;
  SH.confirm = confirmDialog;
  SH.formDialog = formDialog;
  SH.subjectDot = subjectDot;
  SH.empty = empty;
  SH.statCard = statCard;
  SH.progressBar = progressBar;
  SH.switchRow = switchRow;
  SH.fmt = { dur, hm, clock, dayKey, parseKey, dayLabel, relTime, pct, pad2, WD };
})();
