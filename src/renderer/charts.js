/* charts.js —— 手写 SVG 图表
   不引任何图表库：桌面应用必须离线可用，而需要的图形就这几种。
   所有函数返回 SVG 字符串，调用方直接 innerHTML 塞进去即可。 */
(function () {
  'use strict';
  const SH = window.SH;
  const charts = (SH.charts = {});

  function esc(s) { return SH.esc(s); }

  /** 把最大值抬到一个好看的刻度（1/2/2.5/5/10 × 10^n） */
  function niceMax(v) {
    if (!v || v <= 0) return 10;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / p;
    const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return m * p;
  }

  /**
   * 把最大值抬到「能被刻度数整除」的漂亮值。
   *
   * 为什么需要这个：刻度是按 `max / count` 等分的，如果 max 不能被 count 整除，
   * 就会算出 3.3333333333333335 这种数直接印到坐标轴上。
   * 对「个数」这类必须为整数的量，还要额外保证步长是整数。
   */
  function niceMaxDivisible(v, count, integerStep) {
    const base = Math.max(niceMax(v), count);          // 至少能给每个刻度分到 1
    let step = base / count;
    if (integerStep) step = Math.max(1, Math.ceil(step));
    else {
      // 非整数场景也收敛一下（1/2/2.5/5 × 10^n），免得出现 0.333…
      const p = Math.pow(10, Math.floor(Math.log10(step)));
      const n = step / p;
      const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
      step = m * p;
    }
    return step * count;
  }

  function ticks(max, count) {
    const out = [];
    for (let i = 0; i <= count; i++) out.push((max / count) * i);
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 柱状图（近 N 天学习时长）
   * ------------------------------------------------------------------ */
  /**
   * 柱状图。
   *
   * 🔴 `unitLabel` 必须同时作用在**三处**：y 轴刻度、目标线文字、tooltip。
   * 早先只把它用在 tooltip 上，y 轴和「目标」标签仍硬编码成「分钟」格式，
   * 于是「未来 14 天复习数量」（值是**个数**）的 y 轴出现了 `0:01 / 0:01` ——
   * 把 1 个复习当成 1 分钟渲染，两个刻度还长得一模一样。
   * 这种错误断言查不出来（SVG 节点数、有无绘制全都正常），只有看图才发现。
   */
  charts.bars = function ({
    data = [],                    // [{ label, value, title?, color? }]
    height = 190,
    goal = 0,
    /** 值的显示方式。y 轴刻度 / 目标线 / tooltip 全用它，保持一致 */
    unitLabel = (v) => SH.fmt.hm(v),
    /** 目标线前缀文字。复习数这类「个数」的图不该写「目标」 */
    goalLabel = '目标',
    /**
     * y 轴刻度的显示方式。
     *
     * 🔴 必须与 unitLabel 分开：unitLabel 的文案是给 tooltip 读的（「1 小时 40 分」），
     * 而轴刻度空间很窄（左边距 52px），同样长度的文案会被裁成「节 20 分」——
     * 既看不懂又显得产品很糙。轴上一律用紧凑格式（1:40）。
     * 这与之前那个「单位只作用在 tooltip 上」的坑是同一类问题的另一面。
     */
    axisLabel = (v) => SH.fmt.hm(v),
    /** 纵轴是否必须是整数（「个数」类图表要开；「时长」类不能开） */
    integerAxis = false,
    highlightLast = true,
    barColor = '#3b5bfd',
    barColorMuted = '#c7d2fe',
    labelEvery = 1
  } = {}) {
    const W = 720, H = height;
    const pl = 52, pr = 14, pt = 16, pb = 28;
    const iw = W - pl - pr, ih = H - pt - pb;
    const values = data.map((d) => d.value || 0);
    const TICK_COUNT = 3;
    const max = Math.max(
      niceMaxDivisible(Math.max(...values, 0), TICK_COUNT, integerAxis),
      goal || 0,
      1
    );
    const n = Math.max(1, data.length);
    const step = iw / n;
    const bw = Math.min(30, Math.max(3, step * 0.62));

    const parts = [];
    // 网格与 y 轴刻度
    for (const t of ticks(max, TICK_COUNT)) {
      const y = pt + ih - (t / max) * ih;
      parts.push(`<line x1="${pl}" y1="${y.toFixed(1)}" x2="${W - pr}" y2="${y.toFixed(1)}" stroke="#eef1f6" stroke-width="1"/>`);
      parts.push(`<text x="${pl - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="10.5" fill="#8b96ab" font-family="inherit">${esc(String(axisLabel(t)))}</text>`);
    }
    // 目标线
    if (goal > 0 && goal <= max) {
      const y = pt + ih - (goal / max) * ih;
      parts.push(`<line x1="${pl}" y1="${y.toFixed(1)}" x2="${W - pr}" y2="${y.toFixed(1)}" stroke="#f59e0b" stroke-width="1.4" stroke-dasharray="5 4" opacity=".85"/>`);
      parts.push(`<text x="${W - pr}" y="${(y - 5).toFixed(1)}" text-anchor="end" font-size="10" fill="#d97706" font-family="inherit">${esc(goalLabel)} ${esc(String(axisLabel(goal)))}</text>`);
    }
    // 柱子
    data.forEach((d, i) => {
      const v = d.value || 0;
      const x = pl + i * step + (step - bw) / 2;
      const bh = Math.max(v > 0 ? 2.5 : 0, (v / max) * ih);
      const y = pt + ih - bh;
      const isLast = highlightLast && i === data.length - 1;
      const fill = d.color || (v === 0 ? '#e8ecf4' : (isLast ? '#3b5bfd' : barColorMuted));
      const tip = d.title || `${d.label}：${unitLabel(v)}`;
      parts.push(
        `<g><title>${esc(tip)}</title>` +
        (v === 0
          ? `<rect x="${x.toFixed(1)}" y="${(pt + ih - 2).toFixed(1)}" width="${bw.toFixed(1)}" height="2" rx="1" fill="#e8ecf4"/>`
          : `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="${Math.min(5, bw / 2).toFixed(1)}" fill="${fill}"/>`) +
        `</g>`
      );
      const showLabel = labelEvery <= 1 || i % labelEvery === 0 || i === data.length - 1;
      if (showLabel) {
        parts.push(`<text x="${(pl + i * step + step / 2).toFixed(1)}" y="${H - 9}" text-anchor="middle" font-size="10" fill="#8b96ab" font-family="inherit">${esc(d.label)}</text>`);
      }
    });

    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg>`;
  };

  /* ------------------------------------------------------------------ *
   * 面积折线图（趋势）
   * ------------------------------------------------------------------ */
  charts.area = function ({
    data = [],                   // [{ label, value, title? }]
    height = 190,
    color = '#3b5bfd',
    fillFrom = 'rgba(59,91,253,.22)',
    fillTo = 'rgba(59,91,253,0)',
    unitLabel = (v) => SH.fmt.hm(v),
    goal = 0,
    labelEvery = 1,
    smooth = true
  } = {}) {
    const W = 720, H = height;
    const pl = 46, pr = 14, pt = 16, pb = 28;
    const iw = W - pl - pr, ih = H - pt - pb;
    const values = data.map((d) => d.value || 0);
    const max = Math.max(niceMax(Math.max(...values, 0)), goal || 0, 1);
    const n = Math.max(1, data.length - 1);
    const X = (i) => pl + (data.length <= 1 ? iw / 2 : (i / n) * iw);
    const Y = (v) => pt + ih - (v / max) * ih;

    const parts = [];
    for (const t of ticks(max, 3)) {
      const y = Y(t);
      parts.push(`<line x1="${pl}" y1="${y.toFixed(1)}" x2="${W - pr}" y2="${y.toFixed(1)}" stroke="#eef1f6"/>`);
      parts.push(`<text x="${pl - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="10.5" fill="#8b96ab" font-family="inherit">${SH.fmt.hm(t)}</text>`);
    }
    if (goal > 0 && goal <= max) {
      const y = Y(goal);
      parts.push(`<line x1="${pl}" y1="${y.toFixed(1)}" x2="${W - pr}" y2="${y.toFixed(1)}" stroke="#f59e0b" stroke-width="1.3" stroke-dasharray="5 4" opacity=".8"/>`);
    }

    // 路径点
    const pts = data.map((d, i) => [X(i), Y(d.value || 0)]);
    let line = '';
    if (pts.length) {
      if (smooth && pts.length > 2) {
        line = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
        for (let i = 0; i < pts.length - 1; i++) {
          const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
          const cx = (x0 + x1) / 2;
          line += ` C ${cx.toFixed(1)} ${y0.toFixed(1)}, ${cx.toFixed(1)} ${y1.toFixed(1)}, ${x1.toFixed(1)} ${y1.toFixed(1)}`;
        }
      } else {
        line = pts.map((p, i) => `${i ? 'L' : 'M'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
      }
      const area = `${line} L ${pts[pts.length - 1][0].toFixed(1)} ${(pt + ih).toFixed(1)} L ${pts[0][0].toFixed(1)} ${(pt + ih).toFixed(1)} Z`;
      const gid = 'g' + Math.random().toString(36).slice(2, 8);
      parts.push(`<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${fillFrom}"/><stop offset="100%" stop-color="${fillTo}"/>
      </linearGradient></defs>`);
      parts.push(`<path d="${area}" fill="url(#${gid})"/>`);
      parts.push(`<path d="${line}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`);
    }

    data.forEach((d, i) => {
      const [x, y] = pts[i] || [0, 0];
      parts.push(`<g><title>${esc(d.title || `${d.label}：${unitLabel(d.value || 0)}`)}</title>
        <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7" fill="transparent"/>
        <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" fill="#fff" stroke="${color}" stroke-width="2"/></g>`);
      const showLabel = labelEvery <= 1 || i % labelEvery === 0 || i === data.length - 1;
      if (showLabel) {
        parts.push(`<text x="${x.toFixed(1)}" y="${H - 9}" text-anchor="middle" font-size="10" fill="#8b96ab" font-family="inherit">${esc(d.label)}</text>`);
      }
    });

    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg>`;
  };

  /* ------------------------------------------------------------------ *
   * 环形图（科目占比）
   * ------------------------------------------------------------------ */
  charts.donut = function ({ items = [], size = 168, thickness = 20, centerTop = '', centerSub = '' } = {}) {
    const total = items.reduce((a, b) => a + (b.value || 0), 0);
    const r = (size - thickness) / 2 - 2;
    const c = size / 2;
    const circ = 2 * Math.PI * r;

    if (!total) {
      return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
        <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="#eef1f6" stroke-width="${thickness}"/>
        <text x="${c}" y="${c + 4}" text-anchor="middle" font-size="12" fill="#8b96ab" font-family="inherit">暂无数据</text>
      </svg>`;
    }

    let offset = 0;
    const arcs = items.map((it) => {
      const frac = (it.value || 0) / total;
      const len = frac * circ;
      const seg = `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${it.color || '#3b5bfd'}"
        stroke-width="${thickness}" stroke-dasharray="${len.toFixed(2)} ${(circ - len).toFixed(2)}"
        stroke-dashoffset="${(-offset).toFixed(2)}" stroke-linecap="butt"
        transform="rotate(-90 ${c} ${c})"><title>${esc(it.label)}：${SH.fmt.dur(it.value)}（${Math.round(frac * 100)}%）</title></circle>`;
      offset += len;
      return seg;
    }).join('');

    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" style="flex:0 0 auto">
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="#f3f5fa" stroke-width="${thickness}"/>
      ${arcs}
      ${centerTop ? `<text x="${c}" y="${c - 2}" text-anchor="middle" font-size="20" font-weight="650" fill="#16203a" font-family="inherit">${esc(centerTop)}</text>` : ''}
      ${centerSub ? `<text x="${c}" y="${c + 15}" text-anchor="middle" font-size="11" fill="#8b96ab" font-family="inherit">${esc(centerSub)}</text>` : ''}
    </svg>`;
  };

  /* ------------------------------------------------------------------ *
   * 迷你环（侧边栏计时 / 进度）
   * ------------------------------------------------------------------ */
  charts.ring = function ({ ratio = 0, size = 40, thickness = 4, color = '#3b5bfd', track = '#e4e8f0' }) {
    const r = (size - thickness) / 2;
    const c = size / 2;
    const circ = 2 * Math.PI * r;
    const len = Math.max(0, Math.min(1, ratio)) * circ;
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${track}" stroke-width="${thickness}"/>
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${color}" stroke-width="${thickness}"
        stroke-linecap="round" stroke-dasharray="${len.toFixed(2)} ${(circ - len).toFixed(2)}"
        transform="rotate(-90 ${c} ${c})"/>
    </svg>`;
  };

  /* ------------------------------------------------------------------ *
   * 时段分布（0-23 点，横向热力条）
   * ------------------------------------------------------------------ */
  charts.hourStrip = function ({ buckets = [], height = 78 } = {}) {
    const W = 720, H = height;
    const pl = 10, pr = 10, pt = 14, pb = 20;
    const iw = W - pl - pr, ih = H - pt - pb;
    const max = Math.max(1, ...buckets);
    const step = iw / 24;
    const parts = [];
    buckets.forEach((v, i) => {
      const bh = Math.max(v > 0 ? 3 : 1.5, (v / max) * ih);
      const x = pl + i * step + step * 0.14;
      const w = step * 0.72;
      const y = pt + ih - bh;
      const alpha = v > 0 ? 0.28 + 0.72 * (v / max) : 0;
      const fill = v > 0 ? `rgba(59,91,253,${alpha.toFixed(2)})` : '#eef1f6';
      parts.push(`<g><title>${i}:00 - ${i}:59 · ${SH.fmt.dur(v)}</title>
        <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${bh.toFixed(1)}" rx="2.5" fill="${fill}"/></g>`);
      if (i % 3 === 0) {
        parts.push(`<text x="${(pl + i * step + step / 2).toFixed(1)}" y="${H - 5}" text-anchor="middle" font-size="10" fill="#8b96ab" font-family="inherit">${i}点</text>`);
      }
    });
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block">${parts.join('')}</svg>`;
  };

  /* ------------------------------------------------------------------ *
   * 打卡热力图（按周分列，列优先排布）
   * ------------------------------------------------------------------ */
  charts.heatHTML = function ({ days = [], weekStart = 1 } = {}) {
    if (!days.length) return '';
    const parse = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
    const pad = (parse(days[0].date).getDay() - weekStart + 7) % 7;
    const cells = new Array(pad).fill(null).concat(days);
    const cols = [];
    for (let i = 0; i < cells.length; i += 7) cols.push(cells.slice(i, i + 7));

    const wd = ['日', '一', '二', '三', '四', '五', '六'];
    const colHtml = cols.map((col) => {
      const cellsHtml = col.map((c) => {
        if (!c) return '<i></i>';
        const d = parse(c.date);
        const tip = `${c.date} 周${wd[d.getDay()]} · ${c.minutes ? SH.fmt.dur(c.minutes) : '未学习'}`;
        return `<i class="l${c.level}" title="${tip}"></i>`;
      }).join('');
      return `<div class="col">${cellsHtml}</div>`;
    }).join('');

    return `<div class="heat">${colHtml}</div>
      <div class="row" style="margin-top:9px">
        <span class="small muted">近 ${days.length} 天，每格一天</span>
        <span style="flex:1"></span>
        <span class="small muted" style="margin-right:2px">少</span>
        <span class="heat-swatch l1"></span><span class="heat-swatch l2"></span>
        <span class="heat-swatch l3"></span><span class="heat-swatch l4"></span>
        <span class="small muted" style="margin-left:2px">多</span>
      </div>`;
  };

  /* ------------------------------------------------------------------ *
   * 火花线（卡片内嵌小趋势）
   * ------------------------------------------------------------------ */
  charts.spark = function ({ values = [], width = 120, height = 30, color = '#3b5bfd' } = {}) {
    if (!values.length) return '';
    const max = Math.max(1, ...values);
    const n = Math.max(1, values.length - 1);
    const pts = values.map((v, i) => [(i / n) * (width - 2) + 1, height - 2 - (v / max) * (height - 4)]);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
    return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
      <path d="${d}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${pts[pts.length - 1][0].toFixed(1)}" cy="${pts[pts.length - 1][1].toFixed(1)}" r="2.2" fill="${color}"/>
    </svg>`;
  };
})();
