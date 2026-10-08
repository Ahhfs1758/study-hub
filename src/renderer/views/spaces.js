/* spaces.js —— 学科空间（多租户）
 *
 * 一个「学科空间」= 一套完全独立的学习库：自己的科目、资料、计划、
 * 学习记录、提醒、复习队列，连目标与番茄钟都是自己的。
 *
 * 这一页回答三个问题：
 *   1. 我现在在哪个空间？它什么情况？（当前空间 + 指标）
 *   2. 我有哪些空间？各自进展如何？（空间卡片 + 跨空间对比）
 *   3. 想开一个新领域，该学哪几门课、按什么顺序？（15 个跨学科模板）
 *
 * 第 3 点是这个页面真正的价值所在：跨学科最难的从来不是勤奋，而是
 * 「不知道该学哪几门、按什么顺序、算不算学会」。模板把这层领域共识固化下来。
 */
(function () {
  'use strict';
  const SH = window.SH;
  const api = SH.api;
  const h = SH.h, F = SH.fmt;

  const LEVEL_LABEL = { undergrad: '本科', grad: '研究生', any: '通用' };
  const LEVEL_HUE = { undergrad: '#2563eb', grad: '#7c3aed', any: '#64748b' };
  const PALETTE = ['#2563eb', '#0d9488', '#7c3aed', '#d97706', '#db2777', '#0891b2', '#65a30d', '#4f46e5'];

  /** 模板筛选：阶段 + 关键词。模块级保存，切走再回来不丢。 */
  const q = { level: '', text: '', _focus: false };

  async function load() {
    const [templates, compare] = await Promise.all([api.tenants.templates(), api.tenants.compare()]);
    return { templates, compare };
  }

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */
  function render(root, S, x) {
    root.appendChild(currentCard(S));
    root.appendChild(header('我的学科空间', `${(S.tenants || []).length} 个`, newSpaceButton(S)));
    root.appendChild(spaceGrid(S));
    root.appendChild(header('跨空间对比', '把每个空间放到同一把尺子上'));
    root.appendChild(compareCard(S, x.compare));
    root.appendChild(header('跨学科模板库', '15 个领域 × 本科 / 研究生，一键建出课程与计划'));
    root.appendChild(templateSection(x.templates));
  }

  function newSpaceButton(S) {
    return h('button', {
      class: 'btn sm primary',
      html: SH.icon('plus', 13) + '<span style="margin-left:4px">新建空空间</span>',
      onClick: () => newSpaceDialog(S)
    });
  }

  function header(title, note, right) {
    return h('div', { class: 'row', style: { margin: '22px 0 10px', gap: '10px', alignItems: 'baseline' } },
      h('h2', { class: 'section', style: { margin: '0' } }, title),
      note ? h('span', { class: 'small muted' }, note) : null,
      h('div', { style: { flex: '1' } }),
      right || null);
  }

  /* ---------------- 当前空间 ---------------- */

  function currentCard(S) {
    const t = S.activeTenant || (S.tenants || [])[0];
    if (!t) return h('div');
    const st = (S.tenantStats || {})[t.id] || {};
    const taskRate = st.tasks ? st.doneTasks / st.tasks : 0;
    const color = t.color || '#2563eb';
    /* 🔴 条形的 max 必须有参照物，否则它就是个装饰。
       早先写成 Math.max(600, st.minutes) —— 数据一超过 600 分钟，
       max 就等于 value，条形永远满格，「这条是什么意思」就没有答案了。
       改成「所有空间里的最大值」：这样每条的长度表达的是
       「在各空间之间的相对位置」，那才是人真正想比的东西。 */
    const all = Object.values(S.tenantStats || {});
    const maxOf = (k) => Math.max(1, ...all.map((x) => (x && x[k]) || 0));

    return h('div', { class: 'card', style: { position: 'relative', overflow: 'hidden' } },
      h('div', { class: 'sc-stripe', style: { background: color, width: '4px' } }),
      h('div', { class: 'card-head' },
        h('h3', null, `当前空间 · ${t.name}`),
        h('div', { style: { flex: '1' } }),
        h('span', { class: 'chip', style: { background: color + '1f', color } }, `${LEVEL_LABEL[t.level] || '通用'} · ${t.field || '综合'}`),
        t.templateId ? h('span', { class: 'chip' }, '来自模板') : null),
      h('div', { class: 'card-body' },
        h('div', { class: 'viz-split', style: { alignItems: 'center' } },
          h('div', { class: 'viz-main' },
            SH.html(SH.viz.progressRing({
              ratio: taskRate,
              size: 124, thickness: 11,
              value: String(st.doneTasks || 0),
              unit: `/${st.tasks || 0}`,
              sub: '计划任务完成',
              color: taskRate >= 0.8 ? SH.viz.HUE.ok : color
            }))),
          h('div', { class: 'viz-side viz-stack', style: { gap: '9px' } },
            SH.meterRow({ label: '科目', value: st.subjects || 0, max: maxOf('subjects'), display: `${st.subjects || 0} 门`, color }),
            SH.meterRow({ label: '资料', value: st.materials || 0, max: maxOf('materials'), display: `${st.materials || 0} 份`, color: SH.viz.HUE.info }),
            SH.meterRow({ label: '待复习', value: st.reviews || 0, max: maxOf('reviews'), display: `${st.reviews || 0} 条`, color: SH.viz.HUE.warn }),
            SH.meterRow({ label: '累计投入', value: st.minutes || 0, max: maxOf('minutes'), display: F.dur(st.minutes || 0), color: '#7c3aed' })),
          h('div', { style: { flex: '0 0 210px', display: 'flex', flexDirection: 'column', gap: '8px' } },
            h('div', { class: 'small muted', style: { lineHeight: '1.6' } }, t.blurb || '这个空间还没有说明。'),
            (t.parents || []).length
              ? h('div', { class: 'sc-parents' }, ...(t.parents || []).map((p) => h('span', {
                class: 'chip', style: { height: '19px', padding: '0 7px', fontSize: '10.5px' }
              }, p)))
              : null,
            h('div', { class: 'row', style: { gap: '6px', marginTop: '2px' } },
              h('button', {
                class: 'btn sm', title: '改名、改阶段、改说明',
                html: SH.icon('edit', 13) + '<span style="margin-left:4px">编辑</span>',
                onClick: () => editSpace(S, t)
              }),
              h('button', {
                class: 'btn sm ghost', title: '从模板新建一个空间',
                html: SH.icon('plus', 13) + '<span style="margin-left:4px">新建</span>',
                onClick: () => newSpaceDialog(S)
              }))))));
  }

  /* ---------------- 空间卡片 ---------------- */

  function spaceGrid(S) {
    const list = S.tenants || [];
    return h('div', { class: 'grid g3' }, ...list.map((t) => spaceCard(S, t)));
  }

  function spaceCard(S, t) {
    const st = (S.tenantStats || {})[t.id] || {};
    const on = t.id === S.activeTenantId;
    const color = t.color || '#2563eb';
    return h('div', { class: 'card space-card' + (on ? ' active' : '') },
      h('div', { class: 'sc-stripe', style: { background: color } }),
      h('div', { class: 'card-body', style: { display: 'flex', flexDirection: 'column', gap: '11px' } },
        h('div', { class: 'sc-head' },
          h('span', { class: 'subj-dot', style: { background: color, width: '12px', height: '12px', flex: '0 0 12px', marginTop: '4px' } }),
          h('div', { style: { flex: '1', minWidth: 0 } },
            h('div', { class: 'sc-name' }, t.name),
            h('div', { class: 'sc-field' }, `${LEVEL_LABEL[t.level] || '通用'}${t.field ? ' · ' + t.field : ''}`)),
          on ? h('span', { class: 'chip ok', style: { height: '19px', padding: '0 7px', fontSize: '10.5px' } }, '当前') : null),

        (t.parents || []).length
          ? h('div', { class: 'sc-parents' }, ...(t.parents || []).map((p) => h('span', {
            class: 'chip', style: { height: '19px', padding: '0 7px', fontSize: '10.5px' }
          }, p)))
          : null,

        h('div', { class: 'space-kpis' },
          h('div', { class: 'space-kpi' }, h('b', null, String(st.subjects || 0)), h('span', null, '门课')),
          h('div', { class: 'space-kpi' }, h('b', null, String(st.plans || 0)), h('span', null, '个计划')),
          h('div', { class: 'space-kpi' }, h('b', null, F.hm(st.minutes || 0)), h('span', null, '累计时:分'))),

        h('div', { class: 'row', style: { gap: '6px' } },
          on
            ? h('button', { class: 'btn sm ghost', disabled: true }, '正在使用')
            : h('button', {
              class: 'btn sm primary',
              onClick: async () => {
                const r = await SH.app.switchSpace(t.id);
                if (r && r.ok) SH.toast({ title: `已切到「${t.name}」`, kind: 'ok', timeout: 3000 });
              }
            }, '切换过来'),
          h('div', { style: { flex: '1' } }),
          h('button', { class: 'btn sm ghost icon', title: '编辑', html: SH.icon('edit', 13), onClick: () => editSpace(S, t) }),
          h('button', {
            class: 'btn sm ghost icon', title: on ? '当前空间不能删除' : '删除这个空间',
            disabled: on,
            html: SH.icon('trash', 13),
            onClick: () => removeSpace(S, t, st)
          }))));
  }

  /* ---------------- 跨空间对比 ---------------- */

  function compareCard(S, compare) {
    const list = (compare || []).slice().sort((a, b) => (b.last7 || 0) - (a.last7 || 0));
    if (!list.length) return h('div', { class: 'card' }, SH.empty('还没有学科空间', null, 'grid'));

    const max7 = Math.max(1, ...list.map((r) => r.last7 || 0));
    const maxAll = Math.max(1, ...list.map((r) => r.minutes || 0));
    /* 只有 1 个空间时，对比图就是一根 100% 的条 —— 那不是图，是噪音。
       直接说清楚它什么时候有用，比画一张空图好。 */
    const onlyOne = list.length < 2;

    const tb = h('table', { class: 'tb tight' },
      h('thead', null, h('tr', null, ...['学科空间', '阶段', '目标', '任务完成', '待复习', '连续', '评分'].map((t) => h('th', null, t)))),
      h('tbody', null, ...list.map((r) => {
        const rate = r.tasks ? Math.round((r.doneTasks / r.tasks) * 100) : 0;
        return h('tr', null,
          h('td', null, h('div', { class: 'row', style: { gap: '7px' } },
            h('span', { class: 'subj-dot', style: { background: r.color } }),
            h('span', { style: { fontWeight: r.active ? '650' : '500' } }, r.name),
            r.active ? h('span', { class: 'chip ok', style: { height: '17px', padding: '0 6px', fontSize: '10px' } }, '当前') : null)),
          h('td', { class: 'nowrap small muted' }, LEVEL_LABEL[r.level] || '通用'),
          h('td', { class: 'mono small nowrap' }, `${F.hm(r.todayMin || 0)}/${F.hm(r.goal || 0)}`),
          h('td', { class: 'nowrap' }, r.tasks ? `${r.doneTasks}/${r.tasks} · ${rate}%` : '—'),
          h('td', { class: 'mono small' }, String(r.reviews || 0)),
          h('td', { class: 'mono small' }, String(r.streak || 0)),
          h('td', { class: 'mono small', style: { fontWeight: '600' } }, String(r.score || 0)));
      })));

    return h('div', { class: 'card' },
      h('div', { class: 'card-body', style: { paddingBottom: 0 } },
        onlyOne
          ? h('div', { class: 'row', style: { gap: '12px', alignItems: 'center', marginBottom: '14px' } },
            h('span', { html: SH.icon('info', 16), style: { color: 'var(--muted)', flex: '0 0 auto' } }),
            h('div', { class: 'small', style: { color: 'var(--text-2)' } },
              '现在只有 1 个学科空间，比较还没有意义。到下面的模板库再建一个（比如本科的「数据科学」+ 研究生的「生物信息学」），这里就会显示两边各自的投入与进展。'))
          : null,
        SH.vizHead('近 7 天专注时长', '按空间比较 —— 一眼看出最近精力压在哪一边'),
        SH.html(SH.viz.hbars({
          items: list.map((r) => ({
            label: r.name,
            value: r.last7 || 0,
            color: r.color,
            sub: r.tasks ? `${r.doneTasks}/${r.tasks} 项任务` : '',
            title: `${r.name}：近 7 天 ${F.dur(r.last7 || 0)} · 累计 ${F.dur(r.minutes || 0)} · 连续打卡 ${r.streak || 0} 天`
          })),
          max: max7,
          unitLabel: (v) => F.hm(v)
        })),
        h('div', { style: { marginTop: '16px' } },
          SH.vizHead('累计投入', '这个空间从头到现在一共投入了多少'),
          SH.html(SH.viz.hbars({
            items: list.map((r) => ({ label: r.name, value: r.minutes || 0, color: r.color })),
            max: maxAll,
            unitLabel: (v) => F.hm(v)
          })))),
      h('div', { style: { overflow: 'hidden', marginTop: '6px' } }, tb));
  }

  /* ---------------- 模板库 ---------------- */

  function templateSection(templates) {
    const list = templates || [];
    const byLevel = q.level ? list.filter((t) => t.levels.some((l) => l.level === q.level)) : list;
    const kw = q.text.trim().toLowerCase();
    const shown = kw
      ? byLevel.filter((t) => (t.field + t.aka + t.parents.join('')).toLowerCase().includes(kw))
      : byLevel;

    const box = h('div');

    const inp = h('input', {
      class: 'inp', style: { maxWidth: '230px' }, placeholder: '搜领域或母学科…', value: q.text,
      onInput: (e) => { q.text = e.target.value; q._focus = true; SH.app.reload(); }
    });
    if (q._focus) {
      // 重绘会重建输入框，所以要把焦点与光标位置还回去，否则打一个字就断了
      setTimeout(() => { try { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); } catch (_) {} q._focus = false; }, 0);
    }

    box.appendChild(h('div', { class: 'row', style: { gap: '8px', marginBottom: '12px', flexWrap: 'wrap' } },
      ...[['', '全部阶段'], ['undergrad', '本科'], ['grad', '研究生']].map(([v, label]) =>
        h('button', {
          class: 'btn sm' + (q.level === v ? ' primary' : ''),
          onClick: () => { q.level = v; SH.app.reload(); }
        }, label)),
      h('div', { style: { flex: '1' } }),
      inp,
      h('span', { class: 'small muted nowrap' }, `${shown.length} / ${list.length} 个领域`)));

    if (!shown.length) {
      box.appendChild(h('div', { class: 'card' }, SH.empty('没有匹配的领域', '换个关键词，或把阶段筛回「全部」。', 'search')));
      return box;
    }

    box.appendChild(h('div', { class: 'grid g3' }, ...shown.map((t) => templateCard(t))));
    return box;
  }

  function templateCard(t) {
    return h('div', { class: 'card' },
      h('div', { class: 'card-body tpl-card' },
        h('div', { class: 'row', style: { gap: '9px', alignItems: 'center' } },
          h('span', { class: 'subj-dot', style: { background: t.color, width: '12px', height: '12px', flex: '0 0 12px' } }),
          h('div', { style: { flex: '1', minWidth: 0 } },
            h('div', { style: { fontWeight: '680', fontSize: '13.5px', letterSpacing: '-.2px' } }, t.field),
            h('div', { class: 'tp-aka' }, t.aka))),
        h('div', { class: 'sc-parents' }, ...t.parents.map((p) => h('span', {
          class: 'chip', style: { height: '19px', padding: '0 7px', fontSize: '10.5px' }
        }, p))),
        h('div', { class: 'tp-blurb', title: t.blurb }, t.blurb),
        h('div', { class: 'tpl-levels' }, ...t.levels
          .filter((l) => !q.level || l.level === q.level)
          .map((l) => h('button', {
            class: 'tpl-btn',
            title: `${l.label}：${l.courses.join('、')}`,
            onClick: () => createFromTemplate(t, l)
          },
            h('span', { class: 'ss-dot', style: { background: LEVEL_HUE[l.level] || '#64748b' } }),
            h('div', { style: { flex: '1', minWidth: 0 } },
              h('div', { class: 'tb-lv' }, `${l.label} · ${l.stage}`),
              h('div', { class: 'tb-courses' }, `${l.courseCount} 门课 · ${l.courseCount ? l.courses[0] : ''}${l.courses.length > 1 ? ' 等' : ''}`)),
            h('span', { class: 'tb-go' }, '创建 →'))))));
  }

  /* ------------------------------------------------------------------ *
   * 动作
   * ------------------------------------------------------------------ */

  async function createFromTemplate(t, lv) {
    const ok = await SH.confirm({
      title: `创建「${t.field} · ${lv.label}」`,
      message: `会新建一个独立的学科空间，预置 ${lv.courseCount} 门课程（${lv.courses.slice(0, 3).join('、')}${lv.courses.length > 3 ? ' 等' : ''}）、`
        + `计划「${lv.planTitle}」（${lv.weeks} 周、${lv.taskCount} 项任务）以及第一批复习条目。\n\n当前空间不受影响。`,
      okText: '创建'
    });
    if (!ok) return;
    const r = await api.tenants.fromTemplate(t.id, lv.level);
    if (!r || !r.ok) {
      SH.toast({ title: '创建失败', body: (r && r.message) || '未知错误', kind: 'warn' });
      return;
    }
    await SH.app.refresh();
    SH.toast({
      title: `已创建「${r.tenant.name}」`,
      body: `科目 ${r.created.subjects} · 资料 ${r.created.materials} · 计划任务 ${r.created.tasks} · 复习 ${r.created.reviews}`,
      kind: 'ok',
      timeout: 9000
    });
  }

  async function newSpaceDialog(S) {
    const v = await SH.formDialog({
      title: '新建学科空间',
      fields: [
        { name: 'name', label: '空间名称', placeholder: '例：材料计算 · 课题' },
        { name: 'field', label: '学科 / 领域', placeholder: '例：材料科学与工程' },
        {
          name: 'level', label: '阶段', type: 'select', value: 'any',
          options: [{ value: 'undergrad', label: '本科' }, { value: 'grad', label: '研究生' }, { value: 'any', label: '不限' }]
        },
        { name: 'blurb', label: '一句话说明', type: 'textarea', placeholder: '这个空间是为什么建的？' }
      ],
      okText: '创建'
    });
    if (!v || !String(v.name || '').trim()) return;
    const color = PALETTE[(S.tenants || []).length % PALETTE.length];
    const r = await api.tenants.create({
      name: String(v.name).trim(),
      field: v.field,
      level: v.level,
      blurb: v.blurb,
      color,
      kind: 'custom'
    });
    if (!r || !r.ok) {
      SH.toast({ title: '创建失败', body: (r && r.message) || '未知错误', kind: 'warn' });
      return;
    }
    await SH.app.refresh();
    SH.toast({ title: `已创建空空间「${r.tenant.name}」`, body: '里面还没有课程和计划，可以从模板库一键建，也可以自己添加。', kind: 'ok', timeout: 7000 });
  }

  async function editSpace(S, t) {
    const v = await SH.formDialog({
      title: '编辑学科空间',
      fields: [
        { name: 'name', label: '空间名称', value: t.name },
        { name: 'field', label: '学科 / 领域', value: t.field, placeholder: '例：生物信息学' },
        {
          name: 'level', label: '阶段', type: 'select', value: t.level,
          options: [{ value: 'undergrad', label: '本科' }, { value: 'grad', label: '研究生' }, { value: 'any', label: '不限' }]
        },
        { name: 'blurb', label: '一句话说明', type: 'textarea', value: t.blurb }
      ],
      okText: '保存'
    });
    if (!v || !String(v.name || '').trim()) return;
    const r = await api.tenants.update(t.id, {
      name: String(v.name).trim(),
      field: v.field,
      level: v.level,
      blurb: v.blurb
    });
    if (!r || !r.ok) { SH.toast({ title: '保存失败', body: (r && r.message) || '', kind: 'warn' }); return; }
    await SH.app.refresh();
    SH.toast({ title: '已保存', kind: 'ok', timeout: 2500 });
  }

  async function removeSpace(S, t, st) {
    const ok = await SH.confirm({
      title: `删除「${t.name}」？`,
      message: `会连同这个空间里的 ${st.subjects || 0} 门课、${st.materials || 0} 份资料、`
        + `${st.plans || 0} 个计划、${st.sessions || 0} 条学习记录一起删除，无法撤销。\n\n`
        + '其它学科空间不受影响。如果只是想暂时不用，建议留着 —— 删掉的数据找不回来。',
      okText: '删除',
      danger: true
    });
    if (!ok) return;
    const r = await api.tenants.remove(t.id);
    if (!r || !r.ok) { SH.toast({ title: '删除失败', body: (r && r.message) || '', kind: 'warn' }); return; }
    await SH.app.refresh();
    SH.toast({ title: `已删除「${t.name}」`, kind: 'ok', timeout: 4000 });
  }

  SH.views.spaces = {
    title: '学科空间',
    sub: (S) => {
      const n = (S.tenants || []).length;
      const t = S.activeTenant;
      return `${n} 个空间 · 当前是「${t ? t.name : '—'}」`;
    },
    /* 从别的页面回来时把搜索词清掉：它是一次性的过滤条件，
       留着会让「模板库怎么少了几个」变成一个需要排查的问题。 */
    onEnter() { q.text = ''; },
    load,
    render
  };
})();
