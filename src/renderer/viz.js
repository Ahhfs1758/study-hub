/* viz.js —— 手写 SVG 可视化工具箱（第二批）
 *
 * 目标：**能用图形表达的，就不要用文字**。
 *   · 一个数字        → 仪表 / 环 / 点阵
 *   · 一组占比        → 堆叠条 / 横向条
 *   · 一段时间        → 甘特 / 周条
 *   · 多个维度        → 雷达
 *   · 目标 vs 实际    → 子弹图
 *   · 层层递进        → 阶梯
 *
 * 与 charts.js 的分工：charts.js 放通用基础图形（柱/折线/环形/热力），
 * 这里放「有明确语义」的图形。两者都是手写 SVG 字符串，不引任何图表库 ——
 * 桌面应用必须离线可用。
 *
 * 统一约定：
 *   1. 返回 SVG 字符串；横向类图形 viewBox 宽 720 且 style="width:100%"，自动铺满
 *   2. 每个有意义的图元都带 <title>，鼠标悬停能看到确切数字（无 JS 依赖的提示）
 *   3. 所有文字都过 esc()；颜色写死十六进制（SVG 字符串在插入前就要定色，
 *      读不到 CSS 变量），值与 styles.css 里的变量保持一致
 */
(function () {
  'use strict';
  const SH = window.SH;
  const V = (SH.viz = {});

  const esc = (s) => SH.esc(s);

  /* 配色：与 styles.css 的 CSS 变量一一对应 */
  const INK = { text: '#16203a', text2: '#4b5872', muted: '#8b96ab', grid: '#eef1f6', track: '#e9edf5' };
  const HUE = { accent: '#3b5bfd', ok: '#0f9d6e', warn: '#d97706', danger: '#dc2626', info: '#0891b2', violet: '#7c3aed' };
  const SERIES = ['#3b5bfd', '#7c3aed', '#0891b2', '#0f9d6e', '#d97706', '#dc2626', '#c026d3', '#2563eb', '#059669', '#ea580c'];
  V.HUE = HUE;
  V.SERIES = SERIES;
  /** 给第 i 个系列取色。没指定颜色时按顺序取，保证同名系列在不同图里颜色一致 */
  V.seriesColor = (i) => SERIES[i % SERIES.length];

  /** 依据「达成度」自动选色：高绿、中蓝、偏低橙、很差红 */
  function toneByRatio(r) {
    if (r >= 0.8) return HUE.ok;
    if (r >= 0.55) return HUE.accent;
    if (r >= 0.3) return HUE.warn;
    return HUE.danger;
  }
  V.toneByRatio = toneByRatio;

  const d2 = (n) => (Math.round(n * 100) / 100).toString();

  /* ================================================================== *
   * 1. 半圆仪表盘
   * 一个 0-100 的分数，用仪表表达比一个数字有冲击力得多 ——
   * 弧长本身就传达「离满还有多远」，不需要读者在脑子里换算。
   * ================================================================== */
  V.gauge = function ({
    value = 0, max = 100, size = 210, thickness = 16,
    label = '', sub = '', color, bandColor
  } = {}) {
    const W = size, H = Math.round(size * 0.62) + 30;
    const cx = W / 2, cy = H - 30;
    const r = (W - thickness) / 2 - 8;
    const ratio = Math.max(0, Math.min(1, (max ? (value || 0) / max : 0)));
    const c = color || toneByRatio(ratio);
    const len = Math.PI * r;          // 半圆弧长

    const arcPath = `M ${d2(cx - r)} ${d2(cy)} A ${d2(r)} ${d2(r)} 0 0 1 ${d2(cx + r)} ${d2(cy)}`;
    const parts = [];

    // 底轨
    parts.push(`<path d="${arcPath}" fill="none" stroke="${INK.track}" stroke-width="${thickness}" stroke-linecap="round"/>`);
    // 数值弧（dasharray 铺满半圆）
    if (ratio > 0) {
      parts.push(`<path d="${arcPath}" fill="none" stroke="${c}" stroke-width="${thickness}" stroke-linecap="round"
        stroke-dasharray="${d2(len * ratio)} ${d2(len)}">
        <animate attributeName="stroke-dasharray" from="0 ${d2(len)}" to="${d2(len * ratio)} ${d2(len)}" dur=".55s" fill="freeze"/></path>`);
    }
    // 刻度：每 25% 一个小刻，0/50/100 带数字
    for (let i = 0; i <= 4; i++) {
      const f = i / 4;
      const a = Math.PI * (1 - f);
      const x1 = cx + Math.cos(a) * (r - thickness / 2 - 1);
      const y1 = cy - Math.sin(a) * (r - thickness / 2 - 1);
      const x2 = cx + Math.cos(a) * (r - thickness / 2 - (i % 2 === 0 ? 7 : 4));
      const y2 = cy - Math.sin(a) * (r - thickness / 2 - (i % 2 === 0 ? 7 : 4));
      parts.push(`<line x1="${d2(x1)}" y1="${d2(y1)}" x2="${d2(x2)}" y2="${d2(y2)}" stroke="${INK.track}" stroke-width="1.5" stroke-linecap="round"/>`);
      if (i % 2 === 0) {
        const tx = cx + Math.cos(a) * (r - thickness - 9);
        const ty = cy - Math.sin(a) * (r - thickness - 9) + 3.5;
        parts.push(`<text x="${d2(tx)}" y="${d2(ty)}" text-anchor="middle" font-size="10" fill="${INK.muted}" font-family="inherit">${d2(max * f)}</text>`);
      }
    }
    // 中央数值
    const shown = Math.round(value);
    parts.push(`<text x="${cx}" y="${cy - 10}" text-anchor="middle" font-size="${Math.round(size * 0.19)}" font-weight="700" fill="${c}" font-family="inherit" letter-spacing="-1">${shown}</text>`);
    if (sub) parts.push(`<text x="${cx}" y="${cy + 9}" text-anchor="middle" font-size="11.5" fill="${INK.muted}" font-family="inherit">${esc(sub)}</text>`);
    if (label) parts.push(`<text x="${cx}" y="${cy + 26}" text-anchor="middle" font-size="12" font-weight="600" fill="${INK.text2}" font-family="inherit">${esc(label)}</text>`);

    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="display:block;max-width:100%">
      <title>${esc(label || '达成度')}：${shown} / ${max}</title>${parts.join('')}</svg>`;
  };

  /* ================================================================== *
   * 2. 堆叠柱状图
   * 「每天学了多久」+「分别是哪一科」两件事，一根柱子就能说完 ——
   * 比并排两个图更容易看出「总量没变但结构变了」。
   * ================================================================== */
  V.stackedBars = function ({
    data = [],                 // [{ label, segments:[{value,name,color}], title }]
    height = 210, goal = 0,
    /** tooltip 用的可读文案（「1 小时 20 分」） */
    unitLabel = (v) => SH.fmt.hm(v),
    /** 轴刻度用的紧凑文案（1:20）。
        必须与 unitLabel 分开 —— 左边距只有 52px，长文案会被裁成「小时 20 分」。
        这个疏漏被流程断言抓过一次：改了 charts.bars 却忘了同步这里，
        结果统计页的轴还是长文案，而 dashboard 已经修好了，两个页面不一致。 */
    axisLabel = (v) => SH.fmt.hm(v),
    goalLabel = '目标',
    cursor = true
  } = {}) {
    if (!data.length) return '';
    const W = 720, H = height;
    const pl = 46, pr = 16, pt = 16, pb = 30;
    const iw = W - pl - pr, ih = H - pt - pb;

    const totals = data.map((d) => (d.segments || []).reduce((a, s) => a + (s.value || 0), 0));
    const TICKS = 3;
    const rawMax = Math.max(...totals, 0);
    const max = Math.max(niceStep(rawMax, TICKS), goal || 0, 1);
    const n = Math.max(1, data.length);

    const gap = Math.min(10, (iw / n) * 0.34);      // 柱间留白
    const bw = Math.max(4, (iw / n) - gap);

    const parts = [];
    // 网格 + y 轴
    for (let i = 0; i <= TICKS; i++) {
      const t = (max / TICKS) * i;
      const y = pt + ih - (t / max) * ih;
      parts.push(`<line x1="${pl}" y1="${d2(y)}" x2="${W - pr}" y2="${d2(y)}" stroke="${INK.grid}" stroke-width="1"/>`);
      parts.push(`<text x="${pl - 8}" y="${d2(y + 3.5)}" text-anchor="end" font-size="10.5" fill="${INK.muted}" font-family="inherit">${esc(String(axisLabel(t)))}</text>`);
    }
    // 目标线
    if (goal > 0 && goal <= max) {
      const y = pt + ih - (goal / max) * ih;
      parts.push(`<line x1="${pl}" y1="${d2(y)}" x2="${W - pr}" y2="${d2(y)}" stroke="${HUE.warn}" stroke-width="1.4" stroke-dasharray="5 4" opacity=".85"/>`);
      parts.push(`<text x="${W - pr}" y="${d2(y - 5)}" text-anchor="end" font-size="10" fill="${HUE.warn}" font-family="inherit">${esc(goalLabel)} ${esc(String(axisLabel(goal)))}</text>`);
    }

    data.forEach((d, i) => {
      const x = pl + i * (iw / n) + gap / 2;
      const total = totals[i];
      const tip = d.title || `${d.label}：${unitLabel(total)}`;
      const segs = (d.segments || []);
      const layers = [];
      let acc = 0;
      segs.forEach((s, si) => {
        const hgt = (s.value / max) * ih;
        if (hgt <= 0) return;
        const y = pt + ih - acc - hgt;
        const isTop = si === segs.length - 1;
        layers.push(`<rect x="${d2(x)}" y="${d2(y)}" width="${d2(bw)}" height="${d2(hgt)}" rx="${isTop ? Math.min(3, bw / 2) : 0}" fill="${s.color || V.seriesColor(si)}"/>`);
        acc += hgt;
      });
      if (!layers.length) {
        layers.push(`<rect x="${d2(x)}" y="${d2(pt + ih - 2)}" width="${d2(bw)}" height="2" rx="1" fill="${INK.track}"/>`);
      }
      parts.push(`<g><title>${esc(tip)}</title>${layers.join('')}</g>`);

      const step = iw / n;
      const every = n > 20 ? Math.ceil(n / 10) : 1;
      if (i % every === 0 || i === n - 1) {
        parts.push(`<text x="${d2(x + bw / 2)}" y="${H - 10}" text-anchor="middle" font-size="10" fill="${INK.muted}" font-family="inherit">${esc(d.label)}</text>`);
      }
    });

    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block"${cursor ? ' class="viz-pointer"' : ''}>${parts.join('')}</svg>`;
  };

  /* ================================================================== *
   * 3. 甘特图 / 时间轴
   * 计划最有用的信息是「什么时候开始、什么时候结束、现在走到哪了」，
   * 这三件事用一条横条就能说完，而列表要读三行才拼得出来。
   * ================================================================== */
  V.gantt = function ({
    rows = [],                 // [{ label, start, end, progress(0-1), color, milestones:[{at,label,done}], meta }]
    from, to,                  // 'YYYY-MM-DD'；不给就用数据范围
    height, rowHeight = 34, today = null,
    onEmpty = '还没有计划'
  } = {}) {
    if (!rows.length) {
      return `<div class="viz-empty">${esc(onEmpty)}</div>`;
    }
    const parse = (k) => { const [y, m, d] = String(k).split('-').map(Number); return new Date(y, m - 1, d); };
    const dayNum = (k) => Math.round(parse(k).getTime() / 86400000);

    const allD = rows.flatMap((r) => [r.start, r.end]).filter(Boolean).map(dayNum);
    const a0 = from ? dayNum(from) : Math.min(...allD);
    const a1 = to ? dayNum(to) : Math.max(...allD);
    const span = Math.max(1, a1 - a0);

    const W = 720;
    const LABEL_W = 150;
    const pl = LABEL_W + 10, pr = 16, pt = 30, pb = 22;
    const ih = rows.length * rowHeight;
    const H = Math.round(pt + ih + pb);
    const iw = W - pl - pr;

    const xOf = (k) => pl + ((dayNum(k) - a0) / span) * iw;

    const parts = [];
    // 日期刻度
    const tickDays = niceTicks(span, 6);
    for (const d of tickDays) {
      const x = xOf(d);
      if (x < pl - 1 || x > W - pr + 1) continue;
      parts.push(`<line x1="${d2(x)}" y1="${pt - 8}" x2="${d2(x)}" y2="${pt + ih}" stroke="${INK.grid}" stroke-width="1"/>`);
      parts.push(`<text x="${d2(x)}" y="${pt - 12}" text-anchor="middle" font-size="10" fill="${INK.muted}" font-family="inherit">${esc(fmtShortDate(d))}</text>`);
    }
    // 今天竖线
    if (today) {
      const tx = xOf(today);
      if (tx >= pl - 1 && tx <= W - pr + 1) {
        parts.push(`<line x1="${d2(tx)}" y1="${pt - 10}" x2="${d2(tx)}" y2="${pt + ih}" stroke="${HUE.danger}" stroke-width="1.4" stroke-dasharray="4 3" opacity=".7"/>`);
        parts.push(`<text x="${d2(tx)}" y="${d2(pt + ih + 13)}" text-anchor="middle" font-size="9.5" fill="${HUE.danger}" font-family="inherit">今天</text>`);
      }
    }

    rows.forEach((r, i) => {
      const y = pt + i * rowHeight;
      const cy = y + rowHeight / 2 - 3;
      const bh = 13;
      const x0 = xOf(r.start), x1 = Math.max(xOf(r.end), x0 + 3);
      const w = x1 - x0;
      const color = r.color || V.seriesColor(i);

      // 行分隔
      if (i % 2 === 1) parts.push(`<rect x="${pl}" y="${d2(y)}" width="${iw}" height="${rowHeight}" fill="#fafbfe"/>`);

      // 左侧标题
      parts.push(`<text x="${LABEL_W}" y="${d2(cy + 4)}" text-anchor="end" font-size="11.5" fill="${INK.text2}" font-family="inherit">${esc(clip(r.label, 12))}</text>`);

      // 底槽 + 进度条（进度用叠加一条更亮的实心条表达，比百分比数字直观）
      const tip = r.meta || `${r.label}：${r.start} → ${r.end}${r.progress != null ? ` · 进度 ${Math.round(r.progress * 100)}%` : ''}`;
      parts.push(`<g><title>${esc(tip)}</title>
        <rect x="${d2(x0)}" y="${d2(cy - bh / 2)}" width="${d2(w)}" height="${bh}" rx="${bh / 2}" fill="${color}" opacity=".18"/>
        <rect x="${d2(x0)}" y="${d2(cy - bh / 2)}" width="${d2(Math.max(2, w * Math.max(0, Math.min(1, r.progress || 0))))}" height="${bh}" rx="${bh / 2}" fill="${color}"/>
      </g>`);
      // 起止端点
      parts.push(`<circle cx="${d2(x0)}" cy="${d2(cy)}" r="3" fill="#fff" stroke="${color}" stroke-width="1.8"/>`);
      parts.push(`<circle cx="${d2(x1)}" cy="${d2(cy)}" r="3" fill="#fff" stroke="${color}" stroke-width="1.8"/>`);

      // 里程碑：菱形，完成实心、未完成空心
      (r.milestones || []).forEach((m) => {
        const mx = xOf(m.at);
        if (mx < pl - 2 || mx > W - pr + 2) return;
        const my = cy;
        const s = 5;
        parts.push(`<g><title>${esc(m.label || '里程碑')}：${esc(m.at)}${m.done ? ' · 已完成' : ''}</title>
          <path d="M ${d2(mx)} ${d2(my - s)} L ${d2(mx + s)} ${d2(my)} L ${d2(mx)} ${d2(my + s)} L ${d2(mx - s)} ${d2(my)} Z"
                fill="${m.done ? color : '#fff'}" stroke="${color}" stroke-width="1.6"/></g>`);
      });
    });

    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block">${parts.join('')}</svg>`;
  };

  /* ================================================================== *
   * 4. 雷达图
   * 「专注力由几个部分组成」这类多维信息，雷达比一行小字更容易看出短板在哪
   * —— 凹进去的那个角就是下一步该补的地方。
   * ================================================================== */
  V.radar = function ({
    axes = [],                 // [{ label, value(0-1), hint }]
    series = null,             // 可选多系列：[{ name, values:[0-1], color }]
    size = 240, levels = 4, showLabels = true
  } = {}) {
    if (!axes.length) return '';
    /* 左右也必须留白：只加纵向 padding 的话，4 轴（上下左右）时的左右两个标签
       会被 viewBox 裁掉 —— 实测左侧只剩一个「100」，轴名整个消失。
       横向留白按最长标签估，纵向留给轴名与数值两行。 */
    const padX = showLabels ? 44 : 4;
    const padY = showLabels ? 22 : 4;
    const W = size + padX * 2, H = size + padY * 2;
    const cx = W / 2, cy = H / 2;
    const r = size / 2 - (showLabels ? 26 : 8);
    const n = axes.length;
    const ang = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const ptAt = (i, v) => [cx + Math.cos(ang(i)) * r * v, cy + Math.sin(ang(i)) * r * v];

    const parts = [];
    // 同心网格 + 轴线
    for (let L = levels; L >= 1; L--) {
      const f = L / levels;
      const pts = axes.map((_, i) => ptAt(i, f).map(d2).join(',')).join(' ');
      parts.push(`<polygon points="${pts}" fill="${L === levels ? '#fafbfe' : 'none'}" stroke="${INK.grid}" stroke-width="1"/>`);
    }
    axes.forEach((_, i) => {
      const [x, y] = ptAt(i, 1);
      parts.push(`<line x1="${cx}" y1="${cy}" x2="${d2(x)}" y2="${d2(y)}" stroke="${INK.grid}" stroke-width="1"/>`);
    });

    const sets = series && series.length
      ? series
      : [{ name: '当前', values: axes.map((a) => Math.max(0, Math.min(1, a.value || 0))), color: HUE.accent }];

    sets.forEach((s, si) => {
      const vals = s.values.map((v) => Math.max(0, Math.min(1, v || 0)));
      const pts = vals.map((v, i) => ptAt(i, v).map(d2).join(',')).join(' ');
      const color = s.color || V.seriesColor(si);
      parts.push(`<polygon points="${pts}" fill="${color}" fill-opacity="${sets.length > 1 ? '0.12' : '0.18'}" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`);
      vals.forEach((v, i) => {
        const [x, y] = ptAt(i, v);
        parts.push(`<circle cx="${d2(x)}" cy="${d2(y)}" r="3.2" fill="#fff" stroke="${color}" stroke-width="2"/>`);
      });
    });

    // 轴标签：放在圆外，按象限调整对齐方式，避免压到图形
    if (showLabels) {
      axes.forEach((a, i) => {
        const [x, y] = ptAt(i, 1.15);
        const cos = Math.cos(ang(i));
        const anchor = Math.abs(cos) < 0.25 ? 'middle' : cos > 0 ? 'start' : 'end';
        const val = a.value != null ? Math.round(a.value * 100) : null;
        parts.push(`<text x="${d2(x)}" y="${d2(y + 3.5)}" text-anchor="${anchor}" font-size="11" fill="${INK.text2}" font-family="inherit">${esc(a.label)}${val != null ? `<tspan fill="${INK.muted}" font-size="10"> ${val}</tspan>` : ''}</text>`);
      });
    }

    const title = sets.map((s) => `${s.name}：${s.values.map((v, i) => `${axes[i] ? axes[i].label : i}=${Math.round(v * 100)}`).join(' ')}`).join(' / ');
    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="display:block;max-width:100%"><title>${esc(title)}</title>${parts.join('')}</svg>`;
  };

  /* ================================================================== *
   * 5. 子弹图
   * 「实际 vs 目标」是学习管理里最常见的比较。一横条 + 一个目标刻度，
   * 比「已完成 62%（目标 120 分钟）」这种句子读起来快得多。
   * ================================================================== */
  V.bullet = function ({ items = [], unitLabel = (v) => SH.fmt.dur(v) } = {}) {
    if (!items.length) return '';
    const rows = items.map((it) => {
      const max = Math.max(it.value || 0, it.target || 0, it.max || 0, 1);
      const vr = Math.max(0, Math.min(1, (it.value || 0) / max));
      const tr = Math.max(0, Math.min(1, (it.target || 0) / max));
      const c = it.color || toneByRatio(it.target ? (it.value || 0) / it.target : vr);
      const sub = it.sub ? `<span class="bl-sub">${esc(it.sub)}</span>` : '';
      return `<div class="bullet-row"${it.onClick ? ' role="button" tabindex="0"' : ''}>
        <span class="bl-label" title="${esc(it.label)}">${esc(it.label)}</span>
        <span class="bl-track">
          <i class="bl-fill" style="width:${(vr * 100).toFixed(1)}%;background:${c}"></i>
          ${it.target ? `<i class="bl-target" style="left:${(tr * 100).toFixed(1)}%"></i>` : ''}
        </span>
        <span class="bl-value">${esc(it.valueText != null ? it.valueText : unitLabel(it.value))}</span>
        ${sub}
      </div>`;
    }).join('');
    return `<div class="bullets">${rows}</div>`;
  };

  /* ================================================================== *
   * 6. 点阵进度
   * 「12 项任务完成 5 项」—— 12 个点里 5 个点亮，比「5/12」更有存在感，
   * 而且一眼能看出「还剩多少格」，这对「今天还差不差得动」的判断很关键。
   * ================================================================== */
  V.dotMatrix = function ({
    total = 0, done = 0, cols = 0, color = HUE.accent,
    dots = null,            // 也可以直接给 [{ done, title }]，用于非等价的项
    size = 13, gap = 5, maxDots = 200
  } = {}) {
    const list = dots && dots.length
      ? dots.slice(0, maxDots)
      : Array.from({ length: Math.min(total, maxDots) }, (_, i) => ({ done: i < done, title: `第 ${i + 1} 项` }));

    if (!list.length) return '<div class="viz-empty">暂无任务</div>';
    const perRow = cols || (list.length <= 12 ? list.length : list.length <= 40 ? 10 : 14);
    const rows = Math.ceil(list.length / perRow);
    const W = 720;
    const cell = size + gap;
    const usedW = Math.min(perRow, list.length) * cell - gap;
    // 少量点时居中；大量点铺满，避免稀疏
    const startX = list.length <= 14 ? Math.max(0, (W - usedW) / 2) : 2;
    const H = rows * cell - gap + 4;

    const parts = [];
    list.forEach((d, i) => {
      const r0 = Math.floor(i / perRow), c0 = i % perRow;
      const x = startX + c0 * cell + size / 2;
      const y = 2 + r0 * cell + size / 2;
      const fill = d.done ? (d.color || color) : '#fff';
      const stroke = d.done ? (d.color || color) : '#d8dfeb';
      parts.push(`<g class="dot${d.done ? ' on' : ''}"><title>${esc(d.title || (d.done ? '已完成' : '未完成'))}</title>
        <circle cx="${d2(x)}" cy="${d2(y)}" r="${size / 2 - 0.8}" fill="${fill}" stroke="${stroke}" stroke-width="1.6"
          style="animation-delay:${Math.min(i * 12, 400)}ms"/></g>`);
    });
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block">${parts.join('')}</svg>`;
  };

  /* ================================================================== *
   * 7. 复习阶段阶梯
   * 间隔重复的「第几轮」是这条曲线的横轴。用阶梯表达能直接看出
   * 「大部分卡片还堆在第 0-1 轮」——这是需要被看见的信息。
   * ================================================================== */
  V.stages = function ({
    stages = [],               // [{ label, count }]
    total = 0, color = HUE.accent, masteredFrom = 5
  } = {}) {
    if (!stages.length) return '';
    const W = 720, H = 156;
    const pl = 18, pr = 18, pt = 22, pb = 34;
    const iw = W - pl - pr, ih = H - pt - pb;
    const max = Math.max(1, ...stages.map((s) => s.count));
    const step = iw / stages.length;
    const bw = Math.min(46, step * 0.64);

    const parts = [];
    // 阶梯（用折线连起每根柱顶，形成「坡」的意象）
    const pts = stages.map((s, i) => [pl + i * step + step / 2, pt + ih - (s.count / max) * ih]);
    parts.push(`<polyline points="${pts.map((p) => p.map(d2).join(',')).join(' ')}" fill="none" stroke="${color}" stroke-width="1.6" stroke-dasharray="4 4" opacity=".45"/>`);

    stages.forEach((s, i) => {
      const hgt = (s.count / max) * ih;
      const x = pl + i * step + (step - bw) / 2;
      const y = pt + ih - hgt;
      const c = i >= masteredFrom ? HUE.ok : color;
      const op = s.count ? 1 : 0.25;
      if (s.count) {
        parts.push(`<g><title>${esc(s.label)}：${s.count} 个</title>
          <rect x="${d2(x)}" y="${d2(y)}" width="${d2(bw)}" height="${d2(Math.max(2, hgt))}" rx="4" fill="${c}" opacity="${op}"/></rect></g>`);
        parts.push(`<text x="${d2(x + bw / 2)}" y="${d2(y - 5)}" text-anchor="middle" font-size="11" font-weight="600" fill="${INK.text2}" font-family="inherit">${s.count}</text>`);
      } else {
        parts.push(`<rect x="${d2(x)}" y="${d2(pt + ih - 2)}" width="${d2(bw)}" height="2" rx="1" fill="${INK.track}"/>`);
      }
      parts.push(`<text x="${d2(x + bw / 2)}" y="${H - 14}" text-anchor="middle" font-size="10" fill="${INK.muted}" font-family="inherit">${esc(s.label)}</text>`);
    });
    // 基线
    parts.push(`<line x1="${pl}" y1="${pt + ih}" x2="${W - pr}" y2="${pt + ih}" stroke="${INK.grid}" stroke-width="1"/>`);
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block">${parts.join('')}</svg>`;
  };

  /* ================================================================== *
   * 8. 横向条形（分类对比）
   * 类别名长短不一，横条能让文字保持水平可读，而竖柱得把字转 45°。
   * ================================================================== */
  /**
   * 横向条形。
   *
   * `mode: 'pct'` 是一个必要的开关：当各项的**单位不同**（分钟 vs 次数 vs 分数）时，
   * 拿绝对值放在同一根轴上比较是错的 —— 「总时长 +329 分钟」和「场次 +1」
   * 画成两条长度差 300 倍的条，读者会以为时长进步巨大、场次毫无变化，
   * 而实际上这是两个不可比的量。pct 模式下 value 传「变化百分比」，
   * 所有项自然可比。
   */
  V.hbars = function ({
    items = [],                // [{ label, value, color, sub, onClick, title }]
    max = 0, unitLabel = (v) => SH.fmt.hm(v), showRank = false, mode = 'abs'
  } = {}) {
    if (!items.length) return '<div class="viz-empty">暂无数据</div>';
    const top = max || Math.max(1, ...items.map((i) => i.value || 0));
    return `<div class="hbars">${items.map((it, i) => {
      const w = Math.max(0, Math.min(100, ((it.value || 0) / top) * 100));
      const c = it.color || V.seriesColor(i);
      return `<div class="hb-row"${it.onClick ? ` role="button" tabindex="0" data-viz-action="${i}"` : ''} title="${esc(it.title || `${it.label}：${unitLabel(it.value)}`)}">
        ${showRank ? `<span class="hb-rank">${i + 1}</span>` : ''}
        <span class="hb-label" title="${esc(it.label)}">${esc(it.label)}</span>
        <span class="hb-track"><i class="hb-fill" style="width:${w.toFixed(1)}%;background:${c};animation-delay:${Math.min(i * 40, 320)}ms"></i></span>
        <span class="hb-value">${esc(mode === 'pct' ? (unitLabel(it.value) + '%') : unitLabel(it.value))}</span>
        ${it.sub ? `<span class="hb-sub">${esc(it.sub)}</span>` : ''}
      </div>`;
    }).join('')}</div>`;
  };

  /* ================================================================== *
   * 9. 周条
   * 一周七天，每天一格。格子里用一个小小的弧表示当天目标达成度 ——
   * 比「周一 0 分钟 / 周二 45 分钟…」这样一列文字紧凑得多。
   * ================================================================== */
  V.weekStrip = function ({ days = [], goal = 120, weekStart = 1 } = {}) {
    if (!days.length) return '';
    const W = 720, H = 108;
    const pl = 14, pr = 14, pt = 26, pb = 30;
    const iw = W - pl - pr;
    const step = iw / days.length;
    const R = Math.min(21, step * 0.34);
    const wd = ['日', '一', '二', '三', '四', '五', '六'];

    const parts = [];
    days.forEach((d, i) => {
      const cx = pl + i * step + step / 2;
      const cy = pt + R;
      const parse = () => { const [y, m, dd] = String(d.date).split('-').map(Number); return new Date(y, m - 1, dd); };
      const ratio = Math.max(0, Math.min(1, (d.minutes || 0) / (goal || 1)));
      const c = d.minutes ? toneByRatio(ratio) : INK.track;
      const circ = 2 * Math.PI * (R - 3);
      const isToday = d.date === SH.fmt.dayKey();

      parts.push(`<g><title>${esc(SH.fmt.dayLabel(d.date, true))}：${d.minutes ? SH.fmt.dur(d.minutes) : '未学习'}</title>
        <circle cx="${d2(cx)}" cy="${d2(cy)}" r="${d2(R)}" fill="${d.minutes ? 'none' : '#fafbfe'}" stroke="${INK.track}" stroke-width="3"/>
        ${d.minutes ? `<circle cx="${d2(cx)}" cy="${d2(cy)}" r="${d2(R - 3)}" fill="none" stroke="${c}" stroke-width="4.5" stroke-linecap="round"
          stroke-dasharray="${d2(circ * ratio)} ${d2(circ)}" transform="rotate(-90 ${d2(cx)} ${d2(cy)})"/>` : ''}
        <text x="${d2(cx)}" y="${d2(cy + 4)}" text-anchor="middle" font-size="11" font-weight="600" fill="${d.minutes ? INK.text : INK.muted}" font-family="inherit">${d.minutes ? Math.round(d.minutes) : '·'}</text>
        <text x="${d2(cx)}" y="${d2(pt + R * 2 + 16)}" text-anchor="middle" font-size="10" fill="${isToday ? HUE.accent : INK.muted}" font-family="inherit" font-weight="${isToday ? 600 : 400}">${esc(SH.fmt.dayLabel(d.date))}</text>
      </g>`);
    });
    // 图例
    parts.push(`<text x="${W - pr}" y="${H - 4}" text-anchor="end" font-size="10" fill="${INK.muted}" font-family="inherit">圈内为当天分钟数，外圈为日目标完成度</text>`);
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block">${parts.join('')}</svg>`;
  };

  /* ================================================================== *
   * 10. 双向对比条
   * 「提前完成 8 项 / 逾期 3 项」这类正负对比，从中间向两侧伸展最直观，
   * 也避免了两个独立进度条带来的「谁更长」误读。
   * ================================================================== */
  V.diverging = function ({
    rows = [],                 // [{ label, pos, neg, posText, negText }]
    posLabel = '提前', negLabel = '逾期',
    posColor = HUE.ok, negColor = HUE.danger
  } = {}) {
    if (!rows.length) return '<div class="viz-empty">暂无数据</div>';
    const max = Math.max(1, ...rows.flatMap((r) => [r.pos || 0, r.neg || 0]));
    const head = `<div class="dvg-head">
      <span class="dvg-h pos">${esc(posLabel)}</span>
      <span class="dvg-h label"></span>
      <span class="dvg-h neg">${esc(negLabel)}</span>
    </div>`;
    const body = rows.map((r) => {
      const pw = ((r.pos || 0) / max) * 100;
      const nw = ((r.neg || 0) / max) * 100;
      return `<div class="dvg-row">
        <span class="dvg-side left"><i style="width:${pw.toFixed(1)}%;background:${posColor}"></i><b>${esc(r.posText != null ? r.posText : (r.pos || 0))}</b></span>
        <span class="dvg-label" title="${esc(r.label)}">${esc(r.label)}</span>
        <span class="dvg-side right"><b>${esc(r.negText != null ? r.negText : (r.neg || 0))}</b><i style="width:${nw.toFixed(1)}%;background:${negColor}"></i></span>
      </div>`;
    }).join('');
    return head + body;
  };

  /* ================================================================== *
   * 11. 进度环（带中心文字与分段）
   * charts.ring 是给侧边栏用的迷你环；这个是有语义的「进度徽章」，
   * 支持在中心放数字和单位，也能画成多段（如「已完成 / 进行中 / 未开始」）。
   * ================================================================== */
  V.progressRing = function ({
    ratio = 0, size = 112, thickness = 10, label = '', value = '', unit = '',
    color, track = INK.track, segments = null, sub = ''
  } = {}) {
    const c = size / 2;
    const r = (size - thickness) / 2 - 1;
    const circ = 2 * Math.PI * r;
    const col = color || toneByRatio(ratio);

    let arcs = '';
    if (segments && segments.length) {
      // 多段：按比例分配圆周，段间留 2% 空隙避免糊在一起
      const tot = segments.reduce((a, s) => a + (s.value || 0), 0) || 1;
      let off = 0;
      arcs = segments.map((s, i) => {
        const frac = (s.value || 0) / tot;
        const len = Math.max(0, frac * circ - 3);
        const seg = `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${s.color || V.seriesColor(i)}"
          stroke-width="${thickness}" stroke-linecap="round"
          stroke-dasharray="${d2(len)} ${d2(circ - len)}" stroke-dashoffset="${d2(-off)}"
          transform="rotate(-90 ${c} ${c})"><title>${esc(s.label || '')}：${s.value}</title></circle>`;
        off += frac * circ;
        return seg;
      }).join('');
    } else {
      const len = Math.max(0, Math.min(1, ratio)) * circ;
      arcs = `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${col}" stroke-width="${thickness}"
        stroke-linecap="round" stroke-dasharray="${d2(len)} ${d2(circ - len)}" transform="rotate(-90 ${c} ${c})">
        <animate attributeName="stroke-dasharray" from="0 ${d2(circ)}" to="${d2(len)} ${d2(circ - len)}" dur=".55s" fill="freeze"/></circle>`;
    }

    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" style="display:block;flex:0 0 auto">
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${track}" stroke-width="${thickness}"/>
      ${arcs}
      ${value !== '' ? `<text x="${c}" y="${c + (sub ? -1 : 5)}" text-anchor="middle" font-size="${Math.round(size * 0.22)}" font-weight="700" fill="${INK.text}" font-family="inherit">${esc(String(value))}${unit ? `<tspan font-size="${Math.round(size * 0.12)}" font-weight="500" fill="${INK.muted}"> ${esc(unit)}</tspan>` : ''}</text>` : ''}
      ${sub ? `<text x="${c}" y="${c + 15}" text-anchor="middle" font-size="10.5" fill="${INK.muted}" font-family="inherit">${esc(sub)}</text>` : ''}
      ${label ? `<text x="${c}" y="${size - 3}" text-anchor="middle" font-size="10.5" fill="${INK.muted}" font-family="inherit">${esc(label)}</text>` : ''}
    </svg>`;
  };

  /* ================================================================== *
   * 12. 燃尽图（剩余工作量随时间下降）
   * 「计划还剩多少」用燃尽线比「已完成 62%」更能回答「来得及吗」——
   * 关键是理想线（虚线）与实际线的偏离。
   * ================================================================== */
  V.burndown = function ({
    points = [],               // [{ date, remaining }]
    idealFrom = null, idealTo = 0, height = 170,
    heightUnit = (v) => `${Math.round(v)} 项`
  } = {}) {
    if (points.length < 2) return '<div class="viz-empty">需要至少两天的数据才能画燃尽图</div>';
    const W = 720, H = height;
    const pl = 44, pr = 16, pt = 16, pb = 28;
    const iw = W - pl - pr, ih = H - pt - pb;
    const max = Math.max(1, ...points.map((p) => p.remaining), idealFrom || 0);
    const n = points.length - 1;

    const X = (i) => pl + (i / n) * iw;
    const Y = (v) => pt + ih - (v / max) * ih;

    const parts = [];
    for (let i = 0; i <= 3; i++) {
      const t = (max / 3) * i;
      const y = Y(t);
      parts.push(`<line x1="${pl}" y1="${d2(y)}" x2="${W - pr}" y2="${d2(y)}" stroke="${INK.grid}"/>`);
      parts.push(`<text x="${pl - 8}" y="${d2(y + 3.5)}" text-anchor="end" font-size="10.5" fill="${INK.muted}" font-family="inherit">${esc(heightUnit(t))}</text>`);
    }
    // 理想线
    if (idealFrom != null) {
      parts.push(`<line x1="${d2(X(0))}" y1="${d2(Y(idealFrom))}" x2="${d2(X(n))}" y2="${d2(Y(idealTo))}"
        stroke="${HUE.ok}" stroke-width="1.5" stroke-dasharray="5 4" opacity=".8"/>`);
      parts.push(`<text x="${d2(X(n))}" y="${d2(Y(idealTo) - 6)}" text-anchor="end" font-size="10" fill="${HUE.ok}" font-family="inherit">理想进度</text>`);
    }
    // 实际线 + 面积
    const line = points.map((p, i) => `${i ? 'L' : 'M'} ${d2(X(i))} ${d2(Y(p.remaining))}`).join(' ');
    parts.push(`<path d="${line} L ${d2(X(n))} ${d2(pt + ih)} L ${d2(X(0))} ${d2(pt + ih)} Z" fill="${HUE.accent}" opacity=".10"/>`);
    parts.push(`<path d="${line}" fill="none" stroke="${HUE.accent}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`);
    points.forEach((p, i) => {
      parts.push(`<g><title>${esc(SH.fmt.dayLabel(p.date, true))}：还剩 ${esc(heightUnit(p.remaining))}</title>
        <circle cx="${d2(X(i))}" cy="${d2(Y(p.remaining))}" r="3" fill="#fff" stroke="${HUE.accent}" stroke-width="2"/></g>`);
      if (i % Math.ceil(n / 6) === 0 || i === n) {
        parts.push(`<text x="${d2(X(i))}" y="${H - 9}" text-anchor="middle" font-size="10" fill="${INK.muted}" font-family="inherit">${esc(String(p.date).slice(5).replace('-', '/'))}</text>`);
      }
    });
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block">${parts.join('')}</svg>`;
  };

  /* ================================================================== *
   * 13. 一天时间带
   * 「今天学了 3 小时」回答不了「我今天是什么时候在学」。
   * 把每一段专注按真实起止时间摆在 24 小时的轴上，一眼就能看出
   * 上午空着、全挤在晚上 —— 这正是调整作息需要看到的信息。
   * ================================================================== */
  V.dayBand = function ({
    blocks = [],               // [{ from: 分钟(0-1440), to, color, title, label }]
    height = 74, nowMinutes = null, hourStep = 3
  } = {}) {
    const W = 720, H = height;
    const pl = 8, pr = 8, pt = 12, pb = 22;
    const iw = W - pl - pr;
    const x = (min) => pl + (Math.max(0, Math.min(1440, min)) / 1440) * iw;

    const parts = [];
    // 小时网格
    for (let h = 0; h <= 24; h += hourStep) {
      const gx = x(h * 60);
      parts.push(`<line x1="${d2(gx)}" y1="${pt - 5}" x2="${d2(gx)}" y2="${pt + (height - pt - pb)}" stroke="${INK.grid}" stroke-width="1"/>`);
      if (h < 24) {
        parts.push(`<text x="${d2(gx + 3)}" y="${H - 7}" font-size="9.5" fill="${INK.muted}" font-family="inherit">${h} 点</text>`);
      }
    }

    if (!blocks.length) {
      parts.push(`<text x="${W / 2}" y="${pt + (height - pt - pb) / 2 + 4}" text-anchor="middle" font-size="12" fill="${INK.muted}" font-family="inherit">今天还没有学习记录</text>`);
    } else {
      const laneH = 15, laneGap = 4;
      const lanes = [];      // 每条泳道已占用的区间，避免重叠时糊成一团
      const placed = blocks.map((b) => {
        const f = Math.max(0, Math.min(1440, b.from != null ? b.from : 0));
        const t = Math.max(f + 4, Math.min(1440, b.to != null ? b.to : f + 30));
        let lane = lanes.findIndex((occ) => occ.every((seg) => t <= seg[0] || f >= seg[1]));
        if (lane < 0) { lanes.push([]); lane = lanes.length - 1; }
        lanes[lane].push([f, t]);
        return { ...b, f, t, lane };
      });
      const baseY = pt + 4;
      placed.forEach((b, i) => {
        const bx = x(b.f);
        // 最小 4px：太短的一段也要看得见，否则「有没有学」这个信息就丢了
        const bw = Math.max(4, x(b.t) - bx);
        const by = baseY + b.lane * (laneH + laneGap);
        const c = b.color || V.seriesColor(i);
        /* 圆角半径必须同时受「高度的一半」和「宽度的一半」约束。
           只按高度算的话，一段 20 分钟的专注（约 10px 宽）会被画成一个圆点 ——
           看起来像「标记」而不是「一段时长」，语义就错了。 */
        const rx = Math.min(laneH / 2, Math.max(1.5, bw / 2));
        parts.push(`<g><title>${esc(b.title || b.label || '')}</title>
          <rect x="${d2(bx)}" y="${d2(by)}" width="${d2(bw)}" height="${laneH}" rx="${d2(rx)}" fill="${c}" opacity=".92"
            style="animation:fadeIn .4s ease both;animation-delay:${Math.min(i * 35, 350)}ms"/></g>`);
        /* 块内文字只在真的放得下时才画。
           之前阈值定成 34px 太宽松：9px 字号下 34px 只够 4 个字符，
           而「1小时18分」是 6 个字符，结果被压成「小时 18」这种读不通的碎片。
           62px 能容下最长的时长文案（如「1 小时 18 分」约 60px）。 */
        if (bw >= 62 && b.label) {
          parts.push(`<text x="${d2(bx + bw / 2)}" y="${d2(by + laneH / 2 + 3.5)}" text-anchor="middle" font-size="9" fill="#fff" font-family="inherit" style="pointer-events:none">${esc(b.label)}</text>`);
        }
      });
    }

    // 当前时刻竖线
    if (nowMinutes != null) {
      const nx = x(nowMinutes);
      parts.push(`<line x1="${d2(nx)}" y1="${pt - 5}" x2="${d2(nx)}" y2="${pt + (height - pt - pb)}" stroke="${HUE.danger}" stroke-width="1.4" opacity=".75"/>`);
      parts.push(`<circle cx="${d2(nx)}" cy="${pt - 5}" r="2.6" fill="${HUE.danger}"/>`);
    }
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block">${parts.join('')}</svg>`;
  };

  /* ================================================================== *
   * 14. 微柱条（卡片标题右侧的「一眼形状」）
   * 折线适合看「趋势」，但要一眼看出「接下来哪天重」——柱形更直接：
   * 高度就是分量，不需要读者在斜线上做插值。
   * ================================================================== */
  V.miniBars = function ({
    values = [], width = 88, height = 24, color = HUE.accent,
    highlightMax = true, unitLabel = (v) => SH.fmt.dur(v), labels = null
  } = {}) {
    if (!values.length) return '';
    const n = values.length;
    const max = Math.max(1, ...values);
    const gap = n > 12 ? 1.5 : 2.5;
    const bw = Math.max(1.5, (width - gap * (n - 1)) / n);
    const maxIdx = values.indexOf(Math.max(...values));
    const parts = values.map((v, i) => {
      const h = Math.max(v > 0 ? 2 : 1, (v / max) * (height - 2));
      const x = i * (bw + gap);
      const y = height - h;
      const c = v === 0 ? INK.track : (highlightMax && i === maxIdx ? color : color + '66');
      const label = labels && labels[i] ? labels[i] : null;
      return `<g><title>${esc(label ? `${label}：${unitLabel(v)}` : unitLabel(v))}</title>
        <rect x="${d2(x)}" y="${d2(y)}" width="${d2(bw)}" height="${d2(h)}" rx="${d2(Math.min(2, bw / 2))}" fill="${c}"/></g>`;
    }).join('');
    return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" style="display:block;flex:0 0 auto">${parts}</svg>`;
  };

  /* ================================================================== *
   * 交互挂载
   *
   * 这些图形是以 HTML 字符串产出的，没法在生成时挂 addEventListener。
   * 与其让每个调用方自己写一次 `querySelectorAll + bind`，不如提供一个统一入口：
   *
   *   SH.html(V.hbars({ items }))  → 节点
   *   V.wire(node, { onAction: (i) => ... })
   *
   * 之所以用「先渲染再挂」而不是事件委托，是因为图形经常被塞进弹窗/卡片里
   * 反复重建，委托表会跟着泄漏；一次性挂载更简单也更安全。
   * ================================================================== */
  V.wire = function (node, handlers) {
    if (!node || !handlers) return node;
    const root = node instanceof Node ? node : SH.html(String(node));
    root.querySelectorAll('[data-viz-action]').forEach((el) => {
      const idx = Number(el.dataset.vizAction);
      const fire = () => { if (handlers.onAction) handlers.onAction(idx, el); };
      el.addEventListener('click', fire);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire(); }
      });
    });
    return root;
  };

  /* ================================================================== *
   * 工具
   * ================================================================== */
  function niceStep(v, count) {
    if (!v || v <= 0) return count;
    const raw = v / count;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / p;
    const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return m * p * count;
  }
  function niceTicks(span, count) {
    const out = [];
    const step = Math.max(1, Math.ceil(span / count));
    for (let i = 0; i <= count; i++) {
      const t = i * step;
      if (t > span) break;
      out.push(t);
    }
    return out;
  }
  /** 天序号 → 'M/D' */
  function fmtShortDate(dayNum) {
    const d = new Date(dayNum * 86400000);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }
  function clip(s, n) {
    const t = String(s || '');
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }
  V.clip = clip;
})();
