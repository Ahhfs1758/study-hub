/* markdown.js —— 极简 Markdown 渲染器
   为什么不引 marked/markdown-it：桌面应用要能完全离线跑，而笔记里用到的语法就这些。
   自己写还有个好处：渲染规则完全可控，不会因为库的版本变化把已有的笔记渲染走样。

   安全前提：**先转义，再套用行内规则**。顺序反了就会出现
   `<img onerror=...>` 这类内容被当成标签解析。代码块在转义前就被抽成占位符，
   所以代码里的 `*` 和 `_` 不会被当成强调符号。 */
(function () {
  'use strict';
  const SH = window.SH;
  const md = (SH.markdown = {});

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 只允许 http/https/mailto，挡住 javascript: 之类的伪协议 */
  function safeUrl(u) {
    const s = String(u || '').trim();
    if (/^https?:\/\//i.test(s) || /^mailto:/i.test(s)) return s;
    if (/^[a-z0-9._\-/]+$/i.test(s)) return s;         // 相对路径
    return '';
  }

  /**
   * 行内规则。
   *
   * 🔴 第一步必须是 esc()：Markdown 正文里嵌的 HTML 必须被转义成文本，
   * 否则笔记里写一句 `<img src=x onerror=...>` 就会真的在应用里执行。
   * 注意转义只做这一次 —— 后面所有规则产出的标签都是我们自己拼的，
   * 而从已转义文本里捕获出来的分组（链接地址、图片说明）**不能再 esc 一遍**，
   * 否则 & 会变成 &amp;amp; 这种双重转义。
   */
  function inline(raw) {
    let s = esc(raw);

    // 行内代码先抽走，避免里面的 * _ 被后续规则吃掉（内容此时已转义）
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (_m, c) => {
      codes.push(c);
      return `\u0000CODE${codes.length - 1}\u0000`;
    });

    // 图片：本地相对路径在应用里取不到，渲染成一个「图片」标记而不是必然的裂图
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, alt, url) => {
      const u = safeUrl(url);
      const label = alt || '图片';
      return u
        ? `<a href="${u}" class="md-img" title="${label}">🖼 ${label}</a>`
        : `<span class="md-img">🖼 ${label}</span>`;
    });

    // 链接
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_m, label, url) => {
      const u = safeUrl(url);
      return u ? `<a href="${u}" target="_blank" rel="noreferrer">${label}</a>` : label;
    });

    // 裸链接（只认没被上面的规则处理过的）
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_m, pre, u) => `${pre}<a href="${u}" target="_blank" rel="noreferrer">${u}</a>`);

    s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^\w])__([^_]+)__(?!\w)/g, '$1<strong>$2</strong>');
    s = s.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/==([^=]+)==/g, '<mark>$1</mark>');
    s = s.replace(/(^|\s)#([\u4e00-\u9fa5\w\-/]+)/g, '$1<span class="md-tag">#$2</span>');

    // 复原行内代码（内容已在最外层转义过）
    s = s.replace(/\u0000CODE(\d+)\u0000/g, (_m, i) => `<code>${codes[Number(i)]}</code>`);
    return s;
  }

  /** 列表项：支持 - [ ] / - [x] 复选框 */
  function listItem(li) {
    const m = /^\[([ xX])\]\s*(.*)$/.exec(li);
    if (m) {
      const checked = m[1].toLowerCase() === 'x';
      return `<li class="md-task${checked ? ' md-task-done' : ''}"><span class="md-cb">${checked ? '✓' : ''}</span>${inline(m[2])}</li>`;
    }
    return `<li>${inline(li)}</li>`;
  }

  function renderTable(rows) {
    const cells = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
    const head = cells(rows[0]);
    const body = rows.slice(1);
    const align = (rows[1] && /^\s*\|?[\s:|-]+\|?\s*$/.test(rows[1])) ? cells(rows[1]).map((c) =>
      c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left') : null;
    const start = align ? 2 : 1;

    const th = head.map((c, i) => `<th style="text-align:${align ? align[i] : 'left'}">${inline(c)}</th>`).join('');
    const trs = rows.slice(start).map((r) => {
      const cs = cells(r);
      return '<tr>' + head.map((_h, i) =>
        `<td style="text-align:${align ? align[i] : 'left'}">${inline(cs[i] || '')}</td>`).join('') + '</tr>';
    }).join('');
    return `<table class="md-table"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
  }

  /** 主渲染函数：Markdown 文本 → HTML 字符串 */
  md.render = function (src) {
    const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // 围栏代码块
      const fence = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/.exec(line);
      if (fence) {
        const mark = fence[1];
        const lang = fence[2] || '';
        const buf = [];
        i++;
        while (i < lines.length && !new RegExp('^\\s*' + mark).test(lines[i])) { buf.push(lines[i]); i++; }
        i++;                                   // 跳过收尾的围栏
        out.push(`<pre class="md-pre"${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(buf.join('\n'))}</code></pre>`);
        continue;
      }

      // 空行
      if (!line.trim()) { i++; continue; }

      // 分隔线
      if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { out.push('<hr class="md-hr">'); i++; continue; }

      // 标题
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        const lv = h[1].length;
        out.push(`<h${lv} class="md-h md-h${lv}">${inline(h[2].replace(/\s*#+\s*$/, ''))}</h${lv}>`);
        i++;
        continue;
      }

      // 引用（连续多行合并）
      if (/^\s*>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        out.push(`<blockquote class="md-quote">${md.render(buf.join('\n'))}</blockquote>`);
        continue;
      }

      // 表格：首行有 |，第二行是分隔行
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        const buf = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        out.push(renderTable(buf));
        continue;
      }

      // 无序列表
      if (/^\s*[-*+]\s+/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { buf.push(lines[i].replace(/^\s*[-*+]\s+/, '')); i++; }
        out.push('<ul class="md-ul">' + buf.map(listItem).join('') + '</ul>');
        continue;
      }

      // 有序列表
      if (/^\s*\d+[.)]\s+/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { buf.push(lines[i].replace(/^\s*\d+[.)]\s+/, '')); i++; }
        out.push('<ol class="md-ol">' + buf.map((x) => `<li>${inline(x)}</li>`).join('') + '</ol>');
        continue;
      }

      // 段落：吃到空行或下一个块起始
      const buf = [];
      while (i < lines.length && lines[i].trim() &&
        !/^\s*(#{1,6}\s|>\s?|[-*+]\s|\d+[.)]\s|```|~~~)/.test(lines[i]) &&
        !/^\s*([-*_])\s*(\1\s*){2,}$/.test(lines[i])) {
        buf.push(lines[i]); i++;
      }
      // 逐行 inline 再拼 <br>：不能先把多行拼成一段再 inline，
      // 那样自己插入的 <br> 会被 esc() 转义成 &lt;br&gt;
      if (buf.length) out.push(`<p class="md-p">${buf.map(inline).join('<br>')}</p>`);
      else i++;                                // 兜底：绝不因为一条没匹配上就死循环
    }

    return out.join('\n');
  };

  /** 渲染成 DOM 节点 */
  md.node = function (src) {
    const box = SH.h('div', { class: 'md-body' });
    box.innerHTML = md.render(src);
    // 链接一律交给主进程走系统浏览器，不在应用内开新窗口
    box.addEventListener('click', (e) => {
      const a = e.target.closest('a[href]');
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute('href');
      if (/^https?:\/\//i.test(href)) SH.api.system.openExternal(href);
    });
    return box;
  };

  /** 粗略统计：字数、行数、预计阅读分钟（中文按 400 字/分） */
  md.stats = function (src) {
    const text = String(src || '');
    const cn = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const words = (text.replace(/[\u4e00-\u9fa5]/g, ' ').match(/[A-Za-z0-9_'-]+/g) || []).length;
    const lines = text.split('\n').filter((l) => l.trim()).length;
    return {
      chars: text.length,
      cn,
      words,
      lines,
      minutes: Math.max(1, Math.round((cn + words * 1.5) / 400))
    };
  };
})();
