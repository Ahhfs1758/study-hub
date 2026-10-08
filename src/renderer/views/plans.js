/* views/plans.js —— 学习计划：目标 → 阶段 → 每日任务，逐层落到今天 */
(function () {
  'use strict';
  const SH = window.SH;
  const h = SH.h, api = SH.api, F = SH.fmt;

  const REPEAT_LABEL = { none: '单次', daily: '每天', weekdays: '工作日', weekly: '每周', monthly: '每月' };
  const PRIORITY = { 1: { t: '高', c: 'danger' }, 2: { t: '中', c: 'warn' }, 3: { t: '低', c: '' } };

  let expanded = {};
  let filterSubject = '';

  SH.views.plans = {
    title: '学习计划',
    sub: () => '把大目标拆成每天能做掉的一件小事，进度才不会只停在「计划」两个字上',

    async load(S) {
      const [today, report] = await Promise.all([
        api.plans.today(F.dayKey()),
        api.stats.planReport()
      ]);
      const upcoming = [];
      for (let i = 1; i <= 6; i++) {
        const key = F.dayKey(new Date(Date.now() + i * 86400000));
        const rows = await api.plans.today(key);
        rows.forEach((r) => upcoming.push({ ...r, date: key }));
      }
      return { today, report, upcoming };
    },

    render(root, S, x) {
      root.appendChild(topActions(S, x));
      root.appendChild(h('h2', { class: 'section' }, '今天的任务'));
      root.appendChild(todayCard(S, x.today));
      root.appendChild(h('h2', { class: 'section' }, '接下来 7 天'));
      // 左边看「哪天重、哪天轻」（柱形），右边看「具体是什么事」（清单）
      root.appendChild(h('div', { class: 'grid g-2-1' }, loadCard(S, x.upcoming), upcomingCard(S, x.upcoming)));
      root.appendChild(h('h2', { class: 'section' }, '计划时间线'));
      root.appendChild(timelineCard(S, x.report));
      root.appendChild(h('div', { class: 'row', style: { margin: '22px 0 10px', gap: '10px' } },
        h('h2', { class: 'section', style: { margin: '0' } }, '进行中的计划'),
        h('div', { style: { flex: '1' } }),
        subjectFilter(S)));
      root.appendChild(planGrid(S, x.report));
      const archived = (S.db.plans || []).filter((p) => p.status !== 'active');
      if (archived.length) {
        root.appendChild(h('h2', { class: 'section' }, '已归档'));
        root.appendChild(h('div', { class: 'grid g3' }, archived.map((p) => planCard(S, p, x.report.find((r) => r.id === p.id), true))));
      }
    }
  };

  /* ------------------------------------------------------------------ *
   * 计划时间线（甘特）
   *
   * 计划里最有价值的信息是「什么时候开始、什么时候结束、现在走到哪」。
   * 这三件事原来分散在「2026-09-23 → 2026-10-13」和一条进度条上，
   * 读者要自己在脑子里把日期换算成「还剩几天、走到几成了」。
   * 甘特把三者放进同一条横条：位置=时间，填充=进度，菱形=阶段目标。
   * ------------------------------------------------------------------ */
  function timelineCard(S, report) {
    const active = (S.db.plans || []).filter((p) => p.status === 'active');
    const card = h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', null, '计划时间线'),
        h('div', { class: 'grow', style: { flex: '1' } }),
        h('span', { class: 'small muted' }, '横条长度＝计划周期 · 填充＝完成度 · 菱形＝阶段目标'),
        h('button', { class: 'btn sm ghost', onClick: () => newPlan(S) }, '+ 新建')));

    if (!active.length) {
      card.appendChild(h('div', { class: 'card-body' }, SH.empty('还没有进行中的计划', '建一个计划并把大目标拆成阶段，这里就会显示时间线。', 'plan')));
      return card;
    }

    const today = F.dayKey();
    const rows = active.map((p, i) => {
      const rep = report.find((r) => r.id === p.id);
      const sub = (S.db.subjects || []).find((z) => z.id === p.subjectId);
      const ms = (p.milestones || []).map((m) => ({ at: m.due || p.endDate, label: m.title, done: !!m.done }));
      const rate = rep ? rep.rate / 100 : 0;
      const daysLeft = rep ? rep.daysLeft : null;
      return {
        label: p.title,
        start: p.startDate,
        end: p.endDate,
        progress: rate,
        color: sub ? sub.color : undefined,
        milestones: ms,
        meta: `${p.title}\n${p.startDate} → ${p.endDate}\n完成 ${rate * 100 | 0}%${daysLeft != null ? ` · ${daysLeft < 0 ? '已超期 ' + (-daysLeft) + ' 天' : daysLeft === 0 ? '今天截止' : '剩 ' + daysLeft + ' 天'}` : ''}`
      };
    });

    const body = h('div', { class: 'card-body' });
    body.appendChild(SH.html(SH.viz.gantt({
      rows, today,
      rowHeight: 36,
      from: active.reduce((m, p) => (p.startDate < m ? p.startDate : m), today),
      to: active.reduce((m, p) => (p.endDate > m ? p.endDate : m), today)
    })));
    // 逾期项单独用一条横条列表点出来 —— 甘特图上看不出「哪些已经欠账」
    const overdue = report.filter((r) => r.overdue > 0);
    if (overdue.length) {
      body.appendChild(h('div', { style: { marginTop: '14px' } },
        SH.vizHead('逾期分布', `${overdue.reduce((a, b) => a + b.overdue, 0)} 项待补`),
        SH.html(SH.viz.hbars({
          items: overdue.map((r) => ({ label: r.title, value: r.overdue, color: r.risk === 'high' ? '#dc2626' : '#d97706' })),
          unitLabel: (v) => `${v} 项`
        }))));
    }
    card.appendChild(body);
    return card;
  }

  /* ------------------------------------------------------------------ *
   * 未来 7 天负载
   * 「接下来哪天最重」是排计划时最该先看的一件事。一列柱形几秒就能扫完，
   * 而按天分组的清单要逐行累加才看得出。
   * ------------------------------------------------------------------ */
  function loadCard(S, upcoming) {
    const byDate = {};
    for (let i = 1; i <= 6; i++) byDate[F.dayKey(new Date(Date.now() + i * 86400000))] = [];
    upcoming.forEach((t) => { (byDate[t.date] = byDate[t.date] || []).push(t); });
    const dates = Object.keys(byDate).sort();

    const data = dates.map((d) => {
      const rows = byDate[d] || [];
      return {
        label: F.dayLabel(d).replace('月', '/').replace('日', ''),
        value: rows.reduce((a, b) => a + b.estMin, 0),
        title: `${F.dayLabel(d, true)}：${rows.length} 项 · ${F.dur(rows.reduce((a, b) => a + b.estMin, 0))}`
      };
    });
    const total = data.reduce((a, b) => a + b.value, 0);
    const maxDay = data.slice().sort((a, b) => b.value - a.value)[0];
    const avg = Math.round(total / Math.max(1, data.length));
    const todayGoal = S.overview.dailyGoalMin || 120;

    const heavy = data.filter((d) => d.value > todayGoal * 1.5);

    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', null, '未来 7 天负载'),
        h('div', { class: 'grow', style: { flex: '1' } }),
        // 7 天负载的形状：柱形比折线更贴合「哪天重」，而且不会被误读成趋势
        SH.html(SH.viz.miniBars({
          values: data.map((d) => d.value),
          labels: data.map((d) => d.label),
          width: 92, height: 24
        })),
        h('span', { class: 'small muted' }, `日均 ${F.dur(avg)}`),
        heavy.length ? h('span', { class: 'chip warn' }, `${heavy.length} 天偏重`) : null),
      h('div', { class: 'card-body' },
        SH.html(SH.charts.bars({
          data, height: 168, labelEvery: 1,
          goal: todayGoal,
          unitLabel: (v) => F.dur(v),        // tooltip 用可读文案
          axisLabel: (v) => F.hm(v),         // 轴刻度用紧凑格式，否则会被裁成「节 20 分」
          goalLabel: '日目标'
        })),
        h('div', { class: 'viz-caption' },
          maxDay && maxDay.value
            ? `最重的是 ${maxDay.label}（${F.dur(maxDay.value)}）。把重的那天往后挪一点，比当天硬扛更可持续。`
            : '接下来一周还是空的。可以把重复任务（比如每天背单词）加到计划里。')));
  }

  function subjectFilter(S) {
    const sel = h('select', { class: 'select', style: { width: '170px' } },
      h('option', { value: '' }, '全部科目'),
      ...(S.db.subjects || []).map((s) => h('option', { value: s.id, selected: s.id === filterSubject }, s.name)));
    sel.value = filterSubject;
    sel.addEventListener('change', () => { filterSubject = sel.value; SH.app.reload(); });
    return sel;
  }

  function topActions(S, x) {
    const overdue = x.report.reduce((a, b) => a + b.overdue, 0);
    return h('div', { class: 'grid g4' },
      SH.statCard({ label: '进行中的计划', value: (S.db.plans || []).filter((p) => p.status === 'active').length, unit: '个', icon: 'plan' }),
      SH.statCard({ label: '今日待办', value: x.today.filter((t) => !t.done).length, unit: '项', icon: 'check', desc: `共 ${x.today.length} 项` }),
      SH.statCard({ label: '逾期未完成', value: overdue, unit: '项', icon: 'alert', desc: overdue ? '建议今天先清一批' : '没有欠账，很好' }),
      h('div', { class: 'stat accent' },
        h('div', { class: 'k' }, SH.iconEl('sparkle', 14), '新建'),
        h('div', { style: { marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '7px' } },
          h('button', { class: 'btn', style: { background: 'rgba(255,255,255,.18)', borderColor: 'rgba(255,255,255,.35)', color: '#fff' }, onClick: () => newPlan(S) }, '+ 新建学习计划'),
          h('button', { class: 'btn', style: { background: 'transparent', borderColor: 'rgba(255,255,255,.35)', color: '#fff' }, onClick: () => quickTask(S) }, '+ 记一条一次性任务'))));
  }

  /* ---------------- 今日任务 ---------------- */
  function todayCard(S, tasks) {
    const card = h('div', { class: 'card' });
    if (!tasks.length) {
      card.appendChild(SH.empty('今天没有任务', '把计划拆到今天，或者直接开一段专注。', 'plan'));
      return card;
    }
    const doneN = tasks.filter((t) => t.done).length;
    const leftMin = tasks.filter((t) => !t.done).reduce((a, b) => a + (b.estMin || 0), 0);
    // 顶部一条点阵 + 一行关键值：几项、完了几项、还剩多少时间
    card.appendChild(h('div', { class: 'card-body', style: { paddingBottom: '6px', borderBottom: '1px solid var(--border)' } },
      h('div', { class: 'viz-split' },
        h('div', { class: 'viz-main' }, SH.html(SH.viz.progressRing({
          ratio: doneN / tasks.length,
          size: 84, thickness: 9,
          value: `${doneN}`,
          unit: `/${tasks.length}`,
          sub: '已完成',
          color: doneN === tasks.length ? SH.viz.HUE.ok : SH.viz.HUE.accent
        }))),
        h('div', { class: 'viz-side' },
          SH.html(SH.viz.dotMatrix({
            dots: tasks.map((t) => ({ done: t.done, title: `${t.done ? '已完成' : '未完成'}：${t.title}（${F.dur(t.estMin)}）` })),
            cols: 10, size: 11, gap: 5
          })),
          h('div', { class: 'row', style: { gap: '14px', marginTop: '10px', fontSize: '12px', color: 'var(--text-2)' } },
            h('span', null, `还剩 ${tasks.length - doneN} 项`),
            h('span', null, `约 ${F.dur(leftMin)}`))))));
    const list = h('div', { class: 'list' });
    tasks.forEach((t) => {
      const sub = (S.db.subjects || []).find((z) => z.id === t.subjectId);
      list.appendChild(h('div', { class: 'list-item' },
        h('div', {
          class: 'check' + (t.done ? ' on' : ''), html: SH.icon('check', 12),
          onClick: async () => {
            const plan = (S.db.plans || []).find((p) => p.id === t.planId);
            await api.plans.toggleTask(t.planId, t.taskId, F.dayKey());
            SH.app.refresh();
            if (plan) void plan;
          }
        }),
        h('div', { style: { flex: '1', minWidth: 0 } },
          h('div', { class: 'li-title', style: t.done ? { textDecoration: 'line-through', color: 'var(--muted)' } : null }, t.title),
          h('div', { class: 'li-sub row', style: { gap: '8px', flexWrap: 'wrap' } },
            sub ? h('span', { class: 'row nowrap', style: { gap: '5px' } }, h('span', { class: 'subj-dot', style: { background: sub.color } }), sub.name) : null,
            h('span', { class: 'nowrap' }, `预计 ${F.dur(t.estMin)}`),
            t.repeat !== 'none' ? h('span', { class: 'chip nowrap' }, REPEAT_LABEL[t.repeat] || t.repeat) : null,
            h('span', { class: 'ellipsis nowrap', style: { maxWidth: '150px' }, title: t.plan }, t.plan))),
        h('button', { class: 'btn sm ghost', html: SH.icon('edit', 12), title: '编辑', onClick: () => editTask(S, t.planId, t) }),
        !t.done ? h('button', { class: 'btn sm', html: SH.icon('play', 12), onClick: () => SH.app.startFocus({ subjectId: t.subjectId || '', taskId: t.taskId, planId: t.planId, materialId: t.materialId || '' }) }) : null));
    });
    card.appendChild(list);
    return card;
  }

  /* ---------------- 未来 7 天 ---------------- */
  function upcomingCard(S, upcoming) {
    const byDate = {};
    upcoming.forEach((t) => { (byDate[t.date] = byDate[t.date] || []).push(t); });
    const dates = Object.keys(byDate).sort();
    const card = h('div', { class: 'card' });
    if (!dates.length) {
      card.appendChild(SH.empty('接下来一周还没有排任务', '可以把重复任务（比如每天背单词）加到计划里。', 'calendar'));
      return card;
    }
    const body = h('div', { class: 'card-body' });
    dates.forEach((d) => {
      const rows = byDate[d];
      body.appendChild(h('div', { class: 'row', style: { gap: '10px', marginBottom: '7px' } },
        h('div', { style: { width: '106px', flex: '0 0 106px' } },
          h('div', { style: { fontWeight: '600', fontSize: '13px' } }, F.dayLabel(d, true)),
          h('div', { class: 'small muted' }, `${rows.length} 项 · ${F.dur(rows.reduce((a, b) => a + b.estMin, 0))}`)),
        h('div', { style: { flex: '1', display: 'flex', flexWrap: 'wrap', gap: '6px' } },
          ...rows.map((t) => {
            const sub = (S.db.subjects || []).find((z) => z.id === t.subjectId);
            return h('span', { class: 'chip clickable', title: t.plan, onClick: () => SH.app.go('plans') },
              sub ? h('span', { class: 'dot', style: { background: sub.color } }) : null, t.title);
          }))));
    });
    card.appendChild(body);
    return card;
  }

  /* ---------------- 计划卡片 ---------------- */
  function planCard(S, plan, rep, archived) {
    const sub = (S.db.subjects || []).find((z) => z.id === plan.subjectId);
    const rate = rep ? rep.rate : 0;
    const daysLeft = rep ? rep.daysLeft : null;
    const isOpen = !!expanded[plan.id];

    const head = h('div', { class: 'card-head' },
      h('span', { class: 'subj-dot', style: { background: sub ? sub.color : '#94a3b8' } }),
      h('h3', { style: { flex: '1', minWidth: 0 } }, plan.title),
      PRIORITY[plan.priority] ? h('span', { class: 'chip ' + PRIORITY[plan.priority].c }, PRIORITY[plan.priority].t + '优先') : null,
      h('button', { class: 'btn ghost icon sm', html: SH.icon('edit', 14), title: '编辑计划', onClick: () => editPlan(S, plan) }),
      h('button', { class: 'btn ghost icon sm', html: SH.icon(isOpen ? 'up' : 'down', 14), title: isOpen ? '收起' : '展开',
        onClick: () => { expanded[plan.id] = !isOpen; SH.app.reload(); } }));

    const body = h('div', { class: 'card-body' },
      plan.desc ? h('div', { class: 'small', style: { color: 'var(--text-2)', marginBottom: '10px' } }, plan.desc) : null,
      /* 完成度不再只用一条进度条：
         环给出「完成度」这个总量，点阵给出「一共几项、还剩几项」这个可数的事实。
         计划类数据两种视角都需要 —— 只给百分比会看不到「任务总数」这个规模信息。 */
      h('div', { class: 'viz-split', style: { gap: '16px', marginBottom: '12px' } },
        h('div', { class: 'viz-main' }, SH.html(SH.viz.progressRing({
          ratio: rate / 100,
          size: 76, thickness: 8,
          value: String(rate),
          unit: '%',
          sub: rep ? `${rep.done}/${rep.due}` : '',
          color: rate >= 80 ? SH.viz.HUE.ok : rate >= 40 ? SH.viz.HUE.accent : SH.viz.HUE.warn
        }))),
        h('div', { class: 'viz-side viz-stack', style: { gap: '9px' } },
          SH.meterRow({
            label: '已打卡',
            value: rep ? rep.done : 0,
            max: Math.max(1, rep ? rep.due : 1),
            display: `${rep ? rep.done : 0} 项`,
            color: 'var(--ok)'
          }),
          SH.meterRow({
            label: '逾期',
            value: rep ? rep.overdue : 0,
            max: Math.max(1, rep ? rep.due : 1),
            display: `${rep ? rep.overdue : 0} 项`,
            color: rep && rep.overdue ? 'var(--danger)' : 'var(--border-strong)'
          }),
          h('div', { class: 'row', style: { gap: '10px', fontSize: '12px', color: 'var(--text-2)', flexWrap: 'wrap' } },
            h('span', null, `${plan.startDate} → ${plan.endDate}`),
            daysLeft != null ? h('span', {
              class: 'chip ' + (daysLeft < 0 ? 'danger' : daysLeft <= 3 ? 'warn' : '')
            }, daysLeft < 0 ? `已超期 ${-daysLeft} 天` : daysLeft === 0 ? '今天截止' : `剩 ${daysLeft} 天`) : null))),
      (plan.milestones || []).length ? h('div', { style: { marginTop: '12px' } },
        h('div', { class: 'small muted', style: { marginBottom: '6px' } }, '阶段目标'),
        h('div', { class: 'seg' }, ...(plan.milestones || []).map((m) => h('span', {
          class: 'chip clickable ' + (m.done ? 'ok' : ''),
          title: (m.done ? '已完成 · ' : '') + (m.due ? '截止 ' + m.due : ''),
          onClick: async () => { await api.plans.toggleMilestone(plan.id, m.id); SH.app.refresh(); }
        }, m.done ? SH.iconEl('check', 11) : null, m.title, m.due ? h('span', { class: 'muted' }, ' ' + m.due.slice(5)) : null)))) : null);

    const card = h('div', { class: 'card' }, head, body);

    if (isOpen) {
      const tasks = h('div', { class: 'list', style: { borderTop: '1px solid var(--border)' } });
      if (!(plan.tasks || []).length) {
        tasks.appendChild(h('div', { class: 'card-body small muted' }, '还没有任务。点下面的「+ 添加任务」。'));
      }
      (plan.tasks || []).forEach((t) => {
        const doneToday = (t.doneDates || []).includes(F.dayKey()) || (t.repeat === 'none' && t.done);
        tasks.appendChild(h('div', { class: 'list-item' },
          h('div', {
            class: 'check' + (doneToday ? ' on' : ''), html: SH.icon('check', 12),
            title: '勾选/取消今天',
            onClick: async () => { await api.plans.toggleTask(plan.id, t.id, F.dayKey()); SH.app.refresh(); }
          }),
          h('div', { style: { flex: '1', minWidth: 0 } },
            h('div', { class: 'li-title' }, t.title),
            h('div', { class: 'li-sub row', style: { gap: '8px' } },
              h('span', null, '起始 ' + t.date),
              h('span', { class: 'chip' }, REPEAT_LABEL[t.repeat] || '单次'),
              t.repeat === 'weekly' && (t.weekdays || []).length ? h('span', null, t.weekdays.map((d) => '周' + F.WD[d]).join('、')) : null,
              h('span', null, `预计 ${F.dur(t.estMin)}`),
              h('span', { class: 'muted' }, `已打卡 ${(t.doneDates || []).length} 次`))),
          h('button', { class: 'btn ghost icon sm', html: SH.icon('play', 13), title: '开始专注', onClick: () => SH.app.startFocus({ subjectId: plan.subjectId || '', taskId: t.id, planId: plan.id, materialId: t.materialId || '' }) }),
          h('button', { class: 'btn ghost icon sm', html: SH.icon('edit', 13), title: '编辑', onClick: () => editTask(S, plan.id, t, true) }),
          h('button', { class: 'btn ghost icon sm', html: SH.icon('trash', 13), title: '删除', onClick: async () => {
            const ok = await SH.confirm({ title: '删除这个任务？', message: `「${t.title}」及其打卡记录会被一并删除。`, okText: '删除', danger: true });
            if (ok) { await api.plans.removeTask(plan.id, t.id); SH.app.refresh(); }
          } })));
      });
      card.appendChild(tasks);
      card.appendChild(h('div', { class: 'card-body', style: { borderTop: '1px solid var(--border)', display: 'flex', gap: '8px' } },
        h('button', { class: 'btn sm', onClick: () => addTask(S, plan.id) }, '+ 添加任务'),
        h('button', { class: 'btn sm', onClick: () => addMilestone(S, plan.id) }, '+ 添加阶段目标'),
        h('button', { class: 'btn sm ghost', onClick: async () => {
          await api.plans.update(plan.id, { status: plan.status === 'active' ? 'archived' : 'active' });
          SH.app.refresh();
        } }, archived ? '取消归档' : '归档'),
        h('div', { style: { flex: '1' } }),
        h('button', { class: 'btn sm danger', onClick: async () => {
          const ok = await SH.confirm({ title: '删除整个计划？', message: `「${plan.title}」下的所有任务、阶段目标和打卡记录都会被删除。`, okText: '删除计划', danger: true });
          if (ok) { await api.plans.remove(plan.id); SH.app.refresh(); }
        } }, '删除计划')));
    }
    return card;
  }

  function planGrid(S, report) {
    const plans = (S.db.plans || []).filter((p) => p.status === 'active' && (!filterSubject || p.subjectId === filterSubject));
    if (!plans.length) {
      return h('div', { class: 'card' }, SH.empty('还没有学习计划', '一个计划 = 一个目标 + 几个阶段 + 一堆每天能做掉的小任务。', 'target'));
    }
    return h('div', { class: 'grid g3' }, plans.map((p) => planCard(S, p, report.find((r) => r.id === p.id))));
  }

  /* ---------------- 表单 ---------------- */
  async function newPlan(S) {
    const v = await SH.formDialog({
      title: '新建学习计划',
      fields: [
        { name: 'title', label: '计划名称', placeholder: '例：三个月通过六级' },
        { name: 'subjectId', label: '科目', type: 'select', value: '', options: [{ value: '', label: '不指定' }, ...(S.db.subjects || []).map((s) => ({ value: s.id, label: s.name }))] },
        { name: 'startDate', label: '开始日期', type: 'date', value: F.dayKey() },
        { name: 'endDate', label: '结束日期', type: 'date', value: F.dayKey(new Date(Date.now() + 29 * 86400000)) },
        { name: 'priority', label: '优先级', type: 'select', value: 2, options: [{ value: 1, label: '高' }, { value: 2, label: '中' }, { value: 3, label: '低' }] },
        { name: 'desc', label: '说明', type: 'textarea', placeholder: '这个计划成功的样子是什么？' }
      ],
      okText: '创建'
    });
    if (!v || !v.title) return;
    const p = await api.plans.add(v);
    expanded[p.id] = true;
    SH.toast({ title: '计划已创建', body: '接着把它拆成每天能做掉的任务。', kind: 'ok', timeout: 4000 });
    SH.app.refresh();
  }

  async function editPlan(S, plan) {
    const v = await SH.formDialog({
      title: '编辑计划',
      fields: [
        { name: 'title', label: '计划名称', value: plan.title },
        { name: 'subjectId', label: '科目', type: 'select', value: plan.subjectId, options: [{ value: '', label: '不指定' }, ...(S.db.subjects || []).map((s) => ({ value: s.id, label: s.name }))] },
        { name: 'startDate', label: '开始日期', type: 'date', value: plan.startDate },
        { name: 'endDate', label: '结束日期', type: 'date', value: plan.endDate },
        { name: 'priority', label: '优先级', type: 'select', value: plan.priority, options: [{ value: 1, label: '高' }, { value: 2, label: '中' }, { value: 3, label: '低' }] },
        { name: 'desc', label: '说明', type: 'textarea', value: plan.desc || '' }
      ]
    });
    if (!v) return;
    await api.plans.update(plan.id, v);
    SH.app.refresh();
  }

  async function addTask(S, planId) { await taskForm(S, planId, null); }
  async function editTask(S, planId, t, fromPlan) { await taskForm(S, planId, t, fromPlan); }

  async function taskForm(S, planId, t) {
    const plan = (S.db.plans || []).find((p) => p.id === planId) || {};
    const v = await SH.formDialog({
      title: t ? '编辑任务' : '添加任务',
      fields: [
        { name: 'title', label: '任务内容', value: t ? t.title : '', placeholder: '例：页 145-170 不定积分练习' },
        { name: 'date', label: '起始日期', type: 'date', value: t ? t.date : (plan.startDate || F.dayKey()) },
        { name: 'repeat', label: '重复', type: 'select', value: t ? t.repeat : 'none', options: Object.entries(REPEAT_LABEL).map(([k, l]) => ({ value: k, label: l })) },
        { name: 'weekdays', label: '每周哪几天（选「每周」时生效）', type: 'weekdays', value: t ? t.weekdays : [] },
        { name: 'estMin', label: '预计时长（分钟）', type: 'number', value: t ? t.estMin : 30, min: 5, max: 600, step: 5 },
        { name: 'materialId', label: '关联资料', type: 'select', value: t ? t.materialId : '', options: [{ value: '', label: '不关联' }, ...(S.db.materials || []).map((m) => ({ value: m.id, label: m.title }))] }
      ],
      okText: t ? '保存' : '添加'
    });
    if (!v || !v.title) return;
    if (t) await api.plans.updateTask(planId, t.id, v);
    else await api.plans.addTask(planId, v);
    SH.app.refresh();
  }

  async function addMilestone(S, planId) {
    const v = await SH.formDialog({
      title: '添加阶段目标',
      fields: [
        { name: 'title', label: '目标', placeholder: '例：完成高数上册第 4-6 章' },
        { name: 'due', label: '截止日期', type: 'date', value: F.dayKey(new Date(Date.now() + 14 * 86400000)) }
      ],
      okText: '添加'
    });
    if (!v || !v.title) return;
    await api.plans.addMilestone(planId, v);
    SH.app.refresh();
  }

  /** 一次性任务：自动塞进一个「临时任务」计划里，避免用户为了记一条待办而先建计划 */
  async function quickTask(S) {
    const v = await SH.formDialog({
      title: '记一条一次性任务',
      fields: [
        { name: 'title', label: '任务内容', placeholder: '例：做完数学建模大作业的模型部分' },
        { name: 'subjectId', label: '科目', type: 'select', value: '', options: [{ value: '', label: '不指定' }, ...(S.db.subjects || []).map((s) => ({ value: s.id, label: s.name }))] },
        { name: 'date', label: '日期', type: 'date', value: F.dayKey() },
        { name: 'estMin', label: '预计时长（分钟）', type: 'number', value: 45, min: 5, max: 600, step: 5 }
      ],
      okText: '添加'
    });
    if (!v || !v.title) return;
    let inbox = (S.db.plans || []).find((p) => p.title === '临时任务');
    if (!inbox) {
      inbox = await api.plans.add({ title: '临时任务', subjectId: '', desc: '随手记下的一次性待办，做完可以删掉。', startDate: F.dayKey(), endDate: F.dayKey(new Date(Date.now() + 365 * 86400000)) });
    }
    await api.plans.addTask(inbox.id, { title: v.title, date: v.date, repeat: 'none', estMin: v.estMin });
    SH.toast({ title: '已加入「临时任务」计划', kind: 'ok', timeout: 3500 });
    SH.app.refresh();
  }
})();
