/* views/focus.js —— 专注：番茄钟 / 正计时，以及今天的每一段记录 */
(function () {
  'use strict';
  const SH = window.SH;
  const h = SH.h, api = SH.api, F = SH.fmt;

  const PHASE_LABEL = { focus: '专注中', short: '短休息', long: '长休息' };
  const PHASE_HINT = {
    focus: '把手机翻过来，只做这一件事',
    short: '站起来走两步，看看远处',
    long: '离开桌子，喝点水，让眼睛休息'
  };

  const view = {
    title: '专注',
    sub: () => '番茄钟到点会给你系统通知，窗口关掉也照样响',
    _refs: {},

    async load(S) {
      const today = F.dayKey();
      const [sessions, tasks] = await Promise.all([
        api.sessions.list({ from: today, to: today }),
        api.plans.today(today)
      ]);
      return { sessions: sessions.slice().reverse(), tasks };
    },

    render(root, S, x) {
      view._refs = {};
      root.appendChild(h('div', { class: 'grid g-1-2' },
        h('div', { class: 'card timer-card' }, ...dialChildren(S)),
        h('div', {}, settingsCard(S, x), materialQuickCard(S))));
      root.appendChild(h('h2', { class: 'section' }, `今天的学习记录（${F.dur(x.sessions.reduce((a, b) => a + b.minutes, 0))}）`));
      root.appendChild(sessionList(S, x.sessions));
    },

    onTick(st) { paintDial(st); }
  };

  /* ------------------------------------------------------------------ *
   * 计时盘
   * ------------------------------------------------------------------ */
  const R = 108, CIRC = 2 * Math.PI * R;

  function dialChildren(S) {
    const st = S.timer;
    const label = h('div', { class: 'timer-phase' }, PHASE_LABEL[st.phase] || '准备就绪');
    const ring = SH.html(`<svg viewBox="0 0 250 250" width="250" height="250">
      <circle cx="125" cy="125" r="${R}" fill="none" stroke="#eef1f6" stroke-width="12"/>
      <circle id="dialArc" cx="125" cy="125" r="${R}" fill="none" stroke="#3b5bfd" stroke-width="12"
        stroke-linecap="round" stroke-dasharray="${CIRC.toFixed(1)} ${CIRC.toFixed(1)}" stroke-dashoffset="0"/>
    </svg>`);
    const num = h('div', { class: 'tnum', id: 'dialTime' }, '25:00');
    const sub = h('div', { class: 'tsub', id: 'dialSub' }, st.mode === 'stopwatch' ? '正计时' : `${S.db.profile.pomodoro.focus} 分钟 · 番茄钟`);
    const center = h('div', { class: 'dial-center' }, num, sub);
    const dial = h('div', { class: 'timer-dial' }, ring, center);

    const dots = h('div', { class: 'round-dots', id: 'roundDots' });

    const actions = h('div', { class: 'timer-actions', id: 'timerActions' });

    const meta = h('div', { class: 'focus-meta', id: 'timerMeta' });

    const wrap = [label, dial, dots, actions, meta];
    setTimeout(() => { paintDial(S.timer); }, 0);
    return wrap;
  }

  function paintDial(st) {
    const arc = document.getElementById('dialArc');
    const num = document.getElementById('dialTime');
    const sub = document.getElementById('dialSub');
    const dots = document.getElementById('roundDots');
    const actions = document.getElementById('timerActions');
    const meta = document.getElementById('timerMeta');
    const phaseLabel = document.querySelector('.timer-phase');
    const S = SH.state;
    if (!arc || !num || !S) return;

    const total = st.mode === 'pomodoro' ? st.phaseTotalMs : 0;
    let ratio = 1;
    let display = '';
    if (st.mode === 'pomodoro') {
      ratio = total ? st.remainingMs / total : 0;
      display = F.clock(st.remainingMs);
    } else {
      const target = 60 * 60000;
      ratio = 1 - Math.min(1, st.elapsedMs / target);
      display = F.clock(st.elapsedMs);
    }
    arc.setAttribute('stroke-dashoffset', (CIRC * (1 - ratio)).toFixed(1));
    const col = st.phase === 'focus' ? '#3b5bfd' : '#0f9d6e';
    arc.setAttribute('stroke', st.paused && st.running ? '#c7d2fe' : col);
    num.textContent = display;
    num.style.color = st.paused && st.running ? 'var(--muted)' : 'var(--text)';

    if (phaseLabel) {
      phaseLabel.textContent = !st.running
        ? (st.mode === 'stopwatch' ? '正计时待机' : '准备就绪')
        : st.paused ? '已暂停' : (PHASE_LABEL[st.phase] || '进行中');
    }
    if (sub) {
      const subj = (S.db.subjects || []).find((s) => s.id === st.subjectId);
      sub.textContent = subj ? subj.name : (st.mode === 'stopwatch' ? '正计时 · 不设上限' : `${S.db.profile.pomodoro.focus} 分钟 · 番茄钟`);
    }

    // 轮次点
    if (dots) {
      const target = S.db.profile.pomodoro.roundsBeforeLong || 4;
      SH.clear(dots);
      for (let i = 0; i < target; i++) {
        dots.appendChild(h('i', { class: i < (st.round % target) || (st.round > 0 && st.round % target === 0 && i < target && st.phase !== 'focus') ? 'on' : '' }));
      }
    }

    // 按钮
    if (actions) {
      SH.clear(actions);
      if (!st.running) {
        actions.appendChild(h('button', { class: 'btn primary lg', html: SH.icon('play', 16) + '<span style="margin-left:6px">开始专注</span>', onClick: () => startNow('pomodoro', 'focus') }));
        actions.appendChild(h('button', { class: 'btn lg', onClick: () => startNow('stopwatch') }, '正计时'));
      } else {
        if (st.paused) {
          actions.appendChild(h('button', { class: 'btn primary lg', onClick: async () => { await api.timer.resume(); } }, '继续'));
        } else {
          actions.appendChild(h('button', { class: 'btn lg', onClick: async () => { await api.timer.pause(); } }, '暂停'));
        }
        actions.appendChild(h('button', { class: 'btn lg', onClick: () => stopSession() }, st.paused ? '结束并记录' : '结束并记录'));
        actions.appendChild(h('button', { class: 'btn ghost lg', title: '标记一次分心', onClick: async () => {
          await api.timer.distraction();
          SH.toast({ title: '已记录一次分心', body: '这一笔会算进本段的专注度评分。', kind: 'info', timeout: 3000 });
        } }, '我走神了'));
      }
    }

    // 元信息
    if (meta) {
      SH.clear(meta);
      const task = findTask(S, st.taskId);
      if (task) meta.appendChild(h('span', { class: 'chip accent', html: SH.icon('plan', 12) + `<span style="margin-left:4px">${SH.esc(task.title)}</span>` }));
      const mat = (S.db.materials || []).find((m) => m.id === st.materialId);
      if (mat) meta.appendChild(h('span', { class: 'chip', html: SH.icon(SH.materialIcon(mat.type), 12) + `<span style="margin-left:4px">${SH.esc(mat.title.slice(0, 18))}</span>` }));
      if (st.running && st.interruptions) meta.appendChild(h('span', { class: 'chip warn' }, `中断 ${st.interruptions} 次`));
      if (st.running) meta.appendChild(h('span', { class: 'chip ok' }, `本段已专注 ${Math.round(st.elapsedMs / 60000)} 分`));
    }
  }

  function findTask(S, taskId) {
    if (!taskId) return null;
    for (const p of S.db.plans || []) {
      const t = (p.tasks || []).find((x) => x.id === taskId);
      if (t) return t;
    }
    return null;
  }

  async function startNow(mode, phase) {
    const S = SH.state;
    const r = view._refs;
    const subjectId = r.subject ? r.subject.value : '';
    const materialId = r.material ? r.material.value : '';
    const taskId = r.taskId || '';
    await api.timer.start({ mode, phase: phase || 'focus', subjectId, materialId, taskId });
    await SH.app.refresh();
  }

  async function stopSession() {
    const res = await api.timer.stop();
    if (res && res.session) {
      SH.toast({ title: `已记录 ${F.dur(res.session.minutes)}`, body: `本段专注度 ${res.session.focusScore} 分。继续加油。`, kind: 'info', timeout: 5000 });
    } else {
      SH.toast({ title: '本段不足 1 分钟，没有计入', kind: 'warn', timeout: 4000 });
    }
    await SH.app.refresh();
  }

  /* ------------------------------------------------------------------ *
   * 开始前的设置
   * ------------------------------------------------------------------ */
  function settingsCard(S, x) {
    const r = view._refs;
    const subjects = S.db.subjects || [];
    const materials = (S.db.materials || []).filter((m) => m.status !== 'done');

    r.subject = h('select', { class: 'select' },
      h('option', { value: '' }, '不指定科目'),
      ...subjects.map((s) => h('option', { value: s.id, selected: s.id === S.timer.subjectId }, s.name)));

    r.material = h('select', { class: 'select' },
      h('option', { value: '' }, '不关联资料'),
      ...materials.map((m) => h('option', { value: m.id, selected: m.id === S.timer.materialId }, m.title)));

    const tasksPending = x.tasks.filter((t) => !t.done);
    const taskSelect = h('select', { class: 'select' },
      h('option', { value: '' }, '不关联任务'),
      ...tasksPending.map((t) => h('option', { value: t.taskId, selected: t.taskId === S.timer.taskId }, `${t.title} · ${t.plan}`)));
    taskSelect.addEventListener('change', () => {
      r.taskId = taskSelect.value;
      const t = tasksPending.find((z) => z.taskId === taskSelect.value);
      if (t && t.materialId) r.material.value = t.materialId;
    });
    r.taskId = S.timer.taskId || '';

    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', null, '开始前的准备'), h('div', { class: 'grow', style: { flex: '1' } }),
        h('button', { class: 'btn sm ghost', onClick: () => manualSession(S) }, '手动补录')),
      h('div', { class: 'card-body' },
        h('label', { class: 'field' }, h('span', { class: 'lb' }, '科目'), r.subject),
        h('label', { class: 'field' }, h('span', { class: 'lb' }, '今天要做的任务'), taskSelect),
        h('label', { class: 'field' }, h('span', { class: 'lb' }, '关联资料'),
          r.material, h('span', { class: 'hint' }, '关联后，这段专注的时长会自动累计到资料的投入时间里')),
        h('div', { class: 'row', style: { gap: '8px', marginTop: '4px' } },
          h('button', { class: 'btn primary', onClick: () => startNow('pomodoro', 'focus') }, '开始番茄钟'),
          h('button', { class: 'btn', onClick: () => startNow('stopwatch') }, '开始正计时'),
          h('button', { class: 'btn ghost', onClick: () => SH.app.go('settings') }, '调整时长') )));
  }

  function materialQuickCard(S) {
    const doing = (S.db.materials || []).filter((m) => m.status === 'doing').slice(0, 4);
    const body = h('div', { class: 'card-body' });
    if (!doing.length) {
      body.appendChild(h('div', { class: 'small muted' }, '还没有「进行中」的资料。去资料库挑一份开始。'));
    } else {
      const list = h('div', { class: 'list' });
      doing.forEach((m) => {
        list.appendChild(h('div', { class: 'list-item', style: { padding: '9px 0', borderBottom: '1px solid var(--border)' } },
          h('span', { class: 'm-ico', style: { width: '28px', height: '28px', flex: '0 0 28px' }, html: SH.icon(SH.materialIcon(m.type), 15) }),
          h('div', { style: { flex: '1', minWidth: 0 } },
            h('div', { class: 'li-title ellipsis' }, m.title),
            h('div', { class: 'li-sub' }, `${m.progress ? m.progress + '% · ' : ''}已投入 ${F.dur(m.timeSpentMin)}`)),
          h('button', { class: 'btn sm', html: SH.icon('play', 12), title: '就学这一份',
            onClick: () => { if (view._refs.material) view._refs.material.value = m.id; startNow('pomodoro', 'focus'); } })));
      });
      body.appendChild(list);
    }
    return h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, '一键开始（进行中的资料）')), body);
  }

  /* ------------------------------------------------------------------ *
   * 今日记录
   * ------------------------------------------------------------------ */
  function sessionList(S, sessions) {
    if (!sessions.length) return h('div', { class: 'card' }, SH.empty('今天还没有学习记录', '开始一段专注，或者用「手动补录」把刚才的时间记上。', 'timer'));
    const list = h('div', { class: 'list' });
    sessions.forEach((s) => {
      const sub = (S.db.subjects || []).find((x) => x.id === s.subjectId);
      const mat = (S.db.materials || []).find((x) => x.id === s.materialId);
      const startT = new Date(s.start);
      const endT = new Date(s.end);
      list.appendChild(h('div', { class: 'list-item' },
        h('div', { style: { width: '84px', flex: '0 0 84px' }, class: 'mono small muted' },
          `${F.pad2(startT.getHours())}:${F.pad2(startT.getMinutes())}–${F.pad2(endT.getHours())}:${F.pad2(endT.getMinutes())}`),
        h('div', { style: { flex: '1', minWidth: 0 } },
          h('div', { class: 'li-title row', style: { gap: '8px' } },
            sub ? h('span', { class: 'row', style: { gap: '5px' } }, h('span', { class: 'subj-dot', style: { background: sub.color } }), sub.name) : h('span', { class: 'muted' }, '未分类'),
            mat ? h('span', { class: 'small muted ellipsis' }, '· ' + mat.title) : null),
          h('div', { class: 'li-sub' },
            `${s.mode === 'pomodoro' ? '番茄钟' : s.mode === 'stopwatch' ? '正计时' : '手动补录'}`,
            s.interruptions ? ` · 中断 ${s.interruptions} 次` : '')),
        s.focusScore != null ? h('span', { class: 'chip ' + (s.focusScore >= 85 ? 'ok' : s.focusScore >= 70 ? '' : 'warn') }, `${s.focusScore} 分`) : null,
        h('span', { class: 'mono', style: { fontWeight: '600', width: '58px', textAlign: 'right' } }, F.dur(s.minutes)),
        h('button', { class: 'btn ghost icon sm', html: SH.icon('edit', 14), title: '编辑', onClick: () => editSession(S, s) }),
        h('button', { class: 'btn ghost icon sm', html: SH.icon('trash', 14), title: '删除', onClick: async () => {
          const ok = await SH.confirm({ title: '删除这段记录？', message: `${F.dur(s.minutes)} 将从今日统计中移除，且无法撤销。`, okText: '删除', danger: true });
          if (ok) { await api.sessions.remove(s.id); SH.app.refresh(); }
        } })));
    });
    return h('div', { class: 'card' }, list);
  }

  async function editSession(S, s) {
    const v = await SH.formDialog({
      title: '编辑学习记录',
      fields: [
        { name: 'subjectId', label: '科目', type: 'select', value: s.subjectId, options: [{ value: '', label: '不指定' }, ...(S.db.subjects || []).map((z) => ({ value: z.id, label: z.name }))] },
        { name: 'minutes', label: '时长（分钟）', type: 'number', value: s.minutes, min: 1, max: 1440 },
        { name: 'note', label: '备注', type: 'textarea', value: s.note || '', placeholder: '这段学了什么、卡在哪里' }
      ]
    });
    if (!v) return;
    const end = new Date(new Date(s.start).getTime() + v.minutes * 60000);
    await api.sessions.update(s.id, { subjectId: v.subjectId, minutes: v.minutes, note: v.note, end: end.toISOString() });
    SH.app.refresh();
  }

  async function manualSession(S) {
    const now = new Date();
    const v = await SH.formDialog({
      title: '手动补录一段学习',
      fields: [
        { name: 'subjectId', label: '科目', type: 'select', value: S.timer.subjectId || '', options: [{ value: '', label: '不指定' }, ...(S.db.subjects || []).map((z) => ({ value: z.id, label: z.name }))] },
        { name: 'materialId', label: '关联资料', type: 'select', value: '', options: [{ value: '', label: '不关联' }, ...(S.db.materials || []).map((z) => ({ value: z.id, label: z.title }))] },
        { name: 'minutes', label: '时长（分钟）', type: 'number', value: 45, min: 1, max: 1440 },
        { name: 'time', label: '结束时间（今天）', type: 'time', value: `${F.pad2(now.getHours())}:${F.pad2(now.getMinutes())}` },
        { name: 'note', label: '备注', type: 'textarea', value: '', placeholder: '可选' }
      ],
      okText: '记录'
    });
    if (!v) return;
    const [hh, mm] = v.time.split(':').map(Number);
    const end = new Date(); end.setHours(hh, mm, 0, 0);
    await api.sessions.add({
      subjectId: v.subjectId, materialId: v.materialId, minutes: v.minutes,
      end: end.toISOString(), note: v.note
    });
    SH.toast({ title: `已补录 ${F.dur(v.minutes)}`, kind: 'ok', timeout: 3500 });
    SH.app.refresh();
  }

  SH.views.focus = view;
})();
