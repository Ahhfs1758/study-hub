/* views/stats.js —— 时间统计：时间花在哪、什么时候效率最高、离目标还有多远 */
(function () {
  'use strict';
  const SH = window.SH;
  const h = SH.h, api = SH.api, F = SH.fmt;
  const C = SH.charts;

  const PRESETS = [
    { id: '7', label: '近 7 天', days: 7 },
    { id: '14', label: '近 14 天', days: 14 },
    { id: '30', label: '近 30 天', days: 30 },
    { id: '90', label: '近 90 天', days: 90 },
    { id: 'week', label: '本周', week: 0 },
    { id: 'lastweek', label: '上周', week: -1 },
    { id: 'month', label: '本月', month: 0 }
  ];
  let current = '14';

  function rangeOf(id) {
    const p = PRESETS.find((x) => x.id === id) || PRESETS[1];
    const today = new Date();
    if (p.week !== undefined) {
      const ws = SH.state.db.profile.weekStart;
      const day = today.getDay();
      const diff = (day - ws + 7) % 7;
      const start = new Date(today); start.setDate(today.getDate() - diff + p.week * 7);
      const end = new Date(start); end.setDate(start.getDate() + 6);
      return { from: F.dayKey(start), to: F.dayKey(end), label: p.label, days: 7 };
    }
    if (p.month !== undefined) {
      const start = new Date(today.getFullYear(), today.getMonth(), 1);
      return { from: F.dayKey(start), to: F.dayKey(today), label: p.label, days: today.getDate() };
    }
    const start = new Date(today); start.setDate(today.getDate() - (p.days - 1));
    return { from: F.dayKey(start), to: F.dayKey(today), label: p.label, days: p.days };
  }

  SH.views.stats = {
    title: '时间统计',
    sub: () => '把「感觉学了很久」换成「确实学了这么多」',

    async load(S) {
      const r = rangeOf(current);
      const [daily, subs, heat, hourly, sessions, score] = await Promise.all([
        api.stats.daily(r.days),
        api.stats.subjects(r.from, r.to),
        api.stats.heatmap(18),
        api.stats.hourly(r.days),
        api.sessions.list({ from: r.from, to: r.to }),
        api.stats.score(r.from, r.to)
      ]);
      const sorted = sessions.slice().sort((a, b) => b.start.localeCompare(a.start));
      SH.views.stats._sessions = sorted;
      SH.views.stats._range = r;
      return { r, daily, subs, heat, hourly, sessions: sorted, score };
    },

    render(root, S, x) {
      root.appendChild(presetBar());
      root.appendChild(summary(S, x));
      root.appendChild(h('div', { class: 'grid g-2-1' },
        card('每日专注时长', C.bars({
          data: x.daily.map((d) => ({
            label: d.date.slice(5).replace('-', '/'), value: d.minutes,
            title: `${F.dayLabel(d.date, true)}：${F.dur(d.minutes)}（${d.sessions} 段）`
          })),
          height: 220, goal: S.db.profile.dailyGoalMin,
          labelEvery: x.daily.length > 30 ? 7 : x.daily.length > 14 ? 3 : 1
        })),
        x.subs.length
          ? card('科目占比', h('div', { class: 'row', style: { gap: '16px', alignItems: 'center', justifyContent: 'center' } },
            SH.html(C.donut({ items: x.subs.map((s) => ({ label: s.name, value: s.minutes, color: s.color })), size: 150, thickness: 18 }))))
          : card('科目占比', SH.empty('这段时间没有记录', null, 'stats'))));

      root.appendChild(h('h2', { class: 'section' }, '科目明细'));
      root.appendChild(subjectTable(S, x));

      root.appendChild(h('h2', { class: 'section' }, '习惯分布'));
      root.appendChild(h('div', { class: 'grid g2' },
        card('常学时段（0-23 点）',
          C.hourStrip({ buckets: x.hourly }),
          hint('把最难啃的内容安排在你的黄金时段，把机械记忆放在低效时段。')),
        card('打卡热力图', C.heatHTML({ days: x.heat, weekStart: S.db.profile.weekStart }))));

      root.appendChild(h('h2', { class: 'section' }, `明细记录（${x.sessions.length} 段）`));
      root.appendChild(sessionTable(S, x.sessions));
    }
  };

  function presetBar() {
    const bar = h('div', { class: 'row', style: { marginBottom: '14px', gap: '10px' } });
    const tabs = h('div', { class: 'pill-tabs' });
    PRESETS.forEach((p) => {
      const b = h('button', { class: current === p.id ? 'active' : '' }, p.label);
      b.addEventListener('click', () => { current = p.id; SH.app.reload(); });
      tabs.appendChild(b);
    });
    bar.appendChild(tabs);
    bar.appendChild(h('div', { style: { flex: '1' } }));
    bar.appendChild(h('button', { class: 'btn sm', html: SH.icon('download', 13) + '<span style="margin-left:4px">导出 CSV</span>', onClick: exportCsv }));
    return bar;
  }

  function summary(S, x) {
    const total = x.daily.reduce((a, b) => a + b.minutes, 0);
    const active = x.daily.filter((d) => d.minutes > 0).length;
    const avgActive = active ? Math.round(total / active) : 0;
    const avgAll = Math.round(total / Math.max(1, x.daily.length));
    const sessions = x.sessions.length;
    const avgLen = sessions ? Math.round(total / sessions) : 0;
    const goal = S.db.profile.dailyGoalMin;
    const hitDays = x.daily.filter((d) => d.minutes >= goal).length;
    const inter = x.sessions.reduce((a, b) => a + (b.interruptions || 0), 0);

    return h('div', { class: 'grid g4' },
      SH.statCard({ label: `${x.r.label}累计`, value: F.dur(total), icon: 'clock', desc: `${x.r.from} → ${x.r.to}` }),
      SH.statCard({ label: '日均', value: F.dur(avgAll), icon: 'stats', desc: `只算学习日则 ${F.dur(avgActive)}（${active} 天）` }),
      SH.statCard({ label: '达标天数', value: `${hitDays}/${x.daily.length}`, icon: 'target', desc: `目标 ${F.dur(goal)}/天 · 达成率 ${Math.round((hitDays / Math.max(1, x.daily.length)) * 100)}%` }),
      SH.statCard({ label: '专注力评分', value: x.score.score, unit: '/100', icon: 'sparkle', desc: `平均每段 ${F.dur(avgLen)} · 中断 ${inter} 次` }));
  }

  function subjectTable(S, x) {
    if (!x.subs.length) return h('div', { class: 'card' }, SH.empty('这段时间没有学习记录', null, 'stats'));
    const tb = h('table', { class: 'tb' });
    tb.appendChild(h('thead', null, h('tr', null, ...['科目', '时长', '占比', '场次', '平均每段', '周目标进度', ''].map((t) => h('th', null, t)))));
    const body = h('tbody');
    const total = x.subs.reduce((a, b) => a + b.minutes, 0);
    x.subs.forEach((s) => {
      const sub = (S.db.subjects || []).find((z) => z.id === s.subjectId);
      const goalWeek = (sub && sub.goalMinPerWeek) || 0;
      const weeks = Math.max(1, x.r.days / 7);
      const ratio = goalWeek ? Math.min(1, s.minutes / (goalWeek * weeks)) : 0;
      body.appendChild(h('tr', null,
        h('td', null, h('div', { class: 'row', style: { gap: '7px' } },
          h('span', { class: 'subj-dot', style: { background: s.color } }),
          h('span', { style: { fontWeight: '550' } }, s.name))),
        h('td', { class: 'nowrap' }, F.dur(s.minutes)),
        h('td', { class: 'nowrap mono' }, s.pct + '%'),
        h('td', null, String(s.sessions)),
        h('td', { class: 'nowrap' }, F.dur(Math.round(s.minutes / Math.max(1, s.sessions)))),
        h('td', { style: { minWidth: '150px' } }, goalWeek
          ? h('div', { class: 'row', style: { gap: '8px' } },
            h('div', { style: { flex: '1' } }, SH.progressBar(ratio, ratio >= 1 ? 'ok' : '')),
            h('span', { class: 'small mono muted' }, Math.round(ratio * 100) + '%'))
          : h('span', { class: 'small muted' }, '未设目标')),
        h('td', null, h('button', { class: 'btn sm ghost', onClick: () => SH.app.go('settings') }, '设目标'))));
    });
    body.appendChild(h('tr', { style: { background: 'var(--surface-2)' } },
      h('td', null, h('b', null, '合计')),
      h('td', null, h('b', null, F.dur(total))), h('td', null, '100%'),
      h('td', null, String(x.sessions.length)), h('td', null, '—'), h('td', null, ''), h('td', null, '')));
    tb.appendChild(body);
    return h('div', { class: 'card', style: { overflow: 'hidden' } }, tb);
  }

  function sessionTable(S, list) {
    if (!list.length) return h('div', { class: 'card' }, SH.empty('没有明细', null, 'timer'));
    const tb = h('table', { class: 'tb' });
    tb.appendChild(h('thead', null, h('tr', null, ...['日期', '时间', '科目', '资料', '时长', '方式', '中断', '评分'].map((t) => h('th', null, t)))));
    const body = h('tbody');
    list.slice(0, 300).forEach((s) => {
      const sub = (S.db.subjects || []).find((z) => z.id === s.subjectId);
      const mat = (S.db.materials || []).find((z) => z.id === s.materialId);
      const st = new Date(s.start), en = new Date(s.end);
      body.appendChild(h('tr', null,
        h('td', { class: 'nowrap' }, F.dayLabel(F.dayKey(st), true)),
        h('td', { class: 'nowrap mono small' }, `${F.pad2(st.getHours())}:${F.pad2(st.getMinutes())}–${F.pad2(en.getHours())}:${F.pad2(en.getMinutes())}`),
        h('td', null, sub ? h('span', { class: 'row', style: { gap: '6px' } }, h('span', { class: 'subj-dot', style: { background: sub.color } }), sub.name) : h('span', { class: 'muted' }, '—')),
        h('td', { class: 'ellipsis', style: { maxWidth: '220px' } }, mat ? mat.title : h('span', { class: 'muted' }, '—')),
        h('td', { class: 'nowrap', style: { fontWeight: '600' } }, F.dur(s.minutes)),
        h('td', null, h('span', { class: 'chip' }, s.mode === 'pomodoro' ? '番茄钟' : s.mode === 'stopwatch' ? '正计时' : '手动')),
        h('td', null, s.interruptions ? h('span', { class: 'chip warn' }, String(s.interruptions)) : h('span', { class: 'muted' }, '0')),
        h('td', null, s.focusScore != null ? String(s.focusScore) : h('span', { class: 'muted' }, '—'))));
    });
    tb.appendChild(body);
    return h('div', { class: 'card', style: { overflow: 'hidden' } }, tb);
  }

  function exportCsv() {
    const S = SH.state;
    const list = SH.views.stats._sessions || [];
    if (!list.length) { SH.toast({ title: '这段时间没有记录可导出', kind: 'warn' }); return; }
    const rows = [['日期', '开始', '结束', '科目', '资料', '分钟', '方式', '中断', '评分', '备注']];
    list.forEach((s) => {
      const sub = (S.db.subjects || []).find((z) => z.id === s.subjectId);
      const mat = (S.db.materials || []).find((z) => z.id === s.materialId);
      rows.push([
        F.dayKey(new Date(s.start)),
        new Date(s.start).toLocaleTimeString('zh-CN', { hour12: false }),
        new Date(s.end).toLocaleTimeString('zh-CN', { hour12: false }),
        sub ? sub.name : '',
        mat ? mat.title : '',
        s.minutes, s.mode, s.interruptions, s.focusScore ?? '', (s.note || '').replace(/[\n,]/g, ' ')
      ]);
    });
    const csv = '\ufeff' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `学习记录-${F.dayKey()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    SH.toast({ title: '已导出 CSV', kind: 'ok', timeout: 3000 });
  }

  /** 卡片外壳。子内容一律经 SH.node 归一化，SVG 源码字符串也能直接传进来 */
  const card = (title, ...children) => h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, title)),
    h('div', { class: 'card-body' }, ...children.map((c) => (c instanceof Node ? c : SH.node(c)))));
  const hint = (t) => h('div', { class: 'small muted', style: { marginTop: '8px' } }, t);
})();
