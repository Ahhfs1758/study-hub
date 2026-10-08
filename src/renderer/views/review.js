/* views/review.js —— 监督复盘：这一周到底做得怎么样，下一步该改什么 */
(function () {
  'use strict';
  const SH = window.SH;
  const h = SH.h, api = SH.api, F = SH.fmt;
  const C = SH.charts;

  let weekOffset = 0;
  const WEEK_LABEL = { 0: '本周', '-1': '上周', '-2': '上上周' };

  SH.views.review = {
    title: '监督复盘',
    sub: () => '不看数字只看感觉，复盘就会变成自我安慰',

    async load(S) {
      const [report, prev, planRep, matRep, heat, ov] = await Promise.all([
        api.stats.weeklyReport(weekOffset),
        api.stats.weeklyReport(weekOffset - 1),
        api.stats.planReport(),
        api.stats.materialReport(),
        api.stats.heatmap(26),
        api.stats.overview()
      ]);
      return { report, prev, planRep, matRep, heat, ov };
    },

    render(root, S, x) {
      root.appendChild(weekBar());
      root.appendChild(scoreCard(S, x));
      root.appendChild(h('div', { class: 'grid g-2-1' }, dailyCard(S, x), compareCard(S, x)));
      root.appendChild(h('h2', { class: 'section' }, '本周复盘'));
      root.appendChild(h('div', { class: 'grid g2' }, taskCard(S, x), missedCard(S, x)));
      root.appendChild(h('h2', { class: 'section' }, '风险与欠账'));
      root.appendChild(h('div', { class: 'grid g2' }, riskCard(S, x), matCard(S, x)));
      root.appendChild(h('h2', { class: 'section' }, '长期坚持'));
      root.appendChild(heatCard(S, x));
      root.appendChild(reportActions(S, x));
    }
  };

  function weekBar() {
    const bar = h('div', { class: 'row', style: { marginBottom: '14px', gap: '10px' } });
    const tabs = h('div', { class: 'pill-tabs' });
    [0, -1, -2, -3].forEach((o) => {
      const b = h('button', { class: weekOffset === o ? 'active' : '' }, WEEK_LABEL[String(o)] || `${-o} 周前`);
      b.addEventListener('click', () => { weekOffset = o; SH.app.reload(); });
      tabs.appendChild(b);
    });
    bar.appendChild(tabs);
    bar.appendChild(h('div', { style: { flex: '1' } }));
    bar.appendChild(h('button', { class: 'btn sm', onClick: () => window.print() }, '打印 / 存 PDF'));
    return bar;
  }

  /* ------------------------------------------------------------------ *
   * 评分：仪表 + 雷达
   *
   * 原来是一个圆环 + 四行「标签 权重 进度条」。问题是：
   *   · 圆环看不出「满分是多少、我离满分多远」——仪表有刻度，一眼就有位置感
   *   · 四个维度各自一条平行条，看不出「形状」——而形状恰恰是最有用的信息：
   *     雷达图上凹进去的那个角，就是下一步该补的地方
   * 所以改成「左仪表（总分）+ 右雷达（结构）」，两条互补的图形。
   * 文字说明保留在雷达下方，因为雷达不能代替「这项怎么算的」。
   * ------------------------------------------------------------------ */
  function scoreCard(S, x) {
    const sc = x.report.score;
    const color = sc.score >= 80 ? 'var(--ok)' : sc.score >= 60 ? 'var(--accent)' : 'var(--warn)';
    const HUE = SH.viz.HUE;
    const dims = [
      ['目标达成', sc.parts.goalRate, '每个已过完的日子，当日时长 / 日目标，再取平均', 45],
      ['计划执行', sc.parts.planRate, `本周应做 ${sc.dueTotal} 项，完成 ${sc.dueDone} 项`, 30],
      ['连续专注', sc.parts.continuity, '中断次数越少越高（每场中断 2 次扣满）', 15],
      ['无欠账', sc.parts.noDebt, `逾期未完成 ${sc.overdue} 项`, 10]
    ];

    const gauge = SH.html(SH.viz.gauge({
      value: sc.score, max: 100, size: 228, thickness: 15,
      label: '专注力评分', sub: '满分 100'
    }));

    // 雷达：把四个维度画成形状。同时叠一条「上周」用于对比，
    // 这样「哪一项在退步」不需要看表格就能看出来
    const prevSc = x.prev && x.prev.score ? x.prev.score.parts : null;
    const radarAxes = dims.map(([label, v, hint]) => ({ label, value: v / 100, hint }));
    const radarSeries = prevSc
      ? [
        { name: '本周', values: dims.map(([, v]) => v / 100), color: HUE.accent },
        { name: '上周', values: [
          prevSc.goalRate / 100, prevSc.planRate / 100, prevSc.continuity / 100, prevSc.noDebt / 100
        ], color: HUE.muted }
      ]
      : null;

    const right = h('div', { style: { flex: '1', minWidth: 0 } });
    right.appendChild(h('div', { class: 'row', style: { alignItems: 'center', gap: '18px' } },
      h('div', { style: { flex: '0 0 auto' } }, SH.html(SH.viz.radar({
        axes: radarAxes, series: radarSeries, size: 196, levels: 4
      }))),
      h('div', { class: 'viz-stack', style: { flex: '1', minWidth: 0, gap: '10px' } },
        h('div', { class: 'row', style: { gap: '14px', fontSize: '11.5px', color: 'var(--muted)' } },
          legendSwatch(HUE.accent, '本周'),
          prevSc ? legendSwatch(HUE.muted, '上周') : null),
        /* 口径说明放在 title 里而不是正文：
           四个维度的算法（「按已过完的日子取平均」这类）是解释性的，
           第一次看需要，之后每次复盘都会被跳过 —— 常驻会挤占可视化空间。 */
        ...dims.map(([label, v, hint, weight]) => h('div', { title: hint },
          h('div', { class: 'row', style: { gap: '6px', marginBottom: '3px' } },
            h('span', { style: { fontSize: '12px', fontWeight: '550' } }, label),
            h('span', { class: 'chip', style: { height: '15px', fontSize: '9.5px', padding: '0 5px' } }, `${weight}%`),
            h('div', { style: { flex: '1' } }),
            h('span', { class: 'mono small', style: { fontWeight: '650' } }, v + '%')),
          SH.progressBar(v / 100, v >= 80 ? 'ok' : v >= 50 ? '' : 'warn'))),
        h('div', { class: 'small muted', style: { marginTop: '2px' } },
          `${dims.reduce((worst, d) => (d[1] < worst[1] ? d : worst), dims[0])[0]} 是最弱的一环 —— 优先补它，总分提升最快。`))));

    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', null, `专注力评分 · ${x.report.from} → ${x.report.to}`),
        h('div', { class: 'grow', style: { flex: '1' } }),
        h('span', { class: 'chip ' + (sc.score >= 80 ? 'ok' : sc.score >= 60 ? '' : 'warn') },
          sc.score >= 85 ? '状态很好' : sc.score >= 70 ? '基本达标' : sc.score >= 55 ? '需要加压' : '明显掉队')),
      h('div', { class: 'card-body row', style: { gap: '26px', alignItems: 'center' } },
        h('div', { style: { flex: '0 0 auto' } }, gauge),
        right));
  }

  /** 把表格里的展示文案解析回数字：
      时长是「1 小时 20 分」、比例是「57%」、计数是「19」——
      要算百分比变化就必须先把文案解回数值。 */
  function num(v) {
    const m = String(v).match(/-?\d+(?:\.\d+)?/g);
    if (!m) return 0;
    if (String(v).includes('小时')) {
      const h = Number(m[0]) || 0;
      const mm = Number(m[1]) || 0;
      return h * 60 + mm;
    }
    return Number(m[0]) || 0;
  }

  function legendSwatch(color, text) {
    return h('span', { class: 'row nowrap', style: { gap: '5px', alignItems: 'center' } },
      h('span', {
        style: { width: '16px', height: '3px', borderRadius: '2px', background: color, display: 'inline-block' }
      }), text);
  }

  /* ---------------- 每日 ---------------- */
  function dailyCard(S, x) {
    const r = x.report;
    const data = r.series.map((d) => ({
      label: F.dayLabel(d.date, false).replace('月', '/').replace('日', ''),
      value: d.minutes,
      title: `${F.dayLabel(d.date, true)}：${F.dur(d.minutes)}（${d.sessions} 段${d.interruptions ? `，中断 ${d.interruptions}` : ''}）`
    }));
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', null, '每日时长'),
        h('div', { class: 'grow', style: { flex: '1' } }),
        h('span', { class: 'small muted' }, `目标 ${F.dur(S.db.profile.dailyGoalMin)}/天`)),
      h('div', { class: 'card-body' },
        SH.html(C.bars({ data, height: 200, goal: S.db.profile.dailyGoalMin, labelEvery: 1 })),
        h('div', { class: 'row', style: { gap: '18px', marginTop: '12px', fontSize: '12.5px', flexWrap: 'wrap' } },
          metric('累计', F.dur(r.minutes)),
          metric('日均', F.dur(r.avgPerDay)),
          metric('有效天数', `${r.activeDays} / 7`),
          metric('场次', String(r.sessions)),
          metric('中断', String(r.interruptions)),
          r.countTo !== r.to ? metric('本期已过', `${r.daysElapsed} 天`) : null)));
  }

  function metric(k, v) {
    return h('div', null, h('div', { class: 'small muted' }, k), h('div', { style: { fontWeight: '650', fontSize: '14px' } }, v));
  }

  /* ---------------- 对比 ---------------- */
  function compareCard(S, x) {
    const a = x.prev, b = x.report;
    const delta = b.minutes - a.minutes;
    const pctv = a.minutes ? Math.round((delta / a.minutes) * 100) : null;
    const rows = [
      ['总时长', F.dur(a.minutes), F.dur(b.minutes), delta],
      ['日均（按已过天数）', F.dur(a.avgPerDay), F.dur(b.avgPerDay), b.avgPerDay - a.avgPerDay],
      ['场次', String(a.sessions), String(b.sessions), b.sessions - a.sessions],
      ['有效天数', String(a.activeDays), String(b.activeDays), b.activeDays - a.activeDays],
      ['中断次数', String(a.interruptions), String(b.interruptions), b.interruptions - a.interruptions],
      ['任务完成率', a.tasks.rate + '%', b.tasks.rate + '%', b.tasks.rate - a.tasks.rate],
      ['专注力评分', String(a.score.score), String(b.score.score), b.score.score - a.score.score]
    ];
    const tb = h('table', { class: 'tb tight' });
    tb.appendChild(h('thead', null, h('tr', null, ...['指标', '上周', '本周', '变化'].map((t) => h('th', null, t)))));
    const body = h('tbody');
    rows.forEach(([k, p, c, d]) => {
      const good = k === '中断次数' ? d < 0 : d > 0;
      body.appendChild(h('tr', null,
        h('td', { class: 'nowrap' }, k), h('td', { class: 'mono small muted nowrap' }, p), h('td', { class: 'mono nowrap', style: { fontWeight: '600' } }, c),
        h('td', null, d === 0
          ? h('span', { class: 'muted' }, '持平')
          : h('span', { class: 'chip ' + (good ? 'ok' : 'warn') }, (d > 0 ? '↑ ' : '↓ ') + (typeof d === 'number' && !Number.isInteger(d) ? d : Math.abs(d))))));
    });
    tb.appendChild(body);

    /* 表格之上加一段双向条形。
       表格负责「精确到每个指标」，条形负责「哪几项真的变了」——
       七行表格里找变化要逐行读，条形扫一眼就知道进步集中在哪里。
       「中断次数」越多越差，所以正负方向要反过来，否则会把退步画成绿色。 */
    const INVERSE = new Set(['中断次数']);
    const vis = rows
      .filter(([k, pv, cv, d]) => Math.abs(d) > 0 && num(pv) > 0)
      .map(([k, pv, cv, d]) => {
        const before = num(pv), after = num(cv);
        const pct = before ? Math.round(((after - before) / before) * 100) : 0;
        const better = INVERSE.has(k) ? pct < 0 : pct > 0;
        return { label: k, value: Math.abs(pct), raw: pct, better };
      })
      .filter((v) => v.value > 0);
    let visBlock = null;
    if (vis.length) {
      const maxMag = Math.max(...vis.map((v) => v.value));
      visBlock = h('div', { style: { padding: '0 16px 14px' } },
        /* 用**百分比**而不是绝对值：这一组指标的单位各不相同（分钟 / 次 / 天 / 分），
           拿绝对值画同一根轴等于把「+329 分钟」和「+1 场次」当成可比 ——
           读者会觉得时长进步巨大、场次没变，而事实是这两个数根本不能相减。 */
        SH.vizHead('变化幅度', '按百分比比较 · 绿＝变好 · 橙＝变差'),
        SH.html(SH.viz.hbars({
          items: vis.map((v) => ({
            label: v.label,
            value: v.value,
            color: v.better ? '#0f9d6e' : '#d97706',
            title: `${v.label}：${v.better ? '改善' : '退步'} ${Math.abs(v.raw)}%`
          })),
          max: maxMag,
          mode: 'pct',
          unitLabel: (v) => String(Math.round(v)),
          showRank: false
        })));
    }

    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', null, '与上周对比'),
        h('div', { class: 'grow', style: { flex: '1' } }),
        pctv != null ? h('span', { class: 'chip ' + (delta >= 0 ? 'ok' : 'warn') }, `${delta >= 0 ? '增加' : '减少'} ${Math.abs(pctv)}%`) : null),
      visBlock,
      h('div', { style: { overflow: 'hidden' } }, tb));
  }

  /* ---------------- 任务 ---------------- */
  function taskCard(S, x) {
    const t = x.report.tasks;
    const body = h('div', { class: 'card-body' });
    // 完成率用半圆仪表：左侧刻度直接表达「离满还有多远」，
    // 而 32px 的数字只能告诉你「是多少」
    body.appendChild(h('div', { class: 'viz-split', style: { alignItems: 'center', marginBottom: '10px' } },
      h('div', { class: 'viz-main' }, SH.html(SH.viz.gauge({
        value: t.rate, max: 100, size: 178, thickness: 13,
        label: '任务完成率'
      }))),
      h('div', { class: 'viz-side viz-stack', style: { gap: '10px' } },
        SH.meterRow({ label: '已完成', value: t.done, max: Math.max(1, t.total), display: `${t.done} 项`, color: 'var(--ok)' }),
        SH.meterRow({
          label: '未完成', value: Math.max(0, t.total - t.done), max: Math.max(1, t.total),
          display: `${Math.max(0, t.total - t.done)} 项`,
          color: t.rate >= 80 ? 'var(--border-strong)' : 'var(--warn)'
        }),
        h('div', { class: 'row', style: { gap: '12px', fontSize: '12px', color: 'var(--text-2)' } },
          h('span', null, `应做 ${t.total} 项`),
          h('span', null, x.report.countTo !== x.report.to ? `（统计到 ${x.report.countTo}）` : null)))));
    body.appendChild(h('div', { class: 'small muted' },
      t.rate >= 90 ? '执行力很强。目标可以定得更大一点了。'
        : t.rate >= 70 ? '基本跟得上计划。把剩下的补齐就好。'
        : t.rate >= 40 ? '计划偏重了。把任务拆得更小，一次只做一件。'
        : t.total ? '任务量明显超过你的实际时间。先砍掉一半再开始。'
        : '这段时间没有排定的任务。'));
    return h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, '计划执行')), body);
  }

  function missedCard(S, x) {
    const missed = x.report.missed;
    if (!missed.length) {
      return h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', null, '未完成的任务')),
        SH.empty('这一周没有漏掉任何任务', '保持住这个节奏。', 'award'));
    }
    const list = h('div', { class: 'list' });
    const byTitle = {};
    missed.forEach((m) => { byTitle[m.title] = (byTitle[m.title] || 0) + 1; });
    Object.entries(byTitle).sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([title, n]) => {
      list.appendChild(h('div', { class: 'list-item' },
        h('span', { class: 'chip warn' }, `${n} 次`),
        h('div', { style: { flex: '1', minWidth: 0 } }, h('div', { class: 'li-title' }, title)),
        h('button', { class: 'btn sm', onClick: () => SH.app.go('plans') }, '去处理')));
    });
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', null, '未完成的任务'),
        h('div', { class: 'grow', style: { flex: '1' } }),
        h('span', { class: 'small muted' }, '按漏掉次数排序')),
      list);
  }

  /* ---------------- 风险 ---------------- */
  function riskCard(S, x) {
    const risky = x.planRep.filter((p) => p.overdue > 0 || p.risk !== 'low');
    if (!risky.length) {
      return h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', null, '计划风险')),
        SH.empty('所有计划都在轨道上', '没有逾期任务。', 'sparkle'));
    }
    const list = h('div', { class: 'list' });
    risky.slice(0, 6).forEach((p) => {
      list.appendChild(h('div', { class: 'list-item' },
        h('span', { class: 'chip ' + (p.risk === 'high' ? 'danger' : 'warn') }, p.risk === 'high' ? '高风险' : '需关注'),
        h('div', { style: { flex: '1', minWidth: 0 } },
          h('div', { class: 'li-title' }, p.title),
          h('div', { class: 'li-sub' },
            `逾期 ${p.overdue} 项 · 完成率 ${p.rate}%`,
            p.daysLeft != null ? (p.daysLeft < 0 ? ` · 已超期 ${-p.daysLeft} 天` : ` · 剩 ${p.daysLeft} 天`) : '',
            p.overdueList && p.overdueList.length ? ` · 最近逾期：${p.overdueList[p.overdueList.length - 1].title}` : '')),
        h('button', { class: 'btn sm', onClick: () => SH.app.go('plans') }, '调整计划')));
    });
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', null, '计划风险')), list);
  }

  function matCard(S, x) {
    const rep = x.matRep;
    const items = [
      ...rep.neverOpened.slice(0, 4).map((m) => ({ m, tag: '从未打开', kind: 'warn' })),
      ...rep.idle.slice(0, 4).map((m) => ({ m, tag: `闲置 ${m.idleFor} 天`, kind: 'danger' }))
    ];
    if (!items.length) {
      return h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', null, '资料体检')),
        SH.empty('资料都在被使用', `共 ${rep.total} 份，累计投入 ${F.dur(rep.totalMin)}。`, 'material'));
    }
    const list = h('div', { class: 'list' });
    items.forEach(({ m, tag, kind }) => {
      list.appendChild(h('div', { class: 'list-item' },
        h('span', { class: 'chip ' + kind }, tag),
        h('div', { style: { flex: '1', minWidth: 0 } }, h('div', { class: 'li-title ellipsis' }, m.title)),
        h('button', { class: 'btn sm', onClick: () => SH.app.go('materials') }, '处理')));
    });
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', null, '资料体检'),
        h('div', { class: 'grow', style: { flex: '1' } }),
        h('span', { class: 'small muted' }, `共 ${rep.total} 份`)),
      list);
  }

  /* ---------------- 热力图 ---------------- */
  function heatCard(S, x) {
    const st = x.ov.streak;
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', null, '打卡热力图（近 26 周）'),
        h('div', { class: 'grow', style: { flex: '1' } }),
        h('span', { class: 'chip ' + (st.current >= 7 ? 'ok' : '') }, `当前连续 ${st.current} 天`),
        h('span', { class: 'small muted' }, `历史最长 ${st.best} 天 · 累计有记录 ${st.activeDays} 天`)),
      h('div', { class: 'card-body' }, SH.html(C.heatHTML({ days: x.heat, weekStart: S.db.profile.weekStart }))));
  }

  /* ---------------- 周报文案 ---------------- */
  function reportActions(S, x) {
    const r = x.report;
    return h('div', { class: 'row', style: { marginTop: '18px', justifyContent: 'flex-end', gap: '10px' } },
      h('button', { class: 'btn', html: SH.icon('download', 14) + '<span style="margin-left:5px">复制周报文字</span>', onClick: () => copyReport(S, x) }),
      h('button', { class: 'btn primary', onClick: () => SH.app.go('plans') }, '去调整计划'));
  }

  function buildReportText(S, x) {
    const r = x.report, sc = r.score;
    const lines = [];
    lines.push(`【学习周报】${r.from} ~ ${r.to}`);
    lines.push('');
    lines.push(`专注力评分：${sc.score}/100`);
    lines.push(`  目标达成 ${sc.parts.goalRate}% · 计划执行 ${sc.parts.planRate}% · 连续专注 ${sc.parts.continuity}% · 无欠账 ${sc.parts.noDebt}%`);
    lines.push('');
    lines.push(`累计专注：${F.dur(r.minutes)}（日均 ${F.dur(r.avgPerDay)}，有效 ${r.activeDays}/7 天，共 ${r.sessions} 段）`);
    lines.push(`与上周相比：${r.minutes >= x.prev.minutes ? '增加' : '减少'} ${F.dur(Math.abs(r.minutes - x.prev.minutes))}`);
    lines.push(`任务完成：${r.tasks.done}/${r.tasks.total}（${r.tasks.rate}%）`);
    lines.push('');
    if (r.subjects.length) {
      lines.push('科目投入：');
      r.subjects.slice(0, 6).forEach((s) => lines.push(`  · ${s.name} ${F.dur(s.minutes)}（${s.pct}%）`));
      lines.push('');
    }
    const risky = x.planRep.filter((p) => p.overdue > 0);
    if (risky.length) {
      lines.push('需要处理：');
      risky.slice(0, 5).forEach((p) => lines.push(`  · 「${p.title}」逾期 ${p.overdue} 项`));
      lines.push('');
    }
    if (r.missed.length) {
      lines.push('漏掉最多的任务：');
      const byTitle = {};
      r.missed.forEach((m) => { byTitle[m.title] = (byTitle[m.title] || 0) + 1; });
      Object.entries(byTitle).sort((a, b) => b[1] - a[1]).slice(0, 5).forEach(([t, n]) => lines.push(`  · ${t}（${n} 次）`));
      lines.push('');
    }
    lines.push(`连续打卡：当前 ${x.ov.streak.current} 天，历史最长 ${x.ov.streak.best} 天`);
    lines.push('');
    lines.push(sc.score >= 80 ? '结论：本周执行得不错，可以适当提高目标。'
      : sc.score >= 60 ? '结论：总体在线，重点补上逾期任务。'
      : '结论：任务量或方法需要调整，先砍量再谈坚持。');
    return lines.join('\n');
  }

  async function copyReport(S, x) {
    const text = buildReportText(S, x);
    try {
      await navigator.clipboard.writeText(text);
      SH.toast({ title: '周报文字已复制到剪贴板', body: '可以直接粘到日记或聊天窗口里。', kind: 'ok', timeout: 4000 });
    } catch (_) {
      SH.modal({
        title: '周报文字（手动复制）',
        body: h('textarea', { class: 'textarea', style: { minHeight: '320px', fontFamily: 'var(--mono)', fontSize: '12.5px' }, readonly: true }, text),
        wide: true
      });
    }
  }
})();
