/* views/dashboard.js —— 仪表盘：一眼看清「今天的进度」和「最该动手的那件事」
 *
 * 这一屏的设计目标只有一个：**尽量不用读数字就知道现状**。
 * 所以「今日专注 2 小时 15 分 / 目标 3 小时 20 分」这类句子，
 * 全部换成了环、条、点阵 —— 数字仍然在，但退到图形旁边做精确说明。
 */
(function () {
  'use strict';
  const SH = window.SH;
  const h = SH.h, api = SH.api, F = SH.fmt;
  const C = SH.charts, V = SH.viz;

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
      root.appendChild(heroCard(S, x));
      root.appendChild(h('h2', { class: 'section' }, '今天该做的事'));
      root.appendChild(h('div', { class: 'grid g-1-2' }, todayTaskCard(S), alertCard(S, x)));
      if (x.srsQueue.total || x.srsQueue.upcoming.length) {
        root.appendChild(h('h2', { class: 'section' }, '到期的复习'));
        root.appendChild(srsCard(S, x.srsQueue));
      }
      root.appendChild(h('h2', { class: 'section' }, '学习节奏'));
      root.appendChild(h('div', { class: 'grid g-2-1' }, trendCard(x.daily14, S.overview), subjectCard(x.subs, S.db.subjects || [])));
      root.appendChild(h('h2', { class: 'section' }, '长期趋势'));
      root.appendChild(h('div', { class: 'grid g-2-1' }, heatCard(x.heat, S.db.profile.weekStart), hourCard(x.hourly)));
      root.appendChild(h('h2', { class: 'section' }, '本周节奏'));
      root.appendChild(weekCard(x.daily14, S.overview));
      const recents = (S.db.materials || []).filter((m) => m.lastOpenedAt).sort((a, b) => new Date(b.lastOpenedAt) - new Date(a.lastOpenedAt)).slice(0, 4);
      if (recents.length) {
        root.appendChild(h('h2', { class: 'section' }, '最近在学'));
        root.appendChild(h('div', { class: 'mat-grid' }, recents.map((m) => SH.views.materials.card(m, S, () => SH.app.previewById(m.id)))));
      }
    }
  };

  /* ================================================================== *
   * 今日全景：一块图形说完今天的所有状态
   *
   * 为什么把四张卡合并成一块：原来四张卡各说一件事，观者要自己在脑子里
   * 把「今天 2 小时」「任务 3/8」「复习 4 个」「连续 6 天」拼成一句判断。
   * 合成一块后，环给出「离目标还差多少」这个主判断，三条进度条给出分支细节。
   * ================================================================== */
  function heroCard(S, x) {
    const ov = S.overview;
    const t = ov.todayMinutes || 0;
    const goal = ov.dailyGoalMin || 0;
    const ratio = goal ? t / goal : (t > 0 ? 1 : 0);
    const HUE = V.HUE;

    const tasks = ov.todayTasks || [];
    const doneN = tasks.filter((r) => r.done).length;
    const due = (x.srsQueue.overdue || []).length + (x.srsQueue.due || []).length;
    const overdue = (x.srsQueue.overdue || []).length;

    const ring = V.progressRing({
      ratio: Math.min(1, ratio),
      size: 152, thickness: 14,
      value: F.hm(t),
      sub: goal ? `目标 ${F.hm(goal)}` : '未设目标',
      color: ratio >= 1 ? HUE.ok : HUE.accent
    });

    const rows = h('div', { class: 'viz-stack', style: { flex: '1', minWidth: 0 } });
    rows.appendChild(SH.vizHead('今日推进', `${ov.todaySessions || 0} 段专注`));

    rows.appendChild(SH.meterRow({
      label: '任务',
      value: doneN,
      max: tasks.length || 1,
      display: tasks.length ? `${doneN}/${tasks.length}` : '无任务',
      tone: tasks.length && doneN === tasks.length ? 'ok' : undefined,
      sub: tasks.length && doneN < tasks.length ? `还剩 ${tasks.length - doneN} 项` : ''
    }));

    rows.appendChild(SH.meterRow({
      label: '复习',
      value: Math.max(0, due - overdue),
      max: Math.max(due, 1),
      display: due ? `${due} 个` : '已清空',
      tone: overdue ? 'danger' : due ? 'warn' : 'ok',
      sub: overdue ? `其中 ${overdue} 个逾期` : ''
    }));

    const streakGoal = Math.max(ov.streak.best || 0, 7);
    rows.appendChild(SH.meterRow({
      label: '连续打卡',
      value: ov.streak.current || 0,
      max: streakGoal,
      display: `${ov.streak.current || 0} 天`,
      tone: ov.todayMinutes > 0 ? 'ok' : 'warn',
      sub: `最长 ${ov.streak.best || 0} 天`
    }));

    // 今天还没开始且已有连续记录 → 用一句醒目的话把「要断了」说出来
    const risk = ov.streak.current >= 3 && t < 10;
    if (risk) {
      rows.appendChild(h('div', { class: 'row', style: { gap: '8px', marginTop: '4px' } },
        h('span', { class: 'chip danger' }, `${SH.icon('flame', 12)} 今天还没续上`),
        h('button', { class: 'btn sm primary', onClick: () => SH.app.startFocus({}) }, '立刻开始 15 分钟')));
    } else if (ratio >= 1) {
      rows.appendChild(h('div', { style: { marginTop: '4px' } },
        h('span', { class: 'chip ok' }, '今天的目标已达成')));
    }

    const sc = ov.score;
    return h('div', { class: 'card' },
      h('div', { class: 'card-body' },
        h('div', { class: 'viz-split' },
          h('div', { class: 'viz-main', onClick: () => SH.app.go('focus'), title: '去做一段专注' }, SH.html(ring)),
          rows)),
      h('div', { style: { borderTop: '1px solid var(--border)', padding: '12px 20px' } },
        h('div', { class: 'grid g4', style: { gap: '14px' } },
          miniKpi('本周专注力', `${sc.score}`, '/100', C.ring({ ratio: sc.score / 100, size: 40, thickness: 5, color: sc.score >= 80 ? HUE.ok : sc.score >= 60 ? HUE.accent : HUE.warn }), () => SH.app.go('review')),
          miniKpi('本周累计', F.dur(ov.weekMinutes), '', C.ring({ ratio: ov.weeklyGoalMin ? Math.min(1, ov.weekMinutes / ov.weeklyGoalMin) : 0, size: 40, thickness: 5 }), () => SH.app.go('stats')),
          miniKpi('任务完成', `${ov.weekTaskStats.done}/${ov.weekTaskStats.total}`, '', null, () => SH.app.go('plans'), ov.weekTaskStats),
          miniKpi('活跃天数', `${ov.streak.activeDays}`, '天', null, () => SH.app.go('stats')))));
  }

  /** 一行式指标：标题 + 大数字 + 右侧小环。用于把四个次要指标压成一行 */
  function miniKpi(title, value, unit, ring, onClick, taskStat) {
    const right = ring
      ? SH.html(ring)
      : (taskStat ? h('div', { style: { width: '46px' } }, SH.segmentedBar([
        { value: taskStat.done, color: 'var(--ok)' },
        { value: Math.max(0, taskStat.total - taskStat.done), color: 'var(--border-strong)' }
      ], 8)) : null);
    return h('div', {
      class: 'ring-kpi' + (onClick ? ' viz-clickable' : ''),
      onClick, role: onClick ? 'button' : null, tabindex: onClick ? '0' : null
    },
      h('div', { class: 'rk-body', style: { flex: '1' } },
        h('div', { class: 'rk-title' }, title),
        h('div', { style: { fontSize: '17px', fontWeight: '700', fontVariantNumeric: 'tabular-nums' } },
          value, unit ? h('small', { style: { fontSize: '11px', fontWeight: '500', color: 'var(--muted)' } }, unit) : null)),
      right);
  }

  /* ---------------- 到期复习 ---------------- */
  function srsCard(S, q) {
    const today = [...q.overdue, ...q.due];
    const st = S.review || {};
    const card = h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', null, '复习队列'),
        h('div', { class: 'grow', style: { flex: '1' } }),
        h('span', { class: 'chip ' + (q.overdue.length ? 'danger' : today.length ? 'accent' : 'ok') },
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

    // 顶部先用一段分段条把「逾期 / 今天 / 后续」的比例说清楚
    const later = (q.upcoming || []).length;
    card.appendChild(h('div', { class: 'card-body', style: { paddingBottom: '4px' } },
      SH.segmentedBar([
        { value: q.overdue.length, color: 'var(--danger)', label: '逾期' },
        { value: q.due.length, color: 'var(--accent)', label: '今天' },
        { value: later, color: 'var(--border-strong)', label: '后续' }
      ], 8),
      h('div', { class: 'row', style: { gap: '14px', marginTop: '8px', fontSize: '11.5px', color: 'var(--muted)' } },
        legendDot('var(--danger)', `逾期 ${q.overdue.length}`),
        legendDot('var(--accent)', `今天 ${q.due.length}`),
        legendDot('var(--border-strong)', `后续 ${later}`))));

    const list = h('div', { class: 'list' });
    today.slice(0, 6).forEach((r) => {
      const sub = subjOf(S.db, r.subjectId);
      const late = r.nextAt && r.nextAt < F.dayKey();
      // 卡片右侧用一圈小小的「阶段进度」代替「第 3 轮」这行字
      const stagePct = Math.min(1, (r.stage || 0) / 6);
      list.appendChild(h('div', { class: 'list-item' },
        h('span', { class: 'chip ' + (late ? 'danger' : 'accent') }, late ? '逾期' : '今天'),
        h('div', { style: { flex: '1', minWidth: 0 } },
          h('div', { class: 'li-title ellipsis' }, r.title),
          h('div', { class: 'li-sub row', style: { gap: '8px' } },
            h('span', { class: 'nowrap' }, `第 ${r.stage + 1} 轮`),
            r.lapses ? h('span', { class: 'nowrap', style: { color: 'var(--warn)' } }, `遗忘 ${r.lapses} 次`) : null,
            sub ? h('span', { class: 'row nowrap', style: { gap: '5px' } },
              h('span', { class: 'subj-dot', style: { background: sub.color } }), sub.name) : null)),
        SH.html(C.ring({ ratio: stagePct, size: 26, thickness: 3.5, color: late ? 'var(--danger)' : 'var(--accent)' })),
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

  function legendDot(color, text) {
    return h('span', { class: 'row nowrap', style: { gap: '5px', alignItems: 'center' } },
      h('span', { style: { width: '8px', height: '8px', borderRadius: '3px', background: color, display: 'inline-block' } }),
      text);
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
      // 点阵：完成了几项、还剩几项，一眼看得出密度
      body.appendChild(h('div', { style: { padding: '0 4px 12px' } },
        SH.html(V.dotMatrix({
          dots: rows.map((r) => ({ done: r.done, title: `${r.done ? '已完成' : '未完成'}：${r.title}` })),
          cols: 12, size: 12, gap: 6
        }))));
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
        rows.length ? SH.html(C.ring({ ratio: doneN / rows.length, size: 22, thickness: 3.2, color: doneN === rows.length ? '#0f9d6e' : '#3b5bfd' })) : null,
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
      // 按严重程度给一条左侧色带，让「哪条更急」不用读文字就能分辨
      const list = h('div', { class: 'list' });
      items.slice(0, 6).forEach((it) => {
        const col = it.level === 'danger' ? 'var(--danger)' : it.level === 'warn' ? 'var(--warn)' : 'var(--accent)';
        list.appendChild(h('div', { class: 'list-item', style: { boxShadow: `inset 3px 0 0 ${col}` } },
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
        items.length ? h('span', { class: 'chip ' + (items.some((i) => i.level === 'danger') ? 'danger' : 'warn') }, `${items.length} 条`) : null,
        h('button', { class: 'btn sm ghost', onClick: () => SH.app.go('review') }, '本周复盘')),
      body);
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
    // 达标天数：柱高过目标线的天数，是比「日均」更能说明稳定性的指标
    const hitDays = daily.filter((d) => goal && d.minutes >= goal).length;

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
        h('span', { class: 'small muted' }, goal ? `达标 ${hitDays}/14 天` : `有效 ${activeDays}/14 天`),
        tabs),
      h('div', { class: 'card-body' }, chartBox,
        // 三个关键值用条形并列，比三个数字更容易比较
        h('div', { class: 'grid g3', style: { marginTop: '12px', gap: '16px' } },
          SH.meterRow({ label: '日均', value: avg, max: Math.max(avg, goal || 1), display: F.dur(avg), color: 'var(--accent)' }),
          SH.meterRow({ label: '最高一天', value: Math.max(...daily.map((d) => d.minutes), 0), max: Math.max(avg, goal || 1), display: F.dur(Math.max(...daily.map((d) => d.minutes), 0)), color: 'var(--ok)' }),
          SH.meterRow({ label: '有效天数', value: activeDays, max: 14, display: `${activeDays}/14`, color: 'var(--info)' }))));
  }

  /* ---------------- 科目占比 ---------------- */
  function subjectCard(subs, subjects) {
    const items = subs.map((s) => ({ label: s.name, value: s.minutes, color: s.color }));
    const total = items.reduce((a, b) => a + b.value, 0);
    const body = h('div', { class: 'row', style: { gap: '18px', alignItems: 'center' } });
    body.appendChild(SH.html(C.donut({
      items, size: 160,
      centerTop: total ? F.hm(total) : '',
      centerSub: '近 30 天(小时:分)'
    })));
    const legend = h('div', { class: 'legend', style: { flex: '1', minWidth: 0 } });
    if (!items.length) legend.appendChild(h('div', { class: 'small muted' }, '还没有学习记录'));
    items.slice(0, 6).forEach((it) => {
      const subj = subjects.find((s) => s.name === it.label);
      const goal = subj && subj.goalMinPerWeek;
      const pct = Math.round((it.value / (total || 1)) * 100);
      legend.appendChild(h('div', {
        class: 'legend-row' + (subj ? ' viz-clickable' : ''),
        onClick: subj ? () => SH.app.go('stats') : null
      },
        h('span', { class: 'subj-dot', style: { background: it.color } }),
        h('span', { class: 'lg-name' }, it.label),
        // 占比画成一小段条，比一个 "%" 更能比较大小
        h('span', { style: { width: '46px', flex: '0 0 46px' } },
          h('span', { class: 'hb-track', style: { display: 'block' } },
            h('i', { class: 'hb-fill', style: { width: pct + '%', background: it.color } }))),
        h('span', { class: 'lg-val' }, F.hm(it.value)),
        h('span', { class: 'lg-pct' }, pct + '%')));
    });
    body.appendChild(legend);

    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', null, '科目投入占比'),
        h('div', { class: 'grow', style: { flex: '1' } }),
        h('button', { class: 'btn sm ghost', onClick: () => SH.app.go('stats') }, '详细统计')),
      h('div', { class: 'card-body' }, body));
  }

  /* ---------------- 热力图 ---------------- */
  function heatCard(heat, weekStart) {
    const active = heat.filter((d) => d.minutes > 0).length;
    const total = heat.reduce((a, b) => a + b.minutes, 0);
    // 连续空白最长的一段：比「有记录 X 天」更能指出问题
    let gap = 0, cur = 0;
    heat.forEach((d) => { if (!d.minutes) { cur++; gap = Math.max(gap, cur); } else cur = 0; });
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', null, '打卡热力图'),
        h('div', { class: 'grow', style: { flex: '1' } }),
        h('span', { class: 'small muted' }, `近 18 周 · 有记录 ${active} 天 · 共 ${F.dur(total)}`),
        gap >= 3 ? h('span', { class: 'chip warn' }, `最长中断 ${gap} 天`) : null),
      h('div', { class: 'card-body' }, SH.html(C.heatHTML({ days: heat, weekStart }))));
  }

  /* ---------------- 时段分布 ---------------- */
  function hourCard(buckets) {
    const rows = buckets.map((v, i) => ({ v, i })).filter((r) => r.v > 0).sort((a, b) => b.v - a.v);
    const best = rows.slice(0, 3).map((r) => `${r.i} 点`).join('、');

    // 把 24 小时按「凌晨/上午/下午/晚上」分组给一段分段条，
    // 这样「我的时间主要花在哪个时段」不需要去数柱子的位置
    const seg = (a, b) => buckets.slice(a, b).reduce((x, y) => x + y, 0);
    const parts = [
      { label: '凌晨 0-6', value: seg(0, 6), color: '#7c3aed' },
      { label: '上午 6-12', value: seg(6, 12), color: '#0891b2' },
      { label: '下午 12-18', value: seg(12, 18), color: '#3b5bfd' },
      { label: '晚上 18-24', value: seg(18, 24), color: '#0f9d6e' }
    ].filter((p) => p.value > 0);
    const segTotal = parts.reduce((a, b) => a + b.value, 0) || 1;

    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', null, '常学时段（近 30 天）'),
        h('div', { class: 'grow', style: { flex: '1' } }),
        best ? h('span', { class: 'small muted' }, `黄金时段：${best}`) : null),
      h('div', { class: 'card-body' },
        SH.html(C.hourStrip({ buckets })),
        parts.length ? h('div', { style: { marginTop: '12px' } },
          SH.segmentedBar(parts, 9),
          h('div', { class: 'row', style: { gap: '12px', marginTop: '8px', flexWrap: 'wrap', fontSize: '11.5px', color: 'var(--muted)' } },
            ...parts.map((p) => legendDot(p.color, `${p.label} ${Math.round((p.value / segTotal) * 100)}%`)))) : null,
        h('div', { class: 'small muted', style: { marginTop: '10px' } },
          '知道自己几点效率最高，把最难的内容排到那个时段。')));
  }

  /* ---------------- 本周节奏 ---------------- */
  function weekCard(daily, ov) {
    // 取当前这一周的 7 天（而不是「最近 7 天」）——「这周还剩几天」是更常用的判断
    const days = daily.slice(-7);
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', null, '本周每日达成'),
        h('div', { class: 'grow', style: { flex: '1' } }),
        h('span', { class: 'small muted' }, `目标 ${F.dur(ov.dailyGoalMin)}/天`)),
      h('div', { class: 'card-body' },
        SH.html(V.weekStrip({ days, goal: ov.dailyGoalMin, weekStart: 1 }))));
  }
})();
