/* preview-ui.js —— 应用内资料预览
   设计原则：能把资料留在应用里看，就不要把人踢到外部程序去。
   一旦切出去（尤其是切到浏览器），注意力基本就回不来了。所以
   文本 / 代码 / Markdown / 图片 / 笔记 全部内联；只有 PDF 和真正打不开的格式
   才交给系统（PDF 用 Chromium 自带阅读器单开一个窗口，体验和外部阅读器一样好）。 */
(function () {
  'use strict';
  const SH = window.SH;
  const h = SH.h, api = SH.api, F = SH.fmt, md = SH.markdown;

  const ui = {};

  /** 按 id 预览：先探测，再决定走哪条路。
   *  必须把结果 return 出去 —— 调用方（比如自检脚本）需要拿它来关闭弹窗。 */
  ui.byId = async function (id) {
    const p = await api.preview.probe(id);
    if (!p.ok) {
      SH.toast({ title: '打不开这份资料', body: p.message, kind: 'warn', timeout: 7000 });
      return null;
    }
    return ui.dispatch(id, p);
  };

  ui.dispatch = async function (id, probe) {
    if (probe.kind === 'link') {
      const r = await api.system.openExternal(probe.url);
      if (!r.ok) SH.toast({ title: '打不开链接', body: r.message, kind: 'warn' });
      else await api.materials.logOpen(id);
      return;
    }
    if (probe.kind === 'pdf' || probe.kind === 'external' || probe.kind === 'missing') {
      if (probe.kind !== 'pdf') {
        SH.toast({
          title: probe.kind === 'missing' ? '文件已不在原位置' : '用系统程序打开',
          body: probe.reason || '', kind: 'info', timeout: 5000
        });
      }
      await api.preview.openNative(id);
      return;
    }
    return ui.inline(id, probe);
  };

  /* ------------------------------------------------------------------ *
   * 内联预览弹窗
   * ------------------------------------------------------------------ */
  ui.inline = async function (id, probe) {
    const S = SH.state;
    const m = (S.db.materials || []).find((x) => x.id === id) || {};
    const sub = (S.db.subjects || []).find((x) => x.id === m.subjectId);

    const content = h('div', { class: 'pv-content' });
    const toolbar = h('div', { class: 'pv-toolbar' });

    /* 应用内笔记本身就是 Markdown 写的，所以和 .md 文件走同一条渲染路径。
       只有确定了「这不是 Markdown」时才退回纯文本展示。 */
    const isMd = probe.kind === 'markdown' || probe.kind === 'inline-note';
    let viewMode = isMd ? 'render' : 'raw';

    const setMode = (mode) => {
      viewMode = mode;
      [...toolbar.querySelectorAll('[data-mode]')].forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    };

    /* ---- 载入内容 ---- */
    let payload = null;
    if (probe.kind === 'inline-note') {
      payload = { ok: true, text: probe.body || '', title: probe.title, name: '（应用内笔记）', sizeText: '' };
    } else if (probe.kind === 'image') {
      payload = await api.preview.read(id, 'image');
    } else {
      payload = await api.preview.read(id, 'text');
    }

    const paint = () => {
      SH.clear(content);
      if (!payload.ok) {
        content.appendChild(SH.empty('读不出来', payload.message || '未知错误', 'alert'));
        return;
      }

      if (probe.kind === 'image') {
        content.appendChild(h('div', { class: 'pv-image' },
          h('img', { src: payload.dataUrl, alt: payload.title || '' })));
        return;
      }

      const text = payload.text || '';
      if (isMd && viewMode === 'render') {
        const box = h('div', { class: 'pv-md' });
        box.appendChild(md.node(text));
        const st = md.stats(text);
        box.appendChild(h('div', { class: 'small muted', style: { marginTop: '16px' } },
          `约 ${st.chars} 字符 · ${st.lines} 行 · 预计阅读 ${st.minutes} 分钟`));
        content.appendChild(box);
      } else {
        content.appendChild(h('pre', { class: 'pv-pre' }, text));
      }
      if (payload.truncated) {
        content.appendChild(h('div', { class: 'pv-warn' },
          `文件较大，只显示了前 ${Math.round((payload.text || '').length / 1024)}KB。完整内容请用「在文件夹中显示」后打开。`));
      }
    };

    /* ---- 工具条 ---- */
    toolbar.appendChild(h('span', { class: 'chip', html: SH.icon(SH.materialIcon(m.type), 12) + `<span style="margin-left:4px">${SH.esc(probe.ext || (probe.kind === 'inline-note' ? (probe.fromNote ? '备注' : '笔记') : probe.kind))}</span>` }));
    if (probe.sizeText) toolbar.appendChild(h('span', { class: 'small muted' }, probe.sizeText));
    if (probe.mtime) toolbar.appendChild(h('span', { class: 'small muted' }, '修改于 ' + F.relTime(probe.mtime)));
    if (sub) toolbar.appendChild(h('span', { class: 'chip clickable', onClick: () => { mo.close(); SH.app.go('materials'); } },
      h('span', { class: 'dot', style: { background: sub.color } }), sub.name));
    toolbar.appendChild(h('div', { style: { flex: '1' } }));

    if (isMd) {
      const tabs = h('div', { class: 'pill-tabs' });
      [['render', '渲染'], ['raw', '源码']].forEach(([mode, label]) => {
        const b = h('button', { dataset: { mode }, class: viewMode === mode ? 'active' : '' }, label);
        b.addEventListener('click', () => { setMode(mode); paint(); });
        tabs.appendChild(b);
      });
      toolbar.appendChild(tabs);
    }

    if (payload.ok && probe.kind !== 'image' && (payload.text || '').length) {
      toolbar.appendChild(h('button', {
        class: 'btn sm', title: '复制全文',
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(payload.text || '');
            SH.toast({ title: '已复制全文', kind: 'ok', timeout: 2500 });
          } catch (_) { SH.toast({ title: '复制失败', body: '系统剪贴板不可用', kind: 'warn' }); }
        }
      }, '复制'));
    }
    if (m.path) {
      toolbar.appendChild(h('button', {
        class: 'btn sm', title: '在文件夹中显示',
        onClick: async () => {
          const r = await api.materials.revealInFolder(id);
          if (!r.ok) SH.toast({ title: '打不开', body: r.message, kind: 'warn' });
        }
      }, '显示文件'));
    }
    toolbar.appendChild(h('button', {
      class: 'btn sm', title: '用系统默认程序打开',
      onClick: () => api.preview.openNative(id)
    }, '外部打开'));

    /* ---- 底部动作 ---- */
    const footer = h('div', { class: 'pv-foot' },
      h('button', {
        class: 'btn primary', html: SH.icon('play', 14) + '<span style="margin-left:5px">就学这一份</span>',
        onClick: () => {
          mo.close();
          SH.app.startFocus({ subjectId: m.subjectId || '', materialId: id });
        }
      }),
      h('button', {
        class: 'btn', html: SH.icon('plus', 14) + '<span style="margin-left:5px">加入复习队列</span>',
        onClick: async () => {
          const r = await api.reviews.fromMaterial(id);
          if (r.already) SH.toast({ title: '这份资料已经在复习队列里了', kind: 'info', timeout: 3000 });
          else if (r.ok) SH.toast({ title: '已加入复习队列', body: `「${r.row.title}」明天第一次复习。`, kind: 'ok', timeout: 4500 });
          SH.app.refresh();
        }
      }),
      h('button', {
        class: 'btn', onClick: () => { mo.close(); SH.app.go('materials'); }
      }, '回到资料库'),
      h('div', { style: { flex: '1' } }),
      h('span', { class: 'small muted' }, '预览不会改动文件本身'));

    paint();

    const body = h('div', { class: 'pv-wrap' }, toolbar, content);
    const mo = SH.modal({ title: probe.title || m.title || '预览', body, footer, wide: true });
    return mo;
  };

  /** 给其他视图复用的小入口：直接在弹窗里看一份资料的正文（笔记类） */
  ui.note = function (title, text) {
    const box = h('div', { class: 'pv-md' }, md.node(text || '（还没有内容）'));
    return SH.modal({ title, body: h('div', { class: 'pv-wrap' }, box), wide: true });
  };

  SH.previewUI = ui;
})();
