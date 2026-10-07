/* views/materials.js —— 学习资料：统一入库、按科目归档、记录进度与投入时间 */
(function () {
  'use strict';
  const SH = window.SH;
  const h = SH.h, api = SH.api, F = SH.fmt;

  const TYPES = [
    ['doc', '文档'], ['book', '书籍'], ['note', '笔记'], ['slide', '课件'], ['sheet', '表格'],
    ['video', '视频'], ['audio', '音频'], ['image', '图片'], ['code', '代码'],
    ['link', '链接'], ['archive', '压缩包'], ['other', '其他']
  ];
  const TYPE_LABEL = Object.fromEntries(TYPES);
  const STATUS = { todo: '未开始', doing: '进行中', done: '已完成' };
  const STATUS_COLOR = { todo: '', doing: 'accent', done: 'ok' };

  const q = { text: '', subject: '', type: '', status: '', view: 'grid' };

  SH.views.materials = {
    title: '学习资料',
    sub: () => '所有资料存在你自己电脑上，这里只记录位置、进度和投入的时间',

    async load() { return await api.stats.materialReport(); },

    render(root, S, rep) {
      root.appendChild(summary(S, rep));
      root.appendChild(toolbar(S));
      const list = filtered(S);
      if (!list.length) {
        root.appendChild(h('div', { class: 'card' }, SH.empty(
          (S.db.materials || []).length ? '没有符合筛选条件的资料' : '资料库还是空的',
          (S.db.materials || []).length ? '换个筛选条件试试。' : '可以导入本地文件、扫描整个文件夹，或者直接存一条链接/笔记。',
          'material')));
      } else {
        root.appendChild(q.view === 'grid'
          ? h('div', { class: 'mat-grid' }, list.map((m) => card(m, S, () => detail(S, m))))
          : tableView(S, list));
      }
      if (rep.neverOpened.length || rep.idle.length) {
        root.appendChild(h('h2', { class: 'section' }, '资料体检'));
        root.appendChild(healthCard(S, rep));
      }
    }
  };

  function filtered(S) {
    const t = q.text.trim().toLowerCase();
    return (S.db.materials || []).filter((m) => {
      if (q.subject && m.subjectId !== q.subject) return false;
      if (q.type && m.type !== q.type) return false;
      if (q.status && m.status !== q.status) return false;
      if (t) {
        const hay = [m.title, m.note, (m.tags || []).join(' '), m.path, m.url].join(' ').toLowerCase();
        if (!hay.includes(t)) return false;
      }
      return true;
    }).sort((a, b) => {
      const w = { doing: 0, todo: 1, done: 2 };
      return (w[a.status] ?? 1) - (w[b.status] ?? 1) || new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
    });
  }

  /* ---------------- 概览 ---------------- */
  function summary(S, rep) {
    const ms = S.db.materials || [];
    const doing = ms.filter((m) => m.status === 'doing').length;
    const done = ms.filter((m) => m.status === 'done').length;
    return h('div', { class: 'grid g4' },
      SH.statCard({ label: '资料总数', value: ms.length, unit: '份', icon: 'material', desc: `进行中 ${doing} · 已完成 ${done}` }),
      SH.statCard({ label: '累计投入', value: F.dur(rep.totalMin), icon: 'clock', desc: '关联资料后自动累计' }),
      SH.statCard({ label: '从未打开', value: rep.neverOpened.length, unit: '份', icon: 'alert', desc: rep.neverOpened.length ? '收藏 ≠ 学会' : '都翻过了' }),
      SH.statCard({ label: `闲置 ${rep.idleDays} 天以上`, value: rep.idle.length, unit: '份', icon: 'moon', desc: rep.idle.length ? '考虑排进计划或清理' : '没有闲置资料' }));
  }

  /* ---------------- 工具条 ---------------- */
  function toolbar(S) {
    const bar = h('div', { class: 'card pad', style: { marginBottom: '14px' } });

    const search = h('input', { class: 'input', placeholder: '搜索标题 / 标签 / 备注 / 路径', value: q.text, style: { maxWidth: '260px' } });
    let timer = null;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { q.text = search.value; SH.app.reload(); }, 220);
    });

    const mkSel = (key, label, opts) => {
      const s = h('select', { class: 'select', style: { width: 'auto', minWidth: '112px' } },
        h('option', { value: '' }, label),
        ...opts.map(([v, l]) => h('option', { value: v, selected: v === q[key] }, l)));
      s.value = q[key];
      s.addEventListener('change', () => { q[key] = s.value; SH.app.reload(); });
      return s;
    };

    const viewToggle = h('div', { class: 'pill-tabs' });
    [['grid', '网格'], ['list', '列表']].forEach(([v, l]) => {
      const b = h('button', { class: q.view === v ? 'active' : '' }, l);
      b.addEventListener('click', () => { q.view = v; SH.app.reload(); });
      viewToggle.appendChild(b);
    });

    bar.appendChild(h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
      search,
      mkSel('subject', '全部科目', (S.db.subjects || []).map((s) => [s.id, s.name])),
      mkSel('type', '全部类型', TYPES),
      mkSel('status', '全部状态', Object.entries(STATUS)),
      h('div', { style: { flex: '1' } }),
      viewToggle,
      h('button', { class: 'btn primary', html: SH.icon('plus', 15) + '<span style="margin-left:4px">添加资料</span>', onClick: () => addMenu(S) })));
    return bar;
  }

  /* ---------------- 资料卡 ---------------- */
  function card(m, S, onClick) {
    const sub = (S.db.subjects || []).find((z) => z.id === m.subjectId);
    const progress = progressOf(m);
    const color = sub ? sub.color : '#94a3b8';
    return h('div', { class: 'mat', onClick },
      h('div', { class: 'm-top' },
        h('span', { class: 'm-ico', style: { background: color + '1f', color }, html: SH.icon(SH.materialIcon(m.type), 17) }),
        h('div', { style: { flex: '1', minWidth: 0 } },
          h('div', { class: 'm-title' }, m.title),
          h('div', { class: 'm-sub row', style: { gap: '7px', marginTop: '3px', flexWrap: 'wrap' } },
            sub ? h('span', { class: 'row', style: { gap: '4px' } }, h('span', { class: 'subj-dot', style: { background: sub.color, width: '7px', height: '7px', flex: '0 0 7px' } }), sub.name) : null,
            h('span', null, TYPE_LABEL[m.type] || '其他'),
            (m.tags || []).slice(0, 2).map((t) => h('span', { class: 'chip', style: { height: '18px', padding: '0 6px', fontSize: '10.5px' } }, t))))
      ),
      m.note ? h('div', { class: 'small muted', style: { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } }, m.note) : null,
      h('div', null,
        h('div', { class: 'row', style: { gap: '8px', marginBottom: '5px' } },
          h('span', { class: 'chip ' + (STATUS_COLOR[m.status] || '') }, STATUS[m.status] || '未开始'),
          h('span', { style: { flex: '1' } }),
          h('span', { class: 'mono small', style: { fontWeight: '600' } }, progress + '%')),
        h('div', { class: 'bar-mini' }, h('i', { style: { width: progress + '%', background: color } }))),
      h('div', { class: 'm-foot' },
        h('span', { html: SH.icon('clock', 12) }), F.dur(m.timeSpentMin || 0),
        h('span', { style: { flex: '1' } }),
        m.openCount ? h('span', null, `${m.openCount} 次 · ${F.relTime(m.lastOpenedAt)}`) : h('span', { class: 'chip warn', style: { height: '18px', padding: '0 6px', fontSize: '10.5px' } }, '从未打开')));
  }

  function progressOf(m) {
    if (m.totalUnits > 0) return Math.round(Math.min(100, ((m.doneUnits || 0) / m.totalUnits) * 100));
    return Math.max(0, Math.min(100, Math.round(m.progress || 0)));
  }

  function tableView(S, list) {
    const tb = h('table', { class: 'tb' });
    tb.appendChild(h('thead', null, h('tr', null,
      ...['资料', '科目', '类型', '状态', '进度', '投入', '最近打开', ''].map((t) => h('th', null, t)))));
    const body = h('tbody');
    list.forEach((m) => {
      const sub = (S.db.subjects || []).find((z) => z.id === m.subjectId);
      const p = progressOf(m);
      body.appendChild(h('tr', { style: { cursor: 'pointer' }, onClick: () => detail(S, m) },
        h('td', null, h('div', { style: { fontWeight: '550' } }, m.title), m.note ? h('div', { class: 'small muted ellipsis', style: { maxWidth: '320px' } }, m.note) : null),
        h('td', null, sub ? h('span', { class: 'row', style: { gap: '5px' } }, h('span', { class: 'subj-dot', style: { background: sub.color } }), sub.name) : h('span', { class: 'muted' }, '—')),
        h('td', null, TYPE_LABEL[m.type] || '其他'),
        h('td', null, h('span', { class: 'chip ' + (STATUS_COLOR[m.status] || '') }, STATUS[m.status] || '未开始')),
        h('td', { style: { width: '110px' } }, h('div', { class: 'row', style: { gap: '7px' } },
          h('div', { style: { flex: '1' } }, SH.progressBar(p / 100)), h('span', { class: 'small mono' }, p + '%'))),
        h('td', { class: 'nowrap' }, F.dur(m.timeSpentMin || 0)),
        h('td', { class: 'nowrap small muted' }, m.openCount ? F.relTime(m.lastOpenedAt) : '从未'),
        h('td', null, h('button', {
          class: 'btn sm', html: SH.icon('external', 13), title: '打开',
          onClick: async (e) => { e.stopPropagation(); await open(S, m); }
        }))));
    });
    tb.appendChild(body);
    return h('div', { class: 'card', style: { overflow: 'hidden' } }, tb);
  }

  /* ---------------- 体检 ---------------- */
  function healthCard(S, rep) {
    const rows = [
      ...rep.neverOpened.map((m) => ({ m, tag: '从未打开', kind: 'warn' })),
      ...rep.idle.map((m) => ({ m, tag: `闲置 ${m.idleFor} 天`, kind: 'danger' }))
    ];
    const list = h('div', { class: 'list' });
    rows.slice(0, 10).forEach(({ m, tag, kind }) => {
      list.appendChild(h('div', { class: 'list-item' },
        h('span', { class: 'chip ' + kind, style: { flex: '0 0 auto' } }, tag),
        h('div', { style: { flex: '1', minWidth: 0 } },
          h('div', { class: 'li-title ellipsis' }, m.title),
          h('div', { class: 'li-sub' }, `加入于 ${F.relTime(m.createdAt)} · 进度 ${m.progress || 0}%`)),
        h('button', { class: 'btn sm', onClick: () => SH.app.startFocus({ subjectId: m.subjectId || '', materialId: m.id }) }, '现在就看'),
        h('button', { class: 'btn sm ghost', onClick: () => detail(S, (S.db.materials || []).find((z) => z.id === m.id)) }, '处理')));
    });
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', null, '在吃灰的资料'),
        h('div', { class: 'grow', style: { flex: '1' } }),
        h('span', { class: 'small muted' }, '收藏了没看，等于没收藏')),
      list);
  }

  /* ---------------- 详情 ---------------- */
  function detail(S, m) {
    if (!m) return;
    const fresh = () => (SH.state.db.materials || []).find((z) => z.id === m.id) || m;

    const body = h('div');
    const paint = () => {
      const mm = fresh();
      SH.clear(body);
      const p = progressOf(mm);

      body.appendChild(h('div', { class: 'row', style: { gap: '10px', marginBottom: '14px' } },
        h('span', { class: 'm-ico', style: { width: '40px', height: '40px', flex: '0 0 40px' }, html: SH.icon(SH.materialIcon(mm.type), 20) }),
        h('div', { style: { flex: '1', minWidth: 0 } },
          h('div', { style: { fontSize: '15px', fontWeight: '600' } }, mm.title),
          h('div', { class: 'small muted' },
            `${TYPE_LABEL[mm.type] || '其他'} · 打开 ${mm.openCount || 0} 次 · 累计投入 ${F.dur(mm.timeSpentMin || 0)}`)),
        h('span', { class: 'chip ' + (STATUS_COLOR[mm.status] || '') }, STATUS[mm.status] || '未开始')));

      body.appendChild(h('div', { class: 'row', style: { gap: '8px', marginBottom: '16px', flexWrap: 'wrap' } },
        h('button', { class: 'btn primary', html: SH.icon('eye', 14) + '<span style="margin-left:5px">在应用内预览</span>', onClick: () => { mo.close(); SH.app.previewById(mm.id); } }),
        h('button', {
          class: 'btn', html: SH.icon('external', 14) + '<span style="margin-left:5px">外部打开</span>',
          onClick: async () => { await api.preview.openNative(mm.id); paint(); }
        }),
        mm.path ? h('button', { class: 'btn', onClick: async () => {
          const r = await api.materials.revealInFolder(mm.id);
          if (!r.ok) SH.toast({ title: '打不开', body: r.message, kind: 'warn' });
        } }, '在文件夹中显示') : null,
        h('button', {
          class: 'btn', html: SH.icon('plus', 14) + '<span style="margin-left:5px">加入复习</span>',
          onClick: async () => {
            const r = await api.reviews.fromMaterial(mm.id);
            if (r.already) SH.toast({ title: '已经在复习队列里了', kind: 'info', timeout: 3000 });
            else if (r.ok) { SH.toast({ title: '已加入复习队列', body: '明天第一次复习。', kind: 'ok' }); SH.app.refresh(); }
          }
        }),
        h('button', { class: 'btn', html: SH.icon('play', 14) + '<span style="margin-left:5px">就学这一份</span>',
          onClick: () => { mo.close(); SH.app.startFocus({ subjectId: mm.subjectId || '', materialId: mm.id }); } }),
        h('div', { style: { flex: '1' } }),
        h('button', { class: 'btn danger sm', onClick: async () => {
          const ok = await SH.confirm({ title: '从资料库移除？', message: '只删除这条记录，不会删除你的文件。', okText: '移除', danger: true });
          if (ok) { await api.materials.remove(mm.id); mo.close(); SH.app.refresh(); }
        } }, '移除')));

      // 路径/链接
      if (mm.path || mm.url) {
        body.appendChild(h('div', { class: 'card pad', style: { marginBottom: '14px', background: 'var(--surface-2)' } },
          h('div', { class: 'small muted', style: { marginBottom: '4px' } }, mm.path ? '文件路径' : '链接'),
          h('div', { class: 'mono small', style: { wordBreak: 'break-all' } }, mm.path || mm.url)));
      }

      // 可编辑字段
      const fields = h('div');
      const mksel = (label, value, opts, onChange) => {
        const s = h('select', { class: 'select' }, ...opts.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
        s.addEventListener('change', () => onChange(s.value));
        return h('label', { class: 'field' }, h('span', { class: 'lb' }, label), s);
      };

      fields.appendChild(mksel('科目', mm.subjectId, [['', '不指定'], ...(S.db.subjects || []).map((z) => [z.id, z.name])], async (v) => {
        await api.materials.update(mm.id, { subjectId: v }); SH.app.refresh(); paint();
      }));
      fields.appendChild(mksel('状态', mm.status, Object.entries(STATUS), async (v) => {
        await api.materials.update(mm.id, { status: v }); SH.app.refresh(); paint();
      }));

      const prog = h('input', { class: 'input', type: 'range', min: 0, max: 100, value: p, style: { padding: '0' } });
      const progLabel = h('span', { class: 'mono small', style: { fontWeight: '600', width: '42px' } }, p + '%');
      prog.addEventListener('input', () => { progLabel.textContent = prog.value + '%'; });
      prog.addEventListener('change', async () => { await api.materials.update(mm.id, { progress: Number(prog.value) }); SH.app.refresh(); });
      fields.appendChild(h('label', { class: 'field' },
        h('div', { class: 'row', style: { marginBottom: '5px' } }, h('span', { class: 'lb', style: { margin: '0' } }, '进度'), h('div', { style: { flex: '1' } }), progLabel),
        prog));

      const units = h('div', { class: 'row', style: { gap: '8px' } },
        h('input', { class: 'input', type: 'number', value: mm.doneUnits || 0, style: { width: '80px' }, id: 'u-done' }),
        h('span', { class: 'muted' }, '/'),
        h('input', { class: 'input', type: 'number', value: mm.totalUnits || 0, style: { width: '80px' }, id: 'u-total' }),
        h('input', { class: 'input', value: mm.unitLabel || '', placeholder: '单位：页/章/讲', style: { width: '110px' }, id: 'u-label' }),
        h('button', { class: 'btn sm', onClick: async () => {
          const done = Number(body.querySelector('#u-done').value) || 0;
          const total = Number(body.querySelector('#u-total').value) || 0;
          const label = body.querySelector('#u-label').value.trim();
          await api.materials.update(mm.id, { doneUnits: done, totalUnits: total, unitLabel: label });
          SH.app.refresh(); paint();
        } }, '保存'));
      fields.appendChild(h('label', { class: 'field' }, h('span', { class: 'lb' }, '按单位记录（可选，填了会覆盖百分比进度）'), units));

      const tags = h('input', { class: 'input', value: (mm.tags || []).join('、'), placeholder: '用「、」或逗号分隔' });
      tags.addEventListener('change', async () => {
        const v = tags.value.split(/[、,，]/).map((x) => x.trim()).filter(Boolean);
        await api.materials.update(mm.id, { tags: v }); SH.app.refresh();
      });
      fields.appendChild(h('label', { class: 'field' }, h('span', { class: 'lb' }, '标签'), tags));

      const note = h('textarea', { class: 'textarea', placeholder: '这份资料怎么用、重点在哪、卡在哪' }, mm.note || '');
      note.addEventListener('change', async () => { await api.materials.update(mm.id, { note: note.value }); SH.app.refresh(); });
      fields.appendChild(h('label', { class: 'field' }, h('span', { class: 'lb' }, '备注'), note));

      const noteBody = h('textarea', { class: 'textarea', style: { minHeight: '120px' }, placeholder: '支持 Markdown：## 标题、**加粗**、`代码`、- 列表、> 引用、| 表格 |' }, mm.body || '');
      noteBody.addEventListener('change', async () => { await api.materials.update(mm.id, { body: noteBody.value }); });

      // 笔记用 Markdown 写，再给一个「渲染预览」按钮 —— 边写边看排版，
      // 比写完再去别处导出确认要省事得多
      const notePreview = h('div', { style: { marginTop: '8px', padding: '12px 14px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: '9px', display: 'none' } });
      const previewBtn = h('button', {
        class: 'btn sm', style: { position: 'absolute', right: '0', top: '0' },
        onClick: () => {
          const on = notePreview.style.display === 'none';
          if (on) { SH.clear(notePreview); notePreview.appendChild(SH.markdown.node(noteBody.value || '')); notePreview.style.display = ''; }
          else notePreview.style.display = 'none';
          previewBtn.textContent = on ? '收起预览' : '渲染预览';
        }
      }, '渲染预览');
      fields.appendChild(h('label', { class: 'field', style: { position: 'relative' } },
        h('span', { class: 'lb' }, '我的笔记'),
        previewBtn, noteBody, notePreview,
        h('span', { class: 'hint' }, '失焦即自动保存 · 支持 Markdown')));

      body.appendChild(fields);
    };

    // mo 先声明再赋值的顺序很关键：下面的 paint() 里的按钮回调都闭包引用了 mo，
    // 而 paint() 在 modal 建出来之前就会被调用一次
    let mo = null;
    paint();
    mo = SH.modal({ title: '资料详情', body, wide: true });
    return mo;
  }

  async function open(S, m) {
    // 统一走预览管线：能内联就内联，只有 PDF / 真正打不开的格式才交给系统
    await SH.app.previewById(m.id);
  }

  /* ---------------- 添加 ---------------- */
  function addMenu(S) {
    const body = h('div', { class: 'grid g2', style: { gap: '10px' } });
    const opt = (icon, title, desc, fn) => h('div', {
      class: 'card pad', style: { cursor: 'pointer' },
      onClick: () => { mo.close(); fn(); }
    }, h('div', { class: 'row', style: { gap: '10px' } },
      h('span', { class: 'm-ico', html: SH.icon(icon, 18) }),
      h('div', null, h('div', { style: { fontWeight: '600', fontSize: '13.5px' } }, title),
        h('div', { class: 'small muted' }, desc))));

    body.appendChild(opt('upload', '选择本地文件', '选择一个或多个文件，原地引用', () => importFiles(S)));
    body.appendChild(opt('folder', '扫描整个文件夹', '批量把某个目录下的学习资料收进来', () => importFolder(S)));
    body.appendChild(opt('link', '添加链接', '网课、在线文档、参考网站', () => addLink(S)));
    body.appendChild(opt('note', '写一条笔记', '直接在这里记，不依赖外部文件', () => addNote(S)));

    const mo = SH.modal({ title: '添加学习资料', body, wide: true });
  }

  async function importFiles(S) {
    const files = await api.materials.pickFiles();
    if (!files || !files.length) return;
    const v = await SH.formDialog({
      title: `导入 ${files.length} 个文件`,
      fields: [
        { name: 'subjectId', label: '归到哪个科目', type: 'select', value: q.subject || '', options: [{ value: '', label: '不指定' }, ...(S.db.subjects || []).map((z) => ({ value: z.id, label: z.name }))] },
        { name: 'tags', label: '统一标签', placeholder: '用「、」分隔，可留空' }
      ],
      okText: '导入'
    });
    if (!v) return;
    const tags = (v.tags || '').split(/[、,，]/).map((x) => x.trim()).filter(Boolean);
    for (const f of files) {
      await api.materials.add({ title: f.title, type: f.type, path: f.path, ext: f.ext, size: f.size, subjectId: v.subjectId, tags });
    }
    SH.toast({ title: `已导入 ${files.length} 份资料`, kind: 'ok', timeout: 4000 });
    SH.app.refresh();
  }

  async function importFolder(S) {
    const res = await api.materials.pickFolder();
    if (!res) return;
    if (!res.files.length) {
      SH.toast({ title: '这个文件夹里没找到能识别的学习资料', body: '支持文档、课件、电子书、音视频、图片、代码等常见格式。', kind: 'warn', timeout: 7000 });
      return;
    }
    const picked = new Set(res.files.map((f) => f.file));
    const body = h('div');
    const sel = h('select', { class: 'select' },
      h('option', { value: '' }, '不指定科目'),
      ...(S.db.subjects || []).map((z) => h('option', { value: z.id }, z.name)));

    const rows = h('div', { style: { maxHeight: '340px', overflow: 'auto', border: '1px solid var(--border)', borderRadius: '8px' } });
    res.files.forEach((f) => {
      const cb = h('input', { type: 'checkbox', checked: true });
      cb.addEventListener('change', () => { cb.checked ? picked.add(f.file) : picked.delete(f.file); });
      rows.appendChild(h('label', { class: 'list-item', style: { cursor: 'pointer' } },
        cb,
        h('span', { class: 'm-ico', style: { width: '26px', height: '26px', flex: '0 0 26px' }, html: SH.icon(SH.materialIcon(f.type), 14) }),
        h('div', { style: { flex: '1', minWidth: 0 } },
          h('div', { class: 'li-title ellipsis' }, f.title),
          h('div', { class: 'li-sub ellipsis' }, f.file)),
        h('span', { class: 'small muted nowrap' }, f.sizeText)));
    });

    body.appendChild(h('div', { class: 'row', style: { gap: '10px', marginBottom: '12px' } },
      h('div', { style: { flex: '1' } },
        h('div', { style: { fontWeight: '600' } }, `扫描到 ${res.files.length} 份资料`),
        h('div', { class: 'small muted ellipsis' }, res.dir)),
      sel));
    body.appendChild(rows);

    const mo = SH.modal({
      title: '批量导入',
      wide: true,
      body,
      footer: [
        h('button', { class: 'btn', onClick: () => mo.close() }, '取消'),
        h('button', { class: 'btn primary', onClick: async () => {
          const list = res.files.filter((f) => picked.has(f.file));
          mo.close();
          for (const f of list) {
            await api.materials.add({ title: f.title, type: f.type, path: f.file, ext: f.ext, size: f.size, subjectId: sel.value, tags: [] });
          }
          SH.toast({ title: `已导入 ${list.length} 份资料`, kind: 'ok' });
          SH.app.refresh();
        } }, '导入选中的')
      ]
    });
  }

  async function addLink(S) {
    const v = await SH.formDialog({
      title: '添加链接资料',
      fields: [
        { name: 'title', label: '名称', placeholder: '例：B 站 · 数据结构与算法（王卓）' },
        { name: 'url', label: '链接', type: 'url', placeholder: 'https://' },
        { name: 'subjectId', label: '科目', type: 'select', value: '', options: [{ value: '', label: '不指定' }, ...(S.db.subjects || []).map((z) => ({ value: z.id, label: z.name }))] }
      ],
      okText: '添加'
    });
    if (!v || !v.title || !v.url) return;
    await api.materials.add({ title: v.title, url: v.url, subjectId: v.subjectId, type: 'link' });
    SH.app.refresh();
  }

  async function addNote(S) {
    const v = await SH.formDialog({
      title: '新建笔记资料',
      fields: [
        { name: 'title', label: '标题', placeholder: '例：第三章 错题整理' },
        { name: 'subjectId', label: '科目', type: 'select', value: '', options: [{ value: '', label: '不指定' }, ...(S.db.subjects || []).map((z) => ({ value: z.id, label: z.name }))] },
        { name: 'body', label: '内容', type: 'textarea', placeholder: '随手记，之后可以继续补充' }
      ],
      okText: '创建'
    });
    if (!v || !v.title) return;
    await api.materials.add({ title: v.title, subjectId: v.subjectId, type: 'note', body: v.body });
    SH.app.refresh();
  }

  SH.views.materials.card = card;
})();
