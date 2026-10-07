/* views/dashboard.js —— 仪表盘：一眼看清「今天的进度」和「最该动手的那件事」 */
(function () {
  'use strict';
  const SH = window.SH;
  const h = SH.h, api = SH.api, F = SH.fmt;
  const C = SH.charts;

  function subjOf(db, id) { return (db.subjects || []).find((s) => s.id === id) || null; }

  SH.views.dashboard = {
    title: '仪表盘',
    sub(S) {
      const d = new Date();
      const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
      const hello = d.getHours() < 6 ? '夜深了' : d.getHours() < 11 ? '早上好' : d.getHours() < 14 ? '中午好' : d.getHours() < 18 ? '下午好' : '晚上好';
      const name = S.db.profile.name ? `，${S.db.profile.name}` : '';
      return `${hello}${name} · ${d.getMonth() + 1} 月 ${d.getDate()} 日 周${wd}`;
    },

    async load(S) {
      const [daily14, heat, subs, planReport, matReport, hourly, srsQueue] = await Promise.all([
        api.stats.daily(14),
        api.stats.heatmap(18),
        api.stats.subjects(F.dayKey(new Date(Date.now() - 29 * 86400000)), F.dayKey()),
        api.stats.planReport(),
        api.stats.materialReport(),
        api.stats.hourly(30),
        api.reviews.queue(F.dayKey())
      ]);
      return { daily14, heat, subs, planReport, matReport, hourly, srsQueue };
    },

    render(root, S, x) {
      const db = S.db, ov = S.overview;
      root.appendChild(statsRow(S));
      root.appendChild(h('h2', { class: 'section' }, '今天该做的事'));
      root.appendChild(h('div', { class: 'grid g-1-2' }, todayTaskCard(S), alertCard(S, x)));
      if (x.srsQueue.total || x.srsQueue.upcoming.length) {
        root.appendChild(h('h2', { class: 'section' }, '到期的复习'));
        root.appendChild(srsCard(S, x.srsQueue));
      }
      root.appendChild(h('h2', { class: 'section' }, '学习节奏'));
      root.appendChild(h('div', { class: 'grid g-2-1' }, trendCard(x.daily14, ov), subjectCard(x.subs)));
      root.appendChild(h('h2', { class: 'section' }, '长期趋势'));
      root.appendChild(h('div', { class: 'grid g-2-1' }, heatCard(x.heat, db.profile.weekStart), hourCard(x.hourly)));
      const recents = (db.materials || []).filter((m) => m.lastOpenedAt).sort((a, b) => new Date(b.lastOpenedAt) - new Date(a.lastOpenedAt)).slice(0, 4);
      if (recents.length) {
        root.appendChild(h('h2', { class: 'section' }, '最近在学'));
        root.appendChild(h('div', { class: 'mat-grid' }, recents.map((m) => SH.views.materials.card(m, S, () => SH.app.previewById(m.id)))));
      }
    }
  };

  /* ---------------- 到期复习 ---------------- */
  function srsCard(S, q) {
    const today = [...q.overdue, ...q.due];
    const st = S.review || {};
    const card = h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', null, '复习队列'),
        h('div', { class: 'grow', style: { flex: '1' } }),
        h('span', { class: 'chip ' + (q.overdue.length ? 'danger' : today.length ? 'accent' : '') },
          today.length ? `今天 ${today.length} 个` : '今天已清空'),
        st.retention != null ? h('span', { class: 'small muted' }, `记忆保持率 ${st.retention}%`) : null,
        h('button', { class: 'btn sm', onClick: () => SH.app.go('srs') }, '去复习')));

    if (!today.length) {
      card.appendChild(h('div', { class: 'card-body small muted' },
        q.upcoming.length
          ? `下一个到期：${F.dayLabel(q.upcoming[0].nextAt, true)} · ${q.upcoming[0].title}`
          : '队列是空的。'));
      return card;
    }

    const list = h('div', { class: 'list' });
    today.slice(0, 6).forEach((r) => {
      const sub = subjOf(S.db, r.subjectId);
      const late = r.nextAt && r.nextAt < F.dayKey();
      list.appendChild(h('div', { class: 'list-item' },
        h('span', { class: 'chip ' + (late ? 'danger' : 'accent') }, late ? '逾期' : '今天'),
        h('div', { style: { flex: '1', minWidth: 0 } },
          h('div', { class: 'li-title ellipsis' }, r.title),
          h('div', { class: 'li-sub row', style: { gap: '8px' } },
            h('span', { class: 'nowrap' }, `第 ${r.stage + 1} 轮`),
            r.lapses ? h('span', { class: 'nowrap' }, `遗忘 ${r.lapses} 次`) : null,
            sub ? h('span', { class: 'row nowrap', style: { gap: '5px' } },
              h('span', { class: 'subj-dot', style: { background: sub.color } }), sub.name) : null)),
        h('button', {
          class: 'btn sm primary', onClick: async () => {
            await api.reviews.grade(r.id, 'good');
            SH.toast({ title: '记下了', kind: 'ok', timeout: 1800 });
            SH.app.refresh();
          }
        }, '记住了'),
        h('button', {
          class: 'btn sm ghost', onClick: () => SH.app.go('srs')
        }, '展开')));
    });
    card.appendChild(list);
    return card;
  }

  /* ---------------- 顶部四张卡 ---------------- */
  function statsRow(S) {
    const ov = S.overview;
    const t = ov.todayMinutes, goal = ov.dailyGoalMin;
    const goalRate = Math.min(1, t / (goal || 1));

    const card1 = h('div', { class: 'stat accent' },
      h('div', { class: 'k' }, SH.iconEl('timer', 14), '今日专注'),
      h('div', { class: 'v' }, F.dur(t), ''),
      h('div', { class: 'd' }, `目标 ${F.dur(goal)} · ${ov.todaySessions} 段`),
      h('div', { style: { marginTop: '10px' } },
        h('div', { class: 'progress', style: { background: 'rgba(255,255,255,.28)' } },
          h('i', { style: { width: (goalRate * 100).toFixed(1) + '%', background: '#fff' } }))),
      h('div', { class: 'd', style: { marginTop: '6px' } },
        goalRate >= 1 ? '今天的目标已经达成 🎉' : `还差 ${F.dur(goal - t)}`));

    const streakRisk = ov.todayMinutes < 10 && ov.streak.current >= 3;
    const card2 = h('div', { class: 'stat' },
      h('div', { class: 'k' }, SH.iconEl('flame', 14), '连续打卡'),
      h('div', { class: 'v' }, String(ov.streak.current), h('small', null, '天')),
      h('div', { class: 'd' }, `历史最长 ${ov.streak.best} 天 · 累计 ${ov.streak.activeDays} 天`),
      streakRisk ? h('div', { style: { marginTop: '10px' } }, h('span', { class: 'chip danger' }, '今天还没开始，要断了')) : null);

    const sc = ov.score;
    const card3 = h('div', { class: 'stat' },
      h('div', { class: 'k' }, SH.iconEl('target', 14), '本周专注力'),
      h('div', { class: 'v' }, String(sc.score), h('small', null, '/ 100')),
      h('div', { class: 'd' },
        `达成 ${sc.parts.goalRate}% · 计划 ${sc.parts.planRate}% · 无欠账 ${sc.parts.noDebt}%`),
      h('div', { style: { marginTop: '10px' } },
        SH.progressBar(sc.score / 100, sc.score >= 80 ? 'ok' : sc.score >= 60 ? '' : 'warn')));

    const wp = Math.min(1, ov.weekMinutes / (ov.weeklyGoalMin || 1));
    const card4 = h('div', { class: 'stat' },
      h('div', { class: 'k' }, SH.iconEl('stats', 14), '本周累计'),
      h('div', { class: 'v' }, F.dur(ov.weekMinutes), ''),
      h('div', { class: 'd' }, `目标 ${F.dur(ov.weeklyGoalMin)} · ${ov.weekSessions} 段`),
      h('div', { style: { marginTop: '10px' } }, SH.progressBar(wp, wp >= 1 ? 'ok' : '')),
      h('div', { class: 'd', style: { marginTop: '6px' } }, `任务完成 ${ov.weekTaskStats.done}/${ov.weekTaskStats.total}`));

    return h('div', { class: 'grid g4' }, card1, card2, card3, card4);
  }

  /* ---------------- 趋势 ---------------- */
  function trendCard(daily, ov) {
    const data = daily.map((d) => ({
      label: d.date.slice(5).replace('-', '/'),
      value: d.minutes,
      title: `${F.dayLabel(d.date, true)}：${F.dur(d.minutes)}（${d.sessions} 段）`
    }));
    const goal = ov.dailyGoalMin;
    const total = daily.reduce((a, b) => a + b.minutes, 0);
    const activeDays = daily.filter((d) => d.minutes > 0).length;
    const avg = Math.round(total / Math.max(1, daily.length));

    const tabs = h('div', { class: 'pill-tabs' });
    const chartBox = h('div', { style: { marginTop: '4px' } });
    let mode = 'bar';
    const draw = () => {
      chartBox.innerHTML = mode === 'bar'
        ? C.bars({ data, height: 200, goal, labelEvery: 1 })
        : C.area({ data, height: 200, goal, labelEvery: 1 });
    };
    ['柱状', '折线'].forEach((label) => {
      const b = h('button', { class: mode === (label === '柱状' ? 'bar' : 'line') ? 'active' : '' }, label);
      b.addEventListener('click', () => {
        mode = label === '柱状' ? 'bar' : 'line';
        [...tabs.children].forEach((c) => c.classList.remove('active'));
        b.classList.add('active');
        draw();
      });
      tabs.appendChild(b);
    });
    draw();

    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', null, '近 14 天专注时长'),
        h('div', { class: 'grow', style: { flex: '1' } }),
        h('span', { class: 'small muted' }, `日均 ${F.dur(avg)} · 有效 ${activeDays}/14 天`),
        tabs),
      h('div', { class: 'card-body' }, chartBox));
  }

  /* ---------------- 科目占比 ---------------- */
  function subjectCard(subs) {
    const items = subs.map((s) => ({ label: s.name, value: s.minutes, color: s.color }));
    const total = items.reduce((a, b) => a + b.value, 0);
    const body = h('div', { class: 'row', style: { gap: '18px', alignItems: 'center' } });
    body.appendChild(SH.html(C.donut({
      items, size: 160,
      centerTop: total ? F.hm(total) : '',
      centerSub: '近 30 天(小时:分)'
    })));
    const legend = h('div', { style: { flex: '1', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '8px' } });
    if (!items.length) legend.appendChild(h('div', { class: 'small muted' }, '还没有学习记录'));
    items.slice(0, 6).forEach((it) => {
      legend.appendChild(h('div', { class: 'row', style: { gap: '8px', fontSize: '12.5px' } },
        h('span', { class: 'subj-dot', style: { background: it.color } }),
        h('span', { class: 'ellipsis', style: { flex: '1' } }, it.label),
        h('span', { class: 'mono small', style: { color: 'var(--text-2)' } }, F.hm(it.value)),
        h('span', { class: 'small muted', style: { width: '38px', textAlign: 'right' } },
          Math.round((it.value / (total || 1)) * 100) + '%')));
    });
    body.appendChild(legend);

    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', null, '科目投入占比')),
      h('div', { class: 'card-body' }, body));
  }

  /* ---------------- 今日任务 ---------------- */
  function todayTaskCard(S) {
    const rows = S.overview.todayTasks;
    const doneN = rows.filter((r) => r.done).length;
    const body = h('div', { style: { padding: '4px 0' } });

    if (!rows.length) {
      body.appendChild(SH.empty('今天没有排定的任务', '到「学习计划」里拆出今天要做的事，或者直接开一段自由专注。', 'plan'));
      body.appendChild(h('div', { class: 'row', style: { justifyContent: 'center', gap: '8px' } },
        h('button', { class: 'btn', onClick: () => SH.app.go('plans') }, '去制定计划'),
        h('button', { class: 'btn primary', onClick: () => SH.app.go('focus') }, '直接开始专注')));
    } else {
      const list = h('div', { class: 'list' });
      rows.forEach((r) => {
        const sub = subjOf(S.db, r.subjectId);
        list.appendChild(h('div', { class: 'list-item' },
          h('div', {
            class: 'check' + (r.done ? ' on' : ''),
            html: SH.icon('check', 12),
            onClick: async () => {
              await api.plans.toggleTask(r.planId, r.taskId, F.dayKey());
              SH.app.refresh();
            }
          }),
          h('div', { style: { flex: '1', minWidth: 0 } },
            h('div', { class: 'li-title' + (r.done ? ' muted' : ''), style: r.done ? { textDecoration: 'line-through' } : null }, r.title),
            h('div', { class: 'li-sub row', style: { gap: '8px', flexWrap: 'wrap' } },
              sub ? h('span', { class: 'row nowrap', style: { gap: '5px' } }, h('span', { class: 'subj-dot', style: { background: sub.color } }), sub.name) : null,
              h('span', { class: 'nowrap' }, '预计 ' + F.dur(r.estMin)),
              h('span', { class: 'ellipsis nowrap', style: { maxWidth: '140px' }, title: r.plan }, r.plan))),
          !r.done ? h('button', {
            class: 'btn sm', html: SH.icon('play', 12), title: '开始专注',
            onClick: () => SH.app.startFocus({ subjectId: r.subjectId || '', taskId: r.taskId, planId: r.planId })
          }) : null));
      });
      body.appendChild(list);
    }

    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', null, '今日任务'),
        h('div', { class: 'grow', style: { flex: '1' } }),
        h('span', { class: 'chip' + (rows.length && doneN === rows.length ? ' ok' : '') }, `${doneN} / ${rows.length}`)),
      h('div', { style: { padding: '0' } }, body));
  }

  /* ---------------- 监督预警 ---------------- */
  function alertCard(S, x) {
    const items = [];

    S.overview.todayTasks.filter((t) => !t.done && t.estMin >= 30).forEach((t) => {
      items.push({ level: 'info', icon: 'plan', text: `「${t.title}」还没开始`, act: '开始专注', go: () => SH.app.startFocus({ subjectId: t.subjectId || '', taskId: t.taskId, planId: t.planId }) });
    });

    x.planReport.filter((p) => p.overdue > 0).forEach((p) => {
      items.push({
        level: p.risk === 'high' ? 'danger' : 'warn',
        icon: 'alert',
        text: `计划「${p.title}」有 ${p.overdue} 项逾期未完成`,
        act: '去看看',
        go: () => SH.app.go('plans')
      });
    });

    const neverOpened = x.matReport.neverOpened.length;
    if (neverOpened) {
      items.push({
        level: 'warn', icon: 'material',
        text: `有 ${neverOpened} 份资料加入后从未打开过`,
        act: '清理或开始', go: () => SH.app.go('materials')
      });
    }
    if (x.matReport.idle.length) {
      items.push({
        level: 'info', icon: 'clock',
        text: `${x.matReport.idle.length} 份资料超过 ${x.matReport.idleDays} 天没碰过`,
        act: '查看', go: () => SH.app.go('materials')
      });
    }

    const ov = S.overview;
    if (ov.streak.current >= 3 && ov.todayMinutes < 10) {
      items.push({ level: 'danger', icon: 'flame', text: `连续 ${ov.streak.current} 天的记录今天还没续上`, act: '开始 15 分钟', go: () => SH.app.go('focus') });
    }
    if (ov.weekMinutes < (ov.weeklyGoalMin || 720) * 0.5 && new Date().getDay() >= 4) {
      items.push({
        level: 'warn', icon: 'stats',
        text: `本周已过一半以上，只完成周目标的 ${Math.round((ov.weekMinutes / (ov.weeklyGoalMin || 1)) * 100)}%`,
        act: '看统计', go: () => SH.app.go('stats')
      });
    }

    const body = h('div');
    if (!items.length) {
      body.appendChild(SH.empty('没有需要提醒的事', '任务都在轨道上，保持这个节奏。', 'sparkle'));
    } else {
      const list = h('div', { class: 'list' });
      items.slice(0, 6).forEach((it) => {
        list.appendChild(h('div', { class: 'list-item' },
          h('span', { class: 'chip ' + (it.level === 'danger' ? 'danger' : it.level === 'warn' ? 'warn' : ''), style: { flex: '0 0 auto' } },
            SH.iconEl(it.icon, 12)),
          h('div', { style: { flex: '1', minWidth: 0, fontSize: '13px' } }, it.text),
          h('button', { class: 'btn sm', onClick: it.go }, it.act)));
      });
      body.appendChild(list);
    }

    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', null, '监督提醒'),
        h('div', { class: 'grow', style: { flex: '1' } }),
        h('button', { class: 'btn sm ghost', onClick: () => SH.app.go('review') }, '本周复盘')),
      body);
  }

  /* ---------------- 热力图 ---------------- */
  function heatCard(heat, weekStart) {
    const active = heat.filter((d) => d.minutes > 0).length;
    const total = heat.reduce((a, b) => a + b.minutes, 0);
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', null, '打卡热力图'),
        h('div', { class: 'grow', style: { flex: '1' } }),
        h('span', { class: 'small muted' }, `近 18 周 · 有记录 ${active} 天 · 共 ${F.dur(total)}`)),
      h('div', { class: 'card-body' }, SH.html(C.heatHTML({ days: heat, weekStart }))));
  }

  /* ---------------- 时段分布 ---------------- */
  function hourCard(buckets) {
    const rows = buckets.map((v, i) => ({ v, i })).filter((r) => r.v > 0).sort((a, b) => b.v - a.v);
    const best = rows.slice(0, 3).map((r) => `${r.i} 点`).join('、');
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', null, '常学时段（近 30 天）'),
        h('div', { class: 'grow', style: { flex: '1' } }),
        best ? h('span', { class: 'small muted' }, `黄金时段：${best}`) : null),
      h('div', { class: 'card-body' },
        SH.html(C.hourStrip({ buckets })),
        h('div', { class: 'small muted', style: { marginTop: '6px' } },
          '知道自己几点效率最高，把最难的内容排到那个时段。')));
  }
})();
