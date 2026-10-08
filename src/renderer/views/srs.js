/* views/srs.js —— 复习：间隔重复（艾宾浩斯）
   间隔重复是这套系统里唯一「必须每天做、断了前面的功夫就白费」的事，
   所以这个页面的信息层级刻意做得最陡：最上方永远是今天要过完的队列。

   注意文件名：views/review.js 是「监督复盘」（另一件事），这里是「复习」。 */
(function () {
  'use strict';
  const SH = window.SH;
  const h = SH.h, api = SH.api, F = SH.fmt;
  const C = SH.charts;

  const STAGE_LABEL = ['新加入', '第 1 轮', '第 2 轮', '第 3 轮', '第 4 轮', '第 5 轮', '第 6 轮', '已掌握'];
  const RESULT = {
    good: { label: '记住了', key: '1', hint: '下次间隔翻倍' },
    fuzzy: { label: '有点模糊', key: '2', hint: '保持同档，过同样长的时间再来' },
    forgot: { label: '忘了', key: '3', hint: '回到第一档重来' }
  };
  let mode = 'queue';      // queue | all | curve
  let filterSubject = '';

  const view = {
    title: '复习',
    sub: () => '按遗忘曲线安排复习：在快要忘记的那一刻再过一遍，性价比最高',

    /** 从别的页面进来时回到主视图。
     *  mode 是模块级变量会一直留着，不重置的话用户上次看过「遗忘曲线」，
     *  以后每次进来都落在那个次要标签上 —— 而这一页该先给他看的是「今天要过什么」。 */
    onEnter() {
      mode = 'queue';
    },

    async load() {
      const [queue, stats, curve] = await Promise.all([
        api.reviews.queue(F.dayKey()),
        api.reviews.stats(14),
        api.reviews.curve(7)
      ]);
      return { queue, stats, curve };
    },

    render(root, S, x) {
      root.appendChild(topBar(S, x));
      if (mode === 'curve') { renderCurve(root, S, x); return; }
      if (mode === 'all') { renderAll(root, S, x); return; }

      root.appendChild(statsRow(S, x.stats));
      root.appendChild(h('h2', { class: 'section' }, `今天要过的（${x.queue.total}）`));
      root.appendChild(queueCard(S, x.queue));
      if (x.queue.upcoming.length) {
        root.appendChild(h('h2', { class: 'section' }, '接下来会到期'));
        root.appendChild(upcomingCard(S, x.queue));
      }
      root.appendChild(h('h2', { class: 'section' }, '未来两周复习负载'));
      root.appendChild(loadCard(S, x.stats));
    },

    /** 键盘 1 / 2 / 3 评分当前卡片 */
    onKey(e) {
      if (mode !== 'queue') return false;
      const key = Object.keys(RESULT).find((k) => RESULT[k].key === e.key);
      if (!key) return false;
      const card = document.querySelector('[data-current-review]');
      if (!card) return false;
      grade(SH.state, card.dataset.currentReview, key);
      return true;
    }
  };

  function topBar(S, x) {
    const tabs = h('div', { class: 'pill-tabs' });
    [['queue', '今日队列'], ['all', '全部知识点'], ['curve', '遗忘曲线']].forEach(([m, label]) => {
      const b = h('button', { class: mode === m ? 'active' : '' }, label);
      b.addEventListener('click', () => { mode = m; SH.app.reload(); });
      tabs.appendChild(b);
    });
    return h('div', { class: 'row', style: { marginBottom: '14px', gap: '10px', flexWrap: 'wrap' } },
      tabs,
      h('div', { style: { flex: '1' } }),
      x.stats.overdue ? h('span', { class: 'chip danger' }, `${x.stats.overdue} 个已逾期`) : null,
      h('button', { class: 'btn primary', html: SH.icon('plus', 14) + '<span style="margin-left:4px">添加知识点</span>', onClick: () => addReview(S) }));
  }

  /* ---------------- 统计 ---------------- */
  function statsRow(S, st) {
    const HUE = SH.viz.HUE;
    const due = st.dueToday + st.overdue;
    const totalAll = Math.max(1, st.active + st.mastered);
    // 保持率用环：百分比本身没有「离好还差多远」的位置感，环有
    const retRatio = st.retention == null ? 0 : st.retention / 100;
    return h('div', { class: 'grid g4' },
      SH.statCard({
        label: '今日待复习', value: due, unit: '个', icon: 'review',
        accent: due > 0,
        desc: st.overdue ? `其中 ${st.overdue} 个已逾期` : (st.dueToday ? '都在今天到期' : '今天没有到期的'),
        visual: due > 0
          ? {
            kind: 'segbar', width: 54,
            segments: [
              { value: st.overdue, color: HUE.danger, label: '逾期' },
              { value: st.dueToday, color: HUE.accent, label: '今天' }
            ]
          }
          : null
      }),
      SH.statCard({
        label: '记忆保持率', value: st.retention == null ? '—' : st.retention, unit: st.retention == null ? '' : '%',
        icon: 'sparkle',
        desc: st.attempts ? `${st.attempts} 次中 ${st.good} 次一次想起` : '还没有复习记录',
        visual: st.retention == null ? null : { kind: 'ring', ratio: retRatio, size: 44, thickness: 5.5, color: retRatio >= 0.85 ? HUE.ok : retRatio >= 0.7 ? HUE.accent : HUE.warn }
      }),
      SH.statCard({
        label: '在队列中', value: st.active, unit: '个', icon: 'list',
        desc: `平均第 ${st.avgStage} 轮 · 已掌握 ${st.mastered}`,
        // 掌握进度用环：分母是「全部知识点」，比只报「在队列中」更有全局感
        visual: { kind: 'progressRing', ratio: st.mastered / totalAll, size: 46, thickness: 5, value: String(st.mastered) }
      }),
      SH.statCard({
        label: '近 7 天复习', value: st.reviewedLast7, unit: '次', icon: 'award',
        desc: st.lapses ? `累计遗忘 ${st.lapses} 次` : '没有被遗忘打断过',
        tone: st.lapses > 0 ? 'warn' : undefined
      }));
  }

  /* ---------------- 今日队列 ---------------- */
  function queueCard(S, q) {
    const all = [...q.overdue, ...q.due];
    const card = h('div', { class: 'card' });
    if (!all.length) {
      card.appendChild(SH.empty(
        '今天的复习都过完了',
        q.upcoming.length
          ? `下一个到期在 ${F.dayLabel(q.upcoming[0].nextAt, true)}：${q.upcoming[0].title}`
          : '队列是空的，去加些知识点吧。',
        'award'));
      return card;
    }

    card.appendChild(h('div', { class: 'card-head' },
      h('h3', null, '逐个过一遍'),
      h('div', { class: 'grow', style: { flex: '1' } }),
      h('span', { class: 'small muted' }, '先自己想，再对照备注 —— 别直接看答案')));

    const body = h('div', { class: 'card-body', style: { display: 'flex', flexDirection: 'column', gap: '10px' } });
    all.forEach((r, idx) => body.appendChild(reviewCard(S, r, idx === 0)));
    card.appendChild(body);
    return card;
  }

  function reviewCard(S, r, isCurrent) {
    const sub = (S.db.subjects || []).find((z) => z.id === r.subjectId);
    const mat = (S.db.materials || []).find((z) => z.id === r.materialId);
    const overdueDays = r.nextAt && r.nextAt < F.dayKey()
      ? Math.round((F.parseKey(F.dayKey()) - F.parseKey(r.nextAt)) / 86400000) : 0;

    const box = h('div', {
      class: 'rev-card' + (isCurrent ? ' rev-current' : '') + (overdueDays ? ' rev-late' : '')
    }, h('div', { style: { display: 'flex', flexDirection: 'column', gap: '9px' } }));
    if (isCurrent) box.dataset.currentReview = r.id;

    box.firstChild.appendChild(h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
      h('span', { class: 'chip ' + (overdueDays ? 'danger' : 'accent') }, overdueDays ? `逾期 ${overdueDays} 天` : '今天到期'),
      h('span', { class: 'chip' }, STAGE_LABEL[Math.min(r.stage, STAGE_LABEL.length - 1)]),
      r.lapses ? h('span', { class: 'chip warn' }, `遗忘 ${r.lapses} 次`) : null,
      h('span', { style: { flex: '1' } }),
      sub ? h('span', { class: 'row nowrap', style: { gap: '5px', fontSize: '12px' } },
        h('span', { class: 'subj-dot', style: { background: sub.color } }), sub.name) : null));

    box.firstChild.appendChild(h('div', { class: 'rev-title' }, r.title));
    if (mat) {
      box.firstChild.appendChild(h('div', { class: 'rev-meta row', style: { gap: '8px' } },
        h('span', { html: SH.icon(SH.materialIcon(mat.type), 13) }),
        h('span', { class: 'ellipsis', style: { flex: '1' }, title: mat.title }, mat.title),
        h('button', {
          class: 'btn sm ghost', html: SH.icon('eye', 13), title: '看这份资料',
          onClick: (e) => { e.stopPropagation(); SH.app.previewById(mat.id); }
        }, '看资料')));
    }
    if (r.note) {
      box.firstChild.appendChild(h('details', { class: 'rev-reveal' },
        h('summary', null, '回忆完了？展开对照备注'),
        h('div', { class: 'rev-note' }, r.note)));
    }

    box.firstChild.appendChild(h('div', { class: 'rev-actions' },
      ...Object.entries(RESULT).map(([key, cfg]) => h('button', {
        class: 'btn ' + (key === 'good' ? 'primary' : ''),
        title: cfg.hint,
        onClick: () => grade(S, r.id, key)
      }, cfg.label, h('span', { class: 'rev-kbd' }, cfg.key))),
      h('span', { style: { flex: '1' } }),
      h('button', {
        class: 'btn sm ghost', title: '今天先跳过（推到明天，不算一次失败）',
        onClick: () => skip(S, r.id)
      }, '跳过')));

    return box;
  }

  async function grade(S, id, result) {
    const row = await api.reviews.grade(id, result);
    if (!row) return;
    if (row.mastered) {
      SH.toast({ title: `「${row.title}」已掌握`, body: '走完 7 轮间隔重复，基本进入长期记忆了。', kind: 'ok', timeout: 6000 });
    } else {
      const note = result === 'good' ? `下次 ${F.dayLabel(row.nextAt, true)}`
        : result === 'fuzzy' ? `同档重来，${F.dayLabel(row.nextAt, true)}`
        : `回炉重来，${F.dayLabel(row.nextAt, true)}`;
      SH.toast({ title: RESULT[result].label, body: note, kind: result === 'forgot' ? 'warn' : 'info', timeout: 2600 });
    }
    await SH.app.refresh();
  }

  /** 「跳过」= 推到明天，不计入回忆记录 —— 很多人只是当下没空，不该被算成遗忘 */
  async function skip(S, id) {
    const t = F.dayKey(new Date(Date.now() + 86400000));
    await api.reviews.update(id, { nextAt: t });
    SH.toast({ title: '已推到明天', kind: 'info', timeout: 2200 });
    SH.app.refresh();
  }

  /* ---------------- 接下来到期 ---------------- */
  function upcomingCard(S, q) {
    const list = h('div', { class: 'list' });
    q.upcoming.slice(0, 12).forEach((r) => {
      const sub = (S.db.subjects || []).find((z) => z.id === r.subjectId);
      list.appendChild(h('div', { class: 'list-item' },
        h('span', { class: 'chip nowrap' }, F.dayLabel(r.nextAt, true)),
        h('div', { style: { flex: '1', minWidth: 0 } },
          h('div', { class: 'li-title ellipsis' }, r.title),
          h('div', { class: 'li-sub row', style: { gap: '8px', flexWrap: 'wrap' } },
            h('span', null, STAGE_LABEL[Math.min(r.stage, STAGE_LABEL.length - 1)]),
            h('span', null, `已复习 ${r.attempts} 次`),
            sub ? h('span', { class: 'row nowrap', style: { gap: '5px' } },
              h('span', { class: 'subj-dot', style: { width: '7px', height: '7px', flex: '0 0 7px', background: sub.color } }), sub.name) : null)),
        h('button', { class: 'btn sm', onClick: () => grade(S, r.id, 'good') }, '提前过一遍')));
    });
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', null, '未到期队列'),
        h('div', { class: 'grow', style: { flex: '1' } }),
        h('span', { class: 'small muted' }, `共 ${q.upcoming.length} 个`)),
      list);
  }

  /* ---------------- 负载 ---------------- */
  function loadCard(S, st) {
    const data = st.load.map((d) => ({
      label: F.dayLabel(d.date, false).replace('月', '/').replace('日', ''),
      value: d.count,
      title: `${F.dayLabel(d.date, true)}：${d.count} 个待复习${d.overdue ? `（含逾期 ${d.overdue}）` : ''}`,
      color: d.overdue ? '#dc2626' : undefined
    }));
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', null, '未来 14 天复习数量'),
        h('div', { class: 'grow', style: { flex: '1' } }),
        st.busiest.count >= 12 ? h('span', { class: 'chip warn' }, `高峰 ${st.busiest.count} 个，建议提前分散`) : null),
      h('div', { class: 'card-body' },
        // 这张图的值是**个数**：既要显式给数字加单位（默认是「分钟:秒」格式），
        // 又要保证纵轴刻度是整数（否则会出现 3.3333333333333335 这种刻度）
        SH.html(C.bars({
          data, height: 150, labelEvery: 1,
          unitLabel: (v) => `${v} 个`,
          axisLabel: (v) => String(v),      // 轴上是「个数」，纯数字最清楚（加「个」太窄会换行）
          goalLabel: '峰值',
          integerAxis: true
        })),
        h('div', { class: 'small muted', style: { marginTop: '8px' } },
          '间隔重复最容易翻车的地方是「某天堆了几十个」。看到柱子在长高，就提前把当天的内容过掉几个。')));
  }

  /* ---------------- 全部知识点 ---------------- */
  function renderAll(root, S, x) {
    const repo = (S.db.reviews || []).filter((r) => !filterSubject || r.subjectId === filterSubject);
    const subjects = S.db.subjects || [];

    const sel = h('select', { class: 'select', style: { width: '170px' } },
      h('option', { value: '' }, '全部科目'),
      ...subjects.map((s) => h('option', { value: s.id }, s.name)));
    sel.value = filterSubject;
    sel.addEventListener('change', () => { filterSubject = sel.value; SH.app.reload(); });

    const today = F.dayKey();
    const groups = [
      { id: 'due', title: '待复习', rows: repo.filter((r) => !r.mastered && !r.archived && r.nextAt && r.nextAt <= today) },
      { id: 'scheduled', title: '已排期', rows: repo.filter((r) => !r.mastered && !r.archived && r.nextAt && r.nextAt > today) },
      { id: 'mastered', title: '已掌握', rows: repo.filter((r) => r.mastered && !r.archived) },
      { id: 'archived', title: '已归档', rows: repo.filter((r) => r.archived) }
    ].filter((g) => g.rows.length);

    root.appendChild(h('div', { class: 'row', style: { marginBottom: '12px', gap: '10px' } },
      sel, h('div', { style: { flex: '1' } }),
      h('span', { class: 'small muted' }, `共 ${repo.length} 个知识点`)));

    if (!groups.length) {
      root.appendChild(h('div', { class: 'card' }, SH.empty('还没有知识点',
        '勾掉带资料的计划任务会自动加进来；也可以点右上角手动添加。', 'review')));
      return;
    }

    groups.forEach((g) => {
      root.appendChild(h('h2', { class: 'section' }, `${g.title}（${g.rows.length}）`));
      const list = h('div', { class: 'list' });
      g.rows.forEach((r) => {
        const sub = subjects.find((z) => z.id === r.subjectId);
        const attempts = (r.history || []).length;
        const okRate = attempts ? Math.round(((r.history || []).filter((hh) => hh.result === 'good').length / attempts) * 100) : null;
        list.appendChild(h('div', { class: 'list-item' },
          h('span', { class: 'subj-dot', style: { background: sub ? sub.color : '#94a3b8' } }),
          h('div', { style: { flex: '1', minWidth: 0 } },
            h('div', { class: 'li-title' + (r.mastered ? ' muted' : ''), style: { display: 'flex', alignItems: 'center', gap: '6px' } },
              h('span', { class: 'ellipsis' }, r.title),
              r.auto ? h('span', { class: 'chip', style: { flex: '0 0 auto' } }, '自动') : null),
            h('div', { class: 'li-sub row', style: { gap: '8px', flexWrap: 'wrap' } },
              h('span', { class: 'nowrap' }, STAGE_LABEL[Math.min(r.stage, STAGE_LABEL.length - 1)]),
              h('span', { class: 'nowrap' }, r.mastered ? '已走完全部间隔' : (r.nextAt ? `下次 ${r.nextAt}` : '—')),
              h('span', { class: 'nowrap' }, `复习 ${attempts} 次${okRate == null ? '' : ` · 一次想起 ${okRate}%`}`),
              r.lapses ? h('span', { class: 'chip warn' }, `遗忘 ${r.lapses}`) : null)),
          r.mastered ? null : h('button', { class: 'btn sm', onClick: () => grade(S, r.id, 'good') }, '过一遍'),
          h('button', { class: 'btn sm ghost', html: SH.icon('edit', 13), title: '编辑', onClick: () => editReview(S, r) }),
          h('button', {
            class: 'btn sm ghost', html: SH.icon('refresh', 13), title: '重置到第一档',
            onClick: async () => {
              const ok = await SH.confirm({ title: '重置这个知识点？', message: '进度回到第一档，明天重新开始复习。', okText: '重置' });
              if (ok) { await api.reviews.reset(r.id); SH.app.refresh(); }
            }
          }),
          h('button', {
            class: 'btn sm ghost', html: SH.icon('trash', 13), title: '删除', onClick: async () => {
              const ok = await SH.confirm({ title: '删除这个知识点？', message: `「${r.title}」的复习记录会一并删除。`, okText: '删除', danger: true });
              if (ok) { await api.reviews.remove(r.id); SH.app.refresh(); }
            }
          })));
      });
      root.appendChild(h('div', { class: 'card' }, list));
    });
  }

  /* ---------------- 遗忘曲线 ---------------- */
  function renderCurve(root, S, x) {
    const st = x.stats;
    root.appendChild(h('div', { class: 'grid g-2-1' },
      h('div', { class: 'card' },
        h('div', { class: 'card-head' },
          h('h3', null, '为什么必须复习（遗忘曲线）'),
          h('div', { class: 'grow', style: { flex: '1' } }),
          h('span', { class: 'chip ok' }, '按计划复习'),
          h('span', { class: 'chip danger' }, '只学一次')),
        h('div', { class: 'card-body' },
          SH.html(curveSvg(x.curve, 720, 210)),
          h('div', { class: 'small muted', style: { marginTop: '10px' } },
            '红色是不复习的自然遗忘：一天之后只剩一半左右。绿色是每隔 1/2/4/7/15/30/60 天复习一次的效果 —— ' +
            '每次复习都相当于把曲线「拉回」顶上，走完 7 轮记忆才真正稳下来。'))),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', null, '掌握度分布')),
        h('div', { class: 'card-body' }, stageBars(st)))));

    root.appendChild(h('h2', { class: 'section' }, '实测数据'));
    root.appendChild(h('div', { class: 'grid g3' },
      metricCard('记忆保持率', st.retention == null ? '—' : st.retention + '%',
        st.attempts
          ? `${st.attempts} 次回忆中 ${st.good} 次「一次想起」、${st.fuzzy} 次模糊、${st.forgot} 次完全忘记。`
          : '还没有复习记录，过几轮后这个数字才有意义。'),
      metricCard('平均复习轮次', `${st.avgStage}`,
        `在队列中的 ${st.active} 个知识点平均走到第 ${st.avgStage} 轮。走完 7 轮即视为掌握。`),
      metricCard('遗忘次数', `${st.lapses}`,
        st.attempts
          ? `占总回忆次数的 ${Math.round((st.lapses / Math.max(1, st.attempts)) * 100)}%。遗忘多说明间隔拉得太长，或第一次学得不够扎实。`
          : '—')));

    root.appendChild(h('h2', { class: 'section' }, '间隔表'));
    root.appendChild(intervalTable(st));
  }

  function curveSvg(curve, W, H) {
    const pl = 40, pr = 16, pt = 16, pb = 26;
    const iw = W - pl - pr, ih = H - pt - pb;
    const X = (t) => pl + (t / 30) * iw;
    const Y = (r) => pt + (1 - r) * ih;
    const path = (arr) => arr.map((p, i) => `${i ? 'L' : 'M'} ${X(p.t).toFixed(1)} ${Y(p.r).toFixed(1)}`).join(' ');

    const parts = [];
    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
      const y = Y(r);
      parts.push(`<line x1="${pl}" y1="${y.toFixed(1)}" x2="${W - pr}" y2="${y.toFixed(1)}" stroke="#eef1f6"/>`);
      parts.push(`<text x="${pl - 7}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="10.5" fill="#8b96ab" font-family="inherit">${Math.round(r * 100)}%</text>`);
    }
    let acc = 0;
    for (const iv of [1, 2, 4, 7, 15, 30]) {
      acc += iv;
      if (acc > 30) break;
      parts.push(`<line x1="${X(acc).toFixed(1)}" y1="${pt}" x2="${X(acc).toFixed(1)}" y2="${(pt + ih).toFixed(1)}" stroke="#c9d4fb" stroke-dasharray="3 3"/>`);
      parts.push(`<text x="${X(acc).toFixed(1)}" y="${pt - 4}" text-anchor="middle" font-size="9.5" fill="#98acf8" font-family="inherit">复习</text>`);
    }
    parts.push(`<path d="${path(curve.noReview)}" fill="none" stroke="#dc2626" stroke-width="2"/>`);
    parts.push(`<path d="${path(curve.withReview)}" fill="none" stroke="#0f9d6e" stroke-width="2.2"/>`);
    [0, 5, 10, 15, 20, 25, 30].forEach((t) => {
      parts.push(`<text x="${X(t).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#8b96ab" font-family="inherit">${t} 天</text>`);
    });
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block">${parts.join('')}</svg>`;
  }

  /**
   * 阶段分布：列表 → **阶梯图**
   *
   * 间隔重复最该被看见的一件事是「卡片都堆在哪一轮」——
   * 如果全堆在第 1 轮，说明复习只是走了一遍流程、还没真正进入长期记忆。
   * 一列「第 1 轮 12 / 第 2 轮 5 / …」的文字要逐行读才拼出形状，
   * 而阶梯图的坡本身就在表达这件事。
   */
  function stageBars(st) {
    const stages = st.intervals.map((iv, i) => ({
      label: `${i + 1}轮`,
      count: st.byStage[i] || 0,
      hint: `第 ${i + 1} 轮 · 间隔 ${iv} 天`
    }));
    const mastered = st.byStage[st.intervals.length] || 0;
    if (mastered) stages.push({ label: '已掌握', count: mastered, hint: '已走完所有间隔' });

    const total = Math.max(1, st.active + st.mastered);
    const rows = st.intervals.map((iv, i) => ({
      label: `第 ${i + 1} 轮`,
      value: st.byStage[i] || 0,
      color: SH.viz.seriesColor(i),
      sub: `间隔 ${iv} 天`
    }));
    if (mastered) rows.push({ label: '已掌握', value: mastered, color: SH.viz.HUE.ok, sub: '走完所有间隔' });

    return h('div', { class: 'viz-stack' },
      SH.html(SH.viz.stages({
        stages,
        masteredFrom: st.intervals.length,
        color: SH.viz.HUE.accent
      })),
      h('div', { style: { marginTop: '4px' } },
        SH.vizHead('各轮次人数', `共 ${total} 个知识点`),
        SH.html(SH.viz.hbars({
          items: rows,
          max: Math.max(...rows.map((r) => r.value), 1),
          unitLabel: (v) => `${v} 个`
        }))));
  }

  function metricCard(k, v, d) {
    return h('div', { class: 'card pad' },
      h('div', { class: 'small muted' }, k),
      h('div', { style: { fontSize: '26px', fontWeight: '680', letterSpacing: '-.8px', marginTop: '4px' } }, v),
      h('div', { class: 'small muted', style: { marginTop: '6px', lineHeight: '1.6' } }, d));
  }

  function intervalTable(st) {
    let acc = 0;
    const tb = h('table', { class: 'tb tight' });
    tb.appendChild(h('thead', null, h('tr', null,
      ...['轮次', '间隔（天）', '距首次学习（天）', '当前数量', '说明'].map((t) => h('th', null, t)))));
    const body = h('tbody');
    st.intervals.forEach((iv, i) => {
      acc += iv;
      body.appendChild(h('tr', null,
        h('td', { class: 'nowrap' }, `第 ${i + 1} 轮`),
        h('td', { class: 'mono' }, String(iv)),
        h('td', { class: 'mono' }, String(acc)),
        h('td', { class: 'mono' }, String(st.byStage[i] || 0)),
        h('td', { class: 'small muted' }, iv === 1 ? '学完第二天先过一个' : iv >= 30 ? '进入长期记忆维护' : '间隔按约两倍递增')));
    });
    tb.appendChild(body);
    return h('div', { class: 'card', style: { overflow: 'hidden' } }, tb);
  }

  /* ---------------- 表单 ---------------- */
  async function addReview(S) {
    const v = await SH.formDialog({
      title: '添加需要记住的知识点',
      fields: [
        { name: 'title', label: '知识点', placeholder: '例：泰勒展开的余项形式' },
        { name: 'subjectId', label: '科目', type: 'select', value: '', options: [{ value: '', label: '不指定' }, ...(S.db.subjects || []).map((x) => ({ value: x.id, label: x.name }))] },
        { name: 'materialId', label: '关联资料', type: 'select', value: '', options: [{ value: '', label: '不关联' }, ...(S.db.materials || []).map((x) => ({ value: x.id, label: x.title }))] },
        { name: 'learnedAt', label: '首次学习日期', type: 'date', value: F.dayKey() },
        { name: 'note', label: '备注（复习时可展开对照）', type: 'textarea', placeholder: '写下最容易记混的那一点' }
      ],
      okText: '加入队列'
    });
    if (!v || !v.title) return;
    const row = await api.reviews.add(v);
    SH.toast({
      title: '已加入复习队列',
      body: `第一次复习安排在 ${F.dayLabel(row.nextAt, true)}。`,
      kind: 'ok', timeout: 5000
    });
    SH.app.refresh();
  }

  async function editReview(S, r) {
    const v = await SH.formDialog({
      title: '编辑知识点',
      fields: [
        { name: 'title', label: '知识点', value: r.title },
        { name: 'subjectId', label: '科目', type: 'select', value: r.subjectId, options: [{ value: '', label: '不指定' }, ...(S.db.subjects || []).map((x) => ({ value: x.id, label: x.name }))] },
        { name: 'materialId', label: '关联资料', type: 'select', value: r.materialId, options: [{ value: '', label: '不关联' }, ...(S.db.materials || []).map((x) => ({ value: x.id, label: x.title }))] },
        { name: 'note', label: '备注', type: 'textarea', value: r.note || '' },
        { name: 'nextAt', label: '下次复习日期', type: 'date', value: r.nextAt || F.dayKey() },
        { name: 'archived', label: '归档（不再出现在队列里）', type: 'checkbox', value: !!r.archived }
      ],
      okText: '保存'
    });
    if (!v) return;
    await api.reviews.update(r.id, v);
    SH.app.refresh();
  }

  SH.views.srs = view;
})();
