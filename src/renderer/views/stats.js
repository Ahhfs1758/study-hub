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
      /* 主图用**堆叠**柱：把「每天学了多久」和「分别是哪一科」画进同一根柱子。
         并排两个图（一张日总量 + 一张科目占比）看不出「总量没变但结构变了」——
         而结构变化恰恰是复盘时最该发现的事（比如数学挤掉了英语）。 */
      root.appendChild(h('div', { class: 'grid g-2-1' },
        card('每日专注时长（按科目堆叠）', trendBlock(S, x)),
        x.subs.length
          ? card('科目占比（含周目标）', h('div', { class: 'viz-stack', style: { alignItems: 'center' } },
            SH.html(C.donut({
              items: x.subs.map((s) => ({ label: s.name, value: s.minutes, color: s.color })),
              size: 158, thickness: 19,
              centerTop: F.hm(x.subs.reduce((a, b) => a + b.minutes, 0)),
              centerSub: '合计(小时:分)'
            })),
            /* 图形不只是看的：点某一条 → 跳到下面的「科目明细」并高亮那一行。
               在「占比」上发现问题、立刻到「明细」看构成，是同一次操作的连贯动作，
               中间不该要求用户自己去下面找。 */
            SH.viz.wire(SH.html(SH.viz.hbars({
              items: x.subs.slice(0, 6).map((s) => ({
                label: s.name, value: s.minutes, color: s.color,
                title: `${s.name}：${F.dur(s.minutes)} · 占 ${s.pct}%`,
                onClick: true
              })),
              unitLabel: (v) => F.hm(v)
            })), {
              onAction: (i) => {
                const sub = x.subs[i];
                if (!sub) return;
                // 用 data-subject 定位对应行并短暂高亮，然后滚过去
                const row = document.querySelector(`[data-subject-row="${sub.subjectId}"]`);
                if (!row) return;
                document.querySelectorAll('[data-subject-row]').forEach((r) => r.classList.remove('row-flash'));
                row.classList.add('row-flash');
                row.scrollIntoView({ behavior: 'smooth', block: 'center' });
                setTimeout(() => row.classList.remove('row-flash'), 1600);
              }
            })))
          : card('科目占比', SH.empty('这段时间没有记录', null, 'stats'))));

      root.appendChild(h('h2', { class: 'section' }, '科目明细'));
      root.appendChild(subjectTable(S, x));

      root.appendChild(h('h2', { class: 'section' }, '习惯分布'));
      root.appendChild(h('div', { class: 'grid g2' },
        card('常学时段（0-23 点）', hourBlock(x.hourly, x.r.days)),
        card('打卡热力图', C.heatHTML({ days: x.heat, weekStart: S.db.profile.weekStart }))));

      root.appendChild(h('h2', { class: 'section' }, `明细记录（${x.sessions.length} 段）`));
      root.appendChild(sessionTable(S, x.sessions));
    }
  };

  /* ------------------------------------------------------------------ *
   * 按科目堆叠的每日柱
   * 需要把「每段记录」归到「哪一天、哪一科」，所以这里自己算一次聚合 ——
   * analytics 的 daily() 只给总量，不含拆分。
   * ------------------------------------------------------------------ */
  function trendBlock(S, x) {
    const byDay = new Map();
    x.daily.forEach((d) => byDay.set(d.date, { date: d.date, segments: [], total: d.minutes, sessions: d.sessions }));

    // 科目顺序固定（按总时长降序），这样同一科目在所有柱子里颜色与位置一致
    const order = x.subs.map((s) => s.subjectId);
    const colorOf = {};
    x.subs.forEach((s) => { colorOf[s.subjectId] = s.color; });

    x.sessions.forEach((s) => {
      const k = F.dayKey(new Date(s.start));
      const row = byDay.get(k);
      if (!row) return;
      const key = s.subjectId || '__none';
      let seg = row.segments.find((g) => g._k === key);
      if (!seg) {
        seg = {
          _k: key,
          name: s.subjectId ? ((x.subs.find((z) => z.subjectId === s.subjectId) || {}).name || '未命名') : '未归类',
          color: colorOf[s.subjectId] || '#94a3b8',
          value: 0
        };
        row.segments.push(seg);
      }
      seg.value += s.minutes || 0;
    });

    // 按固定顺序排，保证堆叠次序稳定
    const rows = [...byDay.values()].map((r) => ({
      ...r,
      segments: r.segments
        .sort((a, b) => order.indexOf(a._k) - order.indexOf(b._k))
        .map((g) => ({ name: g.name, value: g.value, color: g.color }))
    }));

    const data = rows.map((r) => ({
      label: r.date.slice(5).replace('-', '/'),
      segments: r.segments.length ? r.segments : [{ value: 0, name: '未学习', color: '#e8ecf4' }],
      title: r.segments.length
        ? `${F.dayLabel(r.date, true)}：${F.dur(r.total)}\n` + r.segments.map((g) => `  ${g.name} ${F.dur(g.value)}`).join('\n')
        : `${F.dayLabel(r.date, true)}：未学习`
    }));

    return h('div', null,
      SH.html(SH.viz.stackedBars({
        data,
        height: 220,
        goal: S.db.profile.dailyGoalMin,
        unitLabel: (v) => F.dur(v),
        axisLabel: (v) => F.hm(v),     // 轴刻度用紧凑格式（避免被裁）
        goalLabel: '日目标'
      })),
      // 图例：堆叠图没有图例就看不出颜色对应哪一科
      h('div', { class: 'row', style: { gap: '14px', flexWrap: 'wrap', marginTop: '10px', fontSize: '11.5px', color: 'var(--muted)' } },
        ...x.subs.slice(0, 8).map((s) => h('span', { class: 'row nowrap', style: { gap: '5px', alignItems: 'center' } },
          h('span', { style: { width: '9px', height: '9px', borderRadius: '3px', background: s.color, display: 'inline-block' } }),
          `${s.name} ${F.hm(s.minutes)}`))));
  }

  /* 时段分布：柱形 + 四段汇总条 */
  function hourBlock(buckets, days) {
    const seg = (a, b) => buckets.slice(a, b).reduce((x, y) => x + y, 0);
    const parts = [
      { label: '凌晨', value: seg(0, 6), color: '#7c3aed' },
      { label: '上午', value: seg(6, 12), color: '#0891b2' },
      { label: '下午', value: seg(12, 18), color: '#3b5bfd' },
      { label: '晚上', value: seg(18, 24), color: '#0f9d6e' }
    ].filter((p) => p.value > 0);
    const total = parts.reduce((a, b) => a + b.value, 0) || 1;
    const top = buckets.map((v, i) => ({ v, i })).filter((r) => r.v > 0).sort((a, b) => b.v - a.v);

    return h('div', null,
      SH.html(C.hourStrip({ buckets })),
      parts.length ? h('div', { style: { marginTop: '12px' } },
        SH.segmentedBar(parts, 9),
        h('div', { class: 'row', style: { gap: '12px', marginTop: '8px', flexWrap: 'wrap', fontSize: '11.5px', color: 'var(--muted)' } },
          ...parts.map((p) => h('span', { class: 'row nowrap', style: { gap: '5px', alignItems: 'center' } },
            h('span', { style: { width: '8px', height: '8px', borderRadius: '3px', background: p.color, display: 'inline-block' } }),
            `${p.label} ${Math.round((p.value / total) * 100)}%`)))) : null,
      hint(top.length
        ? `黄金时段是 ${top.slice(0, 3).map((r) => r.i + ' 点').join('、')}。把最难啃的内容安排在那里，把机械记忆放在低效时段。`
        : `这 ${days} 天还没有足够的数据。`));
  }

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

    const HUE = SH.viz.HUE;
    const hitRate = hitDays / Math.max(1, x.daily.length);
    return h('div', { class: 'grid g4' },
      SH.statCard({
        label: `${x.r.label}累计`, value: F.dur(total), icon: 'clock',
        desc: `${x.r.from} → ${x.r.to}`,
        // 微柱：一眼看出这段时间的节奏（哪几天在学、有没有断档）
        visual: { kind: 'spark', values: x.daily.map((d) => d.minutes), width: 74, height: 30 }
      }),
      SH.statCard({
        label: '日均', value: F.dur(avgAll), icon: 'stats',
        // desc 必须短：卡片里已有 21px 的大数字 + 46px 的图形，
        // 剩下的横向空间只够一句短语，写长了会被省略号吃掉关键信息
        desc: `${active}/${x.daily.length} 天在学习`,
        visual: {
          kind: 'segbar', width: 54,
          segments: [
            { value: active, color: HUE.accent, label: '学习日' },
            { value: Math.max(0, x.daily.length - active), color: '#e4e8f0', label: '空白日' }
          ]
        }
      }),
      SH.statCard({
        label: '达标天数', value: `${hitDays}/${x.daily.length}`, icon: 'target',
        desc: `目标 ${F.dur(goal)}/天`,
        tone: hitRate >= 0.6 ? undefined : 'warn',
        visual: { kind: 'progressRing', ratio: hitRate, size: 46, thickness: 5, value: String(Math.round(hitRate * 100)) }
      }),
      SH.statCard({
        label: '专注力评分', value: x.score.score, unit: '/100', icon: 'sparkle',
        desc: `每段均 ${F.dur(avgLen)} · 中断 ${inter}`,
        visual: { kind: 'ring', ratio: x.score.score / 100, size: 44, thickness: 5.5 }
      }));
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
      body.appendChild(h('tr', { dataset: { subjectRow: s.subjectId } },
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
