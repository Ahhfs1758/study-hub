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

  /* ---------------- 评分 ---------------- */
  function scoreCard(S, x) {
    const sc = x.report.score;
    const color = sc.score >= 80 ? 'var(--ok)' : sc.score >= 60 ? 'var(--accent)' : 'var(--warn)';
    const dims = [
      ['目标达成', sc.parts.goalRate, '每个已过完的日子，当日时长 / 日目标，再取平均', 45],
      ['计划执行', sc.parts.planRate, `本周应做 ${sc.dueTotal} 项，完成 ${sc.dueDone} 项`, 30],
      ['连续专注', sc.parts.continuity, '中断次数越少越高（每场中断 2 次扣满）', 15],
      ['无欠账', sc.parts.noDebt, `逾期未完成 ${sc.overdue} 项`, 10]
    ];

    const dial = SH.html(C.ring({ ratio: sc.score / 100, size: 132, thickness: 11, color }));
    const center = h('div', { style: { position: 'absolute', inset: '0', display: 'grid', placeContent: 'center' } },
      h('div', { style: { fontSize: '32px', fontWeight: '700', letterSpacing: '-1.5px', color } }, String(sc.score)),
      h('div', { class: 'small muted' }, '分'));

    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', null, `专注力评分 · ${x.report.from} → ${x.report.to}`),
        h('div', { class: 'grow', style: { flex: '1' } }),
        h('span', { class: 'chip ' + (sc.score >= 80 ? 'ok' : sc.score >= 60 ? '' : 'warn') },
          sc.score >= 85 ? '状态很好' : sc.score >= 70 ? '基本达标' : sc.score >= 55 ? '需要加压' : '明显掉队')),
      h('div', { class: 'card-body row', style: { gap: '28px', alignItems: 'center' } },
        h('div', { style: { position: 'relative', flex: '0 0 132px' } }, dial, center),
        h('div', { style: { flex: '1', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '12px' } },
          ...dims.map(([label, v, hint, weight]) => h('div', null,
            h('div', { class: 'row', style: { gap: '8px', marginBottom: '4px' } },
              h('span', { style: { fontSize: '12.5px', fontWeight: '550' } }, label),
              h('span', { class: 'chip', style: { height: '17px', fontSize: '10px', padding: '0 6px' } }, `权重 ${weight}%`),
              h('div', { style: { flex: '1' } }),
              h('span', { class: 'mono small', style: { fontWeight: '650' } }, v + '%')),
            SH.progressBar(v / 100, v >= 80 ? 'ok' : v >= 50 ? '' : 'warn'),
            h('div', { class: 'small muted', style: { marginTop: '3px' } }, hint))))));
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
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', null, '与上周对比'),
        h('div', { class: 'grow', style: { flex: '1' } }),
        pctv != null ? h('span', { class: 'chip ' + (delta >= 0 ? 'ok' : 'warn') }, `${delta >= 0 ? '增加' : '减少'} ${Math.abs(pctv)}%`) : null),
      h('div', { style: { overflow: 'hidden' } }, tb));
  }

  /* ---------------- 任务 ---------------- */
  function taskCard(S, x) {
    const t = x.report.tasks;
    const body = h('div', { class: 'card-body' });
    body.appendChild(h('div', { class: 'row', style: { gap: '16px', alignItems: 'flex-end', marginBottom: '12px' } },
      h('div', null,
        h('div', { class: 'small muted' }, '任务完成率'),
        h('div', { style: { fontSize: '32px', fontWeight: '700', letterSpacing: '-1.5px' } },
          `${t.rate}`, h('small', { style: { fontSize: '15px', color: 'var(--muted)' } }, '%'))),
      h('div', { style: { flex: '1' } },
        h('div', { class: 'small muted', style: { marginBottom: '5px' } }, `完成 ${t.done} / 应做 ${t.total}`),
        SH.progressBar(t.total ? t.done / t.total : 0, t.rate >= 80 ? 'ok' : t.rate >= 50 ? '' : 'warn'))));
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
