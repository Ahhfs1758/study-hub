/* app.js —— 渲染层主控：路由、状态、事件、常驻 UI */
(function () {
  'use strict';
  const SH = window.SH;
  const api = SH.api;
  const h = SH.h, F = SH.fmt;

  const LEVEL_LABEL = { undergrad: '本科', grad: '研究生', any: '通用' };

  const NAV = [
    { group: '空间' },
    { id: 'spaces', label: '学科空间', icon: 'grid' },
    { group: '学习' },
    { id: 'dashboard', label: '仪表盘', icon: 'dashboard' },
    { id: 'focus', label: '专注', icon: 'timer' },
    { id: 'plans', label: '学习计划', icon: 'plan' },
    { id: 'materials', label: '学习资料', icon: 'material' },
    { id: 'srs', label: '复习', icon: 'review' },
    { group: '回顾' },
    { id: 'stats', label: '时间统计', icon: 'stats' },
    { id: 'review', label: '监督复盘', icon: 'target' },
    { id: 'settings', label: '设置', icon: 'settings' }
  ];
  const NAV_ORDER = ['spaces', 'dashboard', 'focus', 'plans', 'materials', 'srs', 'stats', 'review', 'settings'];

  const MINI_R = 16, MINI_C = 2 * Math.PI * MINI_R;

  const app = {
    current: 'dashboard',
    rendering: false
  };

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */
  async function boot() {
    if (!api) {
      document.getElementById('view').innerHTML =
        '<div class="empty"><p>无法连接主进程</p><small>preload 脚本没有加载成功，请重启应用。</small></div>';
      return;
    }

    const snap = await api.snapshot();
    SH.state = snap;
    SH.state.__unread = snap.unread || 0;

    if (snap.platform === 'darwin') document.body.classList.add('mac');
    else document.body.classList.add('win');

    buildNav();
    bindEvents();
    updateChrome();

    const hash = (location.hash || '').replace('#', '');
    app.current = SH.views[hash] ? hash : 'dashboard';
    await renderCurrent();
  }

  /* ------------------------------------------------------------------ *
   * 导航
   * ------------------------------------------------------------------ */
  function buildNav() {
    const nav = document.getElementById('nav');
    SH.clear(nav);
    NAV.forEach((item) => {
      if (item.group) {
        nav.appendChild(h('div', { class: 'nav-group-label' }, item.group));
        return;
      }
      const node = h('div', { class: 'nav-item', dataset: { view: item.id }, onClick: () => go(item.id) },
        SH.iconEl(item.icon, 17),
        h('span', { style: { flex: '1' } }, item.label),
        h('span', { class: 'badge', style: { display: 'none' } }));
      nav.appendChild(node);
    });
    paintNav();
  }

  function paintNav() {
    const S = SH.state;
    if (!S) return;
    const todayTasks = (S.overview.todayTasks || []).filter((t) => !t.done).length;
    const overdue = (S.__planRisk || 0);
    const neverOpened = (S.__neverOpened || 0);
    const srs = S.review || { dueToday: 0, overdue: 0 };
    const srsDue = (srs.dueToday || 0) + (srs.overdue || 0);

    document.querySelectorAll('.nav-item').forEach((el) => {
      const id = el.dataset.view;
      el.classList.toggle('active', id === app.current);
      const badge = el.querySelector('.badge');
      let text = '', alert = false;
      if (id === 'plans' && todayTasks) text = String(todayTasks);
      if (id === 'materials' && neverOpened) { text = String(neverOpened); alert = true; }
      if (id === 'srs' && srsDue) { text = String(srsDue); alert = srs.overdue > 0; }
      if (id === 'review' && overdue) { text = String(overdue); alert = true; }
      badge.textContent = text;
      badge.style.display = text ? '' : 'none';
      badge.classList.toggle('alert', alert);
    });
  }

  async function go(view) {
    if (!SH.views[view]) return;
    const changed = app.current !== view;
    app.current = view;
    if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
    /* 从**别的**页面进来时给视图一次重置机会（reload 不触发，否则切标签页会被重置掉）。
       视图内部的「上次选了哪个标签 / 哪个筛选」是模块级变量，会一直留着；
       对复习页这种「主视图是今日队列、其次是遗忘曲线」的页面来说，
       停在上次的次要标签就等于用户一进来看到的不是他该看的东西。
       这个钩子让视图自己决定重置什么，比在 app 里硬编码每个视图的变量干净。 */
    if (changed && typeof SH.views[view].onEnter === 'function') {
      try { SH.views[view].onEnter(); } catch (err) { console.error('onEnter 失败', view, err); }
    }
    /* 这里**不**提前 paintNav：导航高亮与页面内容必须同时变化。
       提前高亮会出现「侧栏已经指着新页面、内容还是旧的」这一瞬间，
       和上面标题那个问题是同一类 —— 状态与内容不同步。
       renderCurrent 的 finally 里会统一 paintNav，那时内容已经换好了。 */
    await renderCurrent();
  }

  /* ------------------------------------------------------------------ *
   * 渲染当前视图
   * ------------------------------------------------------------------ */
  async function renderCurrent() {
    const view = SH.views[app.current];
    if (!view) return;

    /* 🔴 正在渲染时**不能直接 return** —— 那会让这次切换彻底丢失。
       真实场景：第一页开始渲染（要几百毫秒）时用户又点了第二页。
       第二页进来被 `return` 弹掉，而 app.current 已经在 go() 里改成第二页了 ——
       结果是「导航高亮在第 2 项，内容还是第 1 项」，而且不会自己恢复，
       得再点一次。这个 bug 是靠「截图截到了上一页」发现的。
       正确做法：记一个待办，等这次渲染收尾后再跑一遍，保证最后一次意图生效。 */
    if (app.rendering) { app._pendingRender = true; return; }
    app.rendering = true;
    const host = document.getElementById('view');
    const scroller = document.getElementById('content');
    const keepScroll = scroller.scrollTop;

    try {
      const extra = view.load ? await view.load(SH.state) : null;
      SH.clear(host);
      view.render(host, SH.state, extra);

      /* 🔴 标题与副标题必须在**内容渲染之后**才更新。
         早先它们写在 `await view.load()` 之前，于是加载那几百毫秒里
         界面是自相矛盾的：标题已经写着新页面，内容还是旧页面。
         用户切到「复习」时先看到「复习」两个字和上一页的图表，看着像卡死；
         真机测试里更麻烦 —— 它「等标题变成新页面」然后就截图，
         拍到的是旧内容（截图截错页，比断言失败更难发现）。
         改成同帧更新：标题、副标题、内容一起换。 */
      document.getElementById('viewTitle').textContent = view.title;
      const subEl = document.getElementById('viewSub');
      subEl.textContent = typeof view.sub === 'function' ? view.sub(SH.state) : (view.sub || '');

      /* 入场动画只在「切换到另一个页面」时播一次。
         reload（同一个页面重渲染，比如勾完任务后刷新）不播 —— 否则每勾一下
         整个页面就重新浮上来一次，高频操作时会变得很吵。 */
      if (app._lastRendered !== app.current) {
        host.classList.add('view-enter');
        // 动画结束后摘掉，避免它一直挂在 DOM 上影响后续 reload 的重绘判断
        setTimeout(() => host.classList.remove('view-enter'), 500);
      }
      app._lastRendered = app.current;
      if (app.current === 'focus') view.onTick && view.onTick(SH.state.timer);
    } catch (err) {
      SH.clear(host);
      host.appendChild(h('div', { class: 'card' },
        h('div', { class: 'card-body' },
          h('div', { style: { fontWeight: '600', marginBottom: '6px', color: 'var(--danger)' } }, '这个页面出错了'),
          h('div', { class: 'small mono', style: { whiteSpace: 'pre-wrap', color: 'var(--text-2)' } }, String(err && err.stack || err)),
          h('div', { style: { marginTop: '12px' } },
            h('button', { class: 'btn', onClick: () => renderCurrent() }, '重试'),
            ' ',
            h('button', { class: 'btn ghost', onClick: () => go('dashboard') }, '回仪表盘')))));
      console.error(err);
    } finally {
      app.rendering = false;
      scroller.scrollTop = keepScroll;
      await refreshDerived();
      paintNav();
      updateChrome();
      // 期间有人要求过重绘（见上面那段说明）：现在补上，别把它丢掉
      if (app._pendingRender) {
        app._pendingRender = false;
        await renderCurrent();
      }
    }
  }

  /** 顶栏与角标需要的额外数据（失败不影响主流程） */
  async function refreshDerived() {
    try {
      const [planRep, matRep] = await Promise.all([api.stats.planReport(), api.stats.materialReport()]);
      SH.state.__planRisk = planRep.reduce((a, b) => a + b.overdue, 0);
      SH.state.__neverOpened = matRep.neverOpened.length;
      SH.state.__matReport = matRep;
    } catch (_) {}
  }

  /** 重新拉取完整快照再渲染（有数据变更时用） */
  async function refresh() {
    try {
      const snap = await api.snapshot();
      SH.state = Object.assign(SH.state || {}, snap);
    } catch (_) {}
    await renderCurrent();
  }

  /** 只重绘，不重新取数（筛选、展开这类纯 UI 变化用） */
  async function reload() { await renderCurrent(); }

  async function startFocus(opts) {
    await api.timer.start({ mode: 'pomodoro', phase: 'focus', ...opts });
    if (app.current === 'focus') await refresh();
    else await go('focus');
  }

  /* ------------------------------------------------------------------ *
   * 常驻 UI
   * ------------------------------------------------------------------ */
  function updateChrome() {
    const S = SH.state;
    if (!S) return;
    const ov = S.overview;

    document.getElementById('brandSub').textContent =
      ov.todayMinutes ? `今日已学 ${F.dur(ov.todayMinutes)}` : '今天也要专注';

    const m = document.getElementById('topMetrics');
    SH.clear(m);
    const goalRatio = Math.min(1, ov.todayMinutes / (ov.dailyGoalMin || 1));
    m.appendChild(h('div', { style: { textAlign: 'right' } },
      h('div', { style: { fontSize: '15px', fontWeight: '650', letterSpacing: '-.3px' } }, F.dur(ov.todayMinutes)),
      h('div', { class: 'small muted' }, `目标 ${F.hm(ov.dailyGoalMin)} 小时:分 · ${Math.round(goalRatio * 100)}%`)));
    m.appendChild(h('div', { style: { width: '1px', height: '26px', background: 'var(--border)' } }));
    m.appendChild(h('div', { style: { textAlign: 'right' } },
      h('div', { style: { fontSize: '15px', fontWeight: '650' } }, `${ov.streak.current} 天`),
      h('div', { class: 'small muted' }, `连续打卡 · 最长 ${ov.streak.best}`)));
    m.appendChild(h('div', { style: { width: '1px', height: '26px', background: 'var(--border)' } }));
    m.appendChild(h('button', {
      class: 'btn ghost icon', title: '提醒记录',
      html: SH.icon('bell', 17) + (SH.state.__unread ? '<span style="position:absolute;top:2px;right:2px;width:7px;height:7px;border-radius:50%;background:var(--danger)"></span>' : ''),
      style: { position: 'relative' },
      onClick: showHistory
    }));

    paintMiniTimer(S.timer);
    paintSpaceSwitch(S);
  }

  /* ------------------------------------------------------------------ *
   * 学科空间切换器
   * ------------------------------------------------------------------ */

  function paintSpaceSwitch(S) {
    const box = document.getElementById('spaceSwitch');
    if (!box || !S) return;
    const t = S.activeTenant || (S.tenants || [])[0];
    if (!t) return;
    const st = (S.tenantStats || {})[t.id] || {};
    SH.clear(box);
    box.appendChild(h('span', { class: 'ss-dot', style: { background: t.color } }));
    box.appendChild(h('div', { class: 'ss-text' },
      h('b', null, t.name),
      h('span', null, `${LEVEL_LABEL[t.level] || '通用'} · 科目 ${st.subjects || 0} · 待复习 ${st.reviews || 0}`)));
    box.appendChild(h('span', { class: 'ss-caret' }, '\u25bc'));
    box.title = `${t.name}${t.field ? ' · ' + t.field : ''} —— 点这里切换学科空间`;
    if (!box._bound) { box.addEventListener('click', openSpaceMenu); box._bound = true; }
  }

  let spacePop = null;

  function closeSpaceMenu() {
    if (!spacePop) return;
    spacePop.remove();
    spacePop = null;
    document.removeEventListener('click', onOutsideClick, true);
  }

  function onOutsideClick(e) {
    if (!spacePop) return;
    if (spacePop.contains(e.target)) return;
    if (e.target.closest && e.target.closest('#spaceSwitch')) return;
    closeSpaceMenu();
  }

  function openSpaceMenu() {
    if (spacePop) { closeSpaceMenu(); return; }
    const S = SH.state;
    const list = S.tenants || [];
    const pop = h('div', { class: 'space-pop' });
    pop.appendChild(h('div', { class: 'space-pop-head' }, `学科空间 · 共 ${list.length} 个`));

    list.forEach((t) => {
      const st = (S.tenantStats || {})[t.id] || {};
      const on = t.id === S.activeTenantId;
      pop.appendChild(h('div', {
        class: 'space-item' + (on ? ' on' : ''),
        title: t.blurb || '',
        onClick: async () => {
          closeSpaceMenu();
          if (on) return;
          const r = await api.tenants.switch(t.id);
          if (r && r.ok === false) {
            SH.toast({ title: '暂时不能切换', body: r.message, kind: 'warn', timeout: 6000 });
            return;
          }
          await SH.app.refresh();
          SH.toast({
            title: `已切到「${t.name}」`,
            body: `科目 ${st.subjects || 0} · 待复习 ${st.reviews || 0} · 累计 ${F.dur(st.minutes || 0)}`,
            kind: 'ok',
            timeout: 4000
          });
        }
      },
        h('span', { class: 'ss-dot', style: { background: t.color } }),
        h('div', { class: 'si-body' },
          h('b', null, t.name),
          h('small', null, `${LEVEL_LABEL[t.level] || '通用'}${t.field ? ' · ' + t.field : ''} · 科目 ${st.subjects || 0}`)),
        on ? h('span', { class: 'chip ok', style: { height: '17px', fontSize: '10px', padding: '0 6px' } }, '当前') : null));
    });

    pop.appendChild(h('div', { class: 'space-pop-foot' },
      h('div', { class: 'space-item', onClick: () => { closeSpaceMenu(); go('spaces'); } },
        SH.iconEl('grid', 15),
        h('div', { class: 'si-body' },
          h('b', null, '管理学科空间'),
          h('small', null, '新建 · 重命名 · 从 15 个跨学科模板创建')))));

    document.body.appendChild(pop);
    const anchor = document.getElementById('spaceSwitch').getBoundingClientRect();
    pop.style.left = Math.round(anchor.left) + 'px';
    pop.style.top = Math.round(anchor.bottom + 6) + 'px';
    // 超出视口就上翻，避免浮层被切掉
    const rect = pop.getBoundingClientRect();
    if (rect.bottom > window.innerHeight - 8) {
      pop.style.top = Math.max(8, Math.round(anchor.top - rect.height - 6)) + 'px';
    }
    spacePop = pop;
    // 延到下一个 tick 再挂 —— 否则这次点击自己就把浮层关掉了
    setTimeout(() => document.addEventListener('click', onOutsideClick, true), 0);
  }

  function paintMiniTimer(st) {
    const box = document.getElementById('miniTimer');
    const timeEl = document.getElementById('miniTime');
    const labelEl = document.getElementById('miniLabel');
    const ring = document.getElementById('miniRing');
    const btn = document.getElementById('miniToggle');
    if (!box || !st) return;

    box.classList.toggle('live', !!st.running);
    if (st.running) {
      if (st.mode === 'pomodoro') {
        timeEl.textContent = F.clock(st.remainingMs);
        const ratio = st.phaseTotalMs ? st.remainingMs / st.phaseTotalMs : 0;
        ring.setAttribute('stroke-dasharray', `${MINI_C.toFixed(1)} ${MINI_C.toFixed(1)}`);
        ring.setAttribute('stroke-dashoffset', (MINI_C * (1 - ratio)).toFixed(1));
      } else {
        timeEl.textContent = F.clock(st.elapsedMs);
        ring.setAttribute('stroke-dashoffset', '0');
      }
      ring.setAttribute('stroke', st.phase === 'focus' ? '#3b5bfd' : '#0f9d6e');
      const subj = (SH.state.db.subjects || []).find((s) => s.id === st.subjectId);
      labelEl.textContent = (st.paused ? '已暂停 · ' : '') +
        (st.phase === 'focus' ? '专注中' : st.phase === 'long' ? '长休息' : '短休息') +
        (subj ? ' · ' + subj.name : '');
      btn.innerHTML = SH.icon(st.paused ? 'play' : 'pause', 13);
      btn.title = st.paused ? '继续' : '暂停';
    } else {
      timeEl.textContent = '--:--';
      labelEl.textContent = '未开始 · 点右侧开始';
      ring.setAttribute('stroke-dashoffset', '0');
      ring.setAttribute('stroke', '#c7d2fe');
      btn.innerHTML = SH.icon('play', 13);
      btn.title = '开始专注（⌘⇧S）';
    }
  }

  async function toggleTimer() {
    const st = SH.state.timer;
    if (!st.running) { await startFocus({ subjectId: st.subjectId || '', materialId: st.materialId || '' }); return; }
    if (st.paused) await api.timer.resume();
    else await api.timer.pause();
  }

  /* ------------------------------------------------------------------ *
   * 提醒记录
   * ------------------------------------------------------------------ */
  async function showHistory() {
    const history = await api.notify.history();
    const body = h('div');
    if (!history.length) {
      body.appendChild(SH.empty('还没有收到过提醒', '系统通知和窗口浮层的内容都会记在这里。', 'bell'));
    } else {
      const list = h('div', { class: 'list' });
      history.slice(0, 60).forEach((n) => {
        list.appendChild(h('div', { class: 'list-item' },
          h('span', { class: 'chip ' + (n.kind === 'warn' ? 'danger' : n.kind === 'task' || n.kind === 'idle' ? 'warn' : n.kind === 'timer' ? 'accent' : '') },
            n.kind === 'timer' ? '计时' : n.kind === 'task' ? '任务' : n.kind === 'digest' ? '复盘' : n.kind === 'idle' ? '资料' : n.kind === 'reminder' ? '提醒' : '提示'),
          h('div', { style: { flex: '1', minWidth: 0 } },
            h('div', { class: 'li-title' }, n.title),
            h('div', { class: 'li-sub' }, n.body)),
          h('span', { class: 'small muted nowrap' }, F.relTime(n.at))));
      });
      body.appendChild(list);
    }
    await api.notify.read();
    SH.app.refresh();

    const mo = SH.modal({
      title: '提醒记录',
      body,
      wide: true,
      footer: [h('button', { class: 'btn', onClick: async () => { await api.notify.clear(); mo.close(); } }, '清空记录')]
    });
  }

  /* ------------------------------------------------------------------ *
   * 事件
   * ------------------------------------------------------------------ */
  function bindEvents() {
    api.on.timer((st) => {
      if (!SH.state) return;
      SH.state.timer = st;
      paintMiniTimer(st);
      const v = SH.views[app.current];
      if (app.current === 'focus' && v && v.onTick) v.onTick(st);
    });

    // 主进程每次写数据都会推一份全量快照来。番茄钟每秒的 tick 走 timer 通道，
    // 但开始/暂停/结束也会连带触发 data 推送 —— 这里做 120ms 合流，避免连续重绘闪屏。
    let dataTimer = null;
    api.on.data((snap) => {
      const nextTimer = snap.timer;
      SH.state = Object.assign(SH.state || {}, snap);
      SH.state.timer = nextTimer || (SH.state.timer || null);
      updateChrome();
      paintNav();
      clearTimeout(dataTimer);
      dataTimer = setTimeout(() => { renderCurrent(); }, 120);
    });

    api.on.toast((payload) => {
      if (!payload || !payload.title) return;
      SH.toast({
        title: payload.title,
        body: payload.body,
        kind: payload.kind === 'warn' ? 'warn' : payload.kind === 'ok' ? 'ok' : 'info',
        timeout: payload.kind === 'timer' ? 12000 : 8000,
        onClick: payload.route ? () => go(payload.route) : undefined
      });
    });

    api.on.navigate((view) => { if (view) go(view); });

    document.getElementById('miniToggle').addEventListener('click', toggleTimer);

    window.addEventListener('hashchange', () => {
      const v = (location.hash || '').replace('#', '');
      if (SH.views[v] && v !== app.current) go(v);
    });

    // 主进程菜单里的 ⌘1~⌘8
    window.addEventListener('keydown', (e) => {
      const v = SH.views[app.current];

      // 复习页的 1/2/3 评分优先，避免和视角切换冲突
      if (!e.metaKey && !e.ctrlKey && !e.altKey && v && v.onKey && v.onKey(e)) {
        e.preventDefault();
        return;
      }
      if (e.metaKey && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        go(NAV_ORDER[Number(e.key) - 1]);
      }
    });
  }

  SH.app = {
    go, refresh, reload, startFocus,
    /** 内部状态快照。给真机测试用 —— 「连续切视图丢帧」这类问题
        只看最终画面无法判断是「第二次请求被丢了」还是「补跑没发生」，
        必须把 current / rendering / pending 三个变量一起看。 */
    _debug: () => ({
      current: app.current,
      rendering: app.rendering,
      pending: !!app._pendingRender,
      lastRendered: app._lastRendered,
      hash: location.hash,
      title: (document.getElementById('viewTitle') || {}).textContent || ''
    }),
    switchSpace: async (id) => {
      const r = await api.tenants.switch(id);
      if (r && r.ok === false) { SH.toast({ title: '暂时不能切换', body: r.message, kind: 'warn', timeout: 6000 }); return r; }
      await refresh();
      return r;
    },
    previewById: (id) => SH.previewUI.byId(id),
    previewMaterial: (id, probe) => SH.previewUI.dispatch(id, probe),
    state: () => SH.state
  };
  window.addEventListener('DOMContentLoaded', () => { boot(); });
})();
