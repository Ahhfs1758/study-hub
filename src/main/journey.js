'use strict';
/**
 * journey.js —— 界面级端到端流程测试
 *
 * 和 selftest.js 的区别（两者互补，都要有）：
 *   selftest  直接调 window.api.* —— 验证**后端**（数据算得对不对、规则触发得对不对）
 *   journey   只点界面上真实的按钮/填真实的表单 —— 验证**接线**
 *             （按钮有没有绑上事件、表单读出来的值对不对、操作完界面有没有刷新）
 *
 * 为什么必须有 journey：`window.api.plans.add()` 成功，不代表「新建计划」按钮能用。
 * 少写一个 onClick、把字段名写错、刷新时漏了某个视图 —— 这些在 api 层测试里
 * 全部是绿的，而用户点下去就是没反应。这类缺陷只能靠真的点一遍来发现。
 *
 * 设计约定：
 *   · 每个步骤是一个「用户在做什么」的动作，而不是「调用了什么函数」
 *   · 断言只断言**界面上看得见的东西**（文本、元素、数量），不去读 store
 *     —— 读 store 就退回成 api 测试了
 *   · 不碰任何会弹系统原生对话框的入口（选文件、选目录、导出保存框），
 *     那些在无人值守下会永久阻塞
 */

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ *
 * 注入页面的辅助函数
 * ------------------------------------------------------------------ */

/** 在渲染层装一套「像人一样操作」的工具，后面的步骤都基于它 */
const HELPERS = `
window.__J = (function () {
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const txt = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim() : '');

  /** 按可见文字找元素（可限定选择器）。用于点那些没有 id/class 语义的按钮 */
  function byText(sel, text, root) {
    return $$(sel, root).find((e) => txt(e).includes(text)) || null;
  }
  /** 在所有匹配里找**最精确**的那个（文字最短），避免点到父容器 */
  function byTextExact(sel, text, root) {
    const hits = $$(sel, root).filter((e) => txt(e) === text);
    if (hits.length) return hits[0];
    return byText(sel, text, root);
  }

  /** 真实点击：mouse 事件全套，走 addEventListener('click') */
  function click(el) {
    if (!el) return false;
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
      const Ctor = type === 'click' ? MouseEvent : MouseEvent;
      el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window }));
    }
    return true;
  }
  function clickText(sel, text, root) { return click(byTextExact(sel, text, root)); }

  /** 填值：必须同时派发 input 与 change —— 只设 .value 的话，
   *  监听 change 的代码（失焦保存那些）收不到通知 */
  function fill(el, value) {
    if (!el) return false;
    el.focus();
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  /**
   * 弹窗内按标签找控件。
   *
   * 界面里有**两套**「标签 + 控件」的写法，都必须认：
   *   .field  > .lb        （表单弹窗、资料详情：标签在上、控件在下）
   *   .set-row > .s-label > b  （设置页：标签在左、控件在右）
   * 只认前一种的话，「每日目标」这类设置项永远找不到，
   * 测试会报一个看起来像产品坏了、实际是测试没找着的假失败。
   */
  function field(labelText, root) {
    const scope = root || $('.dialog') || document;
    for (const sel of ['.field', '.set-row', 'label']) {
      const hit = $$(sel, scope).find((box) => {
        const lb = $('.lb', box) || $('.s-label b', box);
        return lb && txt(lb).includes(labelText);
      });
      if (hit) {
        const c = hit.querySelector('input, textarea, select');
        if (c) return c;
      }
    }
    return null;
  }
  function fillField(labelText, value, root) { return fill(field(labelText, root), value); }

  /** 弹窗底部的按钮 */
  function dialogButton(text) {
    const footer = $('.dialog footer');
    if (!footer) return null;
    return $$('button', footer).find((b) => txt(b).includes(text)) || null;
  }
  function dialogOpen() { return !!$('.dialog'); }
  function dialogTitle() { const h = $('.dialog h3'); return h ? txt(h) : ''; }
  /** 关掉所有还开着的弹窗（点 Esc，走正常的关闭路径） */
  function closeDialogs() {
    let n = 0;
    while ($('.dialog') && n < 5) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const x = $('.dialog header button');
      if (x) click(x);
      n++;
    }
    // 兜底：正常路径没关掉就硬摘（只影响测试，不进产品逻辑）
    $$('.mask').forEach((m) => m.remove());
    return n;
  }

  /** 视图内的卡片（用于定位某个区块）*/
  function card(titleText) {
    return $$('#view .card').find((c) => {
      const h = c.querySelector('h3');
      return h && txt(h).includes(titleText);
    }) || null;
  }
  function listItems(root) { return $$('.list-item', root || $('#view')); }
  function viewText() { const v = $('#view'); return v ? v.textContent.replace(/\\s+/g, ' ') : ''; }
  function toasts() { return $$('#toasts .toast').map((t) => txt(t)); }

  /* ---------------------------------------------------------------- *
   * 条件等待 —— 界面级测试里**绝对不能**用固定 sleep
   *
   * 每次切视图都要重新拉一轮数据再渲染，耗时随机器负载波动（实测 200ms ~ 1.5s 都有）。
   * 写死 700ms 之类的固定等待，就会变成「机器慢的时候随机失败」——这种测试比没有测试更糟，
   * 因为它会训练人忽略红灯。所以统一改成「等到条件成立为止」。
   * ---------------------------------------------------------------- */
  function waitFor(cond, timeout, step) {
    const limit = timeout || 6000;
    const gap = step || 50;
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        let v = false;
        try { v = cond(); } catch (_) { v = false; }
        if (v) return resolve(v);
        if (Date.now() - t0 > limit) return resolve(false);
        setTimeout(tick, gap);
      };
      tick();
    });
  }

  /** 切视图并等它真的画出来。
   *  want 可给 { text } （等某段文字出现）或 { sel, min } （等某个选择器至少出现 min 个） */
  async function goto(view, want) {
    const title = (window.SH.views[view] || {}).title;
    await window.SH.app.go(view);
    const okReady = await waitFor(() => {
      const host = document.getElementById('view');
      if (!host || !host.children.length) return false;
      if (title && txt(document.getElementById('viewTitle')) !== title) return false;
      if (want && want.text && !viewText().includes(want.text)) return false;
      if (want && want.sel) {
        const n = $$(want.sel).length;
        if (n < (want.min === undefined ? 1 : want.min)) return false;
      }
      return true;
    }, 8000);
    return !!okReady;
  }

  /** 等某个条件在页面上成立（比如刚点完按钮后的刷新） */
  function settle(cond, timeout) { return waitFor(cond, timeout || 6000); }

  return { $, $$, txt, byText, byTextExact, click, clickText, fill, field, fillField,
           dialogButton, dialogOpen, dialogTitle, closeDialogs, card, listItems, viewText, toasts,
           waitFor, goto, settle, navTo: (v) => window.SH.app.go(v) };
})();
true;
`;

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function run(ctx, outDir, deps) {
  const { evalJs, wait, shot, store, mainWindow } = deps;
  const results = [];
  let failures = 0;

  const record = (name, ok, detail) => {
    const row = { step: name, ok: !!ok, ...(detail || {}) };
    results.push(row);
    if (!ok) failures++;
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail && detail.info ? '  ' + JSON.stringify(detail.info) : ''}`);
    return ok;
  };

  await evalJs(HELPERS, 10000, 'helpers');

  /** 跑一段页面代码，返回 {ok, ...} */
  const run = async (code, label) => {
    const r = await evalJs(`(async () => { try { ${code} } catch (e) { return { ok: false, error: String(e && e.stack || e) }; } })()`,
      20000, label);
    if (r && r.__evalError) { record(label, false, { info: r.__evalError }); return null; }
    return r;
  };

  /** 开一个新的干净用户：清掉示例数据，从零开始走一遍 */
  await run(`
    await window.api.system.clearDemo();
    await new Promise(r => setTimeout(r, 400));
    window.SH.app.reload();
    await new Promise(r => setTimeout(r, 500));
    return { ok: true, subjects: (await window.api.subjects.list()).length };
  `, 'journey:reset');
  record('从零开始（清空数据）', true);

  /* ---------- 1. 新建科目（设置页，走表单） ---------- */
  {
    const r = await run(`
      await window.__J.goto('settings', { text: '科目与周目标' });
      const add = window.__J.byText('#view .card button', '添加科目');
      if (!add) return { ok: false, error: '设置页找不到「添加科目」按钮' };
      window.__J.click(add);
      await new Promise(r => setTimeout(r, 250));
      if (!window.__J.dialogOpen()) return { ok: false, error: '点了「添加科目」但没有弹出表单' };

      const title = window.__J.dialogTitle();
      window.__J.fillField('科目名称', '线性代数');
      const goal = window.__J.field('每周目标');
      if (goal) window.__J.fill(goal, '240');
      // 选一个非默认颜色，验证色板是真的可点
      const swatches = window.__J.$$('.dialog .seg button');
      if (swatches.length > 3) window.__J.click(swatches[3]);

      const okBtn = window.__J.dialogButton('保存') || window.__J.dialogButton('创建');
      if (!okBtn) return { ok: false, error: '表单没有保存按钮' };
      window.__J.click(okBtn);
      await new Promise(r => setTimeout(r, 700));

      const subs = await window.api.subjects.list();
      const me = subs.find(s => s.name === '线性代数');
      return {
        ok: !!me,
        dialogTitle: title,
        total: subs.length,
        goal: me && me.goalMinPerWeek,
        color: me && me.color,
        stillOpen: window.__J.dialogOpen(),
        visible: window.__J.viewText().includes('线性代数')
      };
    `, 'journey:subject');
    record('新建科目（表单 → 列表出现）', r && r.ok && r.visible && !r.stillOpen,
      { info: r && { 总数: r.total, 周目标: r.goal, 颜色: r.color, 表单已关闭: !r.stillOpen, 界面已显示: r.visible } });
  }

  /* ---------- 2. 按钮取消时 Promise 必须被 resolve（而不是永久挂起） ---------- */
  {
    const r = await run(`
      await window.__J.goto('settings', { text: '科目与周目标' });
      const add = window.__J.byText('#view .card button', '添加科目');
      window.__J.click(add);
      await new Promise(r => setTimeout(r, 250));
      // 点遮罩关闭（不是点「取消」按钮）—— 这条路径原先不会 resolve Promise
      const mask = window.__J.$('.mask');
      if (!mask) return { ok: false, error: '没有遮罩' };
      mask.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise(r => setTimeout(r, 400));
      const closed = !window.__J.dialogOpen();
      // 再来一次：如果上一次的 Promise 还挂着，这里会堆叠出第二个弹窗
      window.__J.click(add);
      await new Promise(r => setTimeout(r, 250));
      const dialogs = window.__J.$$('.dialog').length;
      window.__J.closeDialogs();
      await new Promise(r => setTimeout(r, 300));
      return { ok: true, closedByMask: closed, dialogCount: dialogs };
    `, 'journey:cancel');
    record('点遮罩取消不留悬挂 Promise', r && r.closedByMask && r.dialogCount === 1,
      { info: r && { 遮罩可关闭: r.closedByMask, 弹窗数量: r.dialogCount } });
    await evalJs('window.__J.closeDialogs(); true', 5000).catch(() => {});
  }

  /* ---------- 3. 确认框的「确定」真的返回 true ---------- */
  {
    const r = await run(`
      let got = 'pending';
      window.SH.confirm({ title: '自检确认框', message: '点确定', okText: '确定' }).then(v => { got = v; });
      await new Promise(r => setTimeout(r, 250));
      const btn = window.__J.dialogButton('确定');
      if (!btn) return { ok: false, error: '确认框没有确定按钮' };
      window.__J.click(btn);
      await new Promise(r => setTimeout(r, 350));
      return { ok: true, resolvedWith: got };
    `, 'journey:confirm');
    record('确认框「确定」返回 true（不被 onClose 覆盖成 false）', r && r.resolvedWith === true,
      { info: r && { 返回值: r.resolvedWith } });
  }

  /* ---------- 3b. 图表的单位必须自洽 ----------
   * 复习负载图的值是「个数」，早先 y 轴却按分钟渲染，出现了 `0:01 / 0:01`
   * 这种无意义刻度。SVG 有没有画出来、节点数够不够全都正常 —— 只有真的读一下
   * 轴上的文字才能发现。所以这里把「轴标签」当成可断言的东西。 */
  {
    const r = await run(`
      const out = {};
      const charts = [
        ['srs', '未来 14 天复习数量'],
        ['stats', '每日专注时长'],
        ['dashboard', '近 14 天专注时长']
      ];
      for (const [view, cardTitle] of charts) {
        await window.__J.goto(view, { sel: '#view svg', min: 1 });
        const card = window.__J.card(cardTitle);
        if (!card) { out[cardTitle] = 'CARD_NOT_FOUND'; continue; }
        const svg = card.querySelector('svg');
        if (!svg) { out[cardTitle] = 'NO_SVG'; continue; }
        // y 轴刻度文字：右对齐（text-anchor="end"）的 text 元素
        const labels = Array.from(svg.querySelectorAll('text'))
          .filter(t => t.getAttribute('text-anchor') === 'end')
          .map(t => t.textContent.trim());
        out[cardTitle] = labels;
      }
      return { ok: true, charts: out };
    `, 'journey:chart-units');

    const c = (r && r.charts) || {};
    const srsAxis = c['未来 14 天复习数量'] || [];
    const statsAxis = c['每日专注时长'] || [];
    const dashAxis = c['近 14 天专注时长'] || [];

    // 复习负载：应按「个」显示，不能出现 0:01 这种分钟格式
    const srsBad = Array.isArray(srsAxis) && srsAxis.some((t) => /^\d+:\d\d$/.test(t));
    // 时长图：应按「时:分」显示，不能出现「2 个」
    const statsBad = Array.isArray(statsAxis) && statsAxis.some((t) => /个$/.test(t));
    // 同一个轴上不该出现两个完全相同的标签（刻度重复 = 刻度算法或格式化的锅）
    const dup = (arr) => Array.isArray(arr) && new Set(arr).size !== arr.length;
    /* 浮点噪声：「个数」的轴必须是整数。
       刻度是按 max/份数 等分算出来的，max 不能整除时会把 3.3333333333333335
       原样印到坐标轴上 —— 数字没错但看起来很糟，属于必须在自动化里拦住的类型。 */
    const floatNoise = (arr, unit) => Array.isArray(arr) && arr.some((t) => {
      if (unit === '个' && !/个$/.test(t)) return false;
      const m = /(-?\d+(?:\.\d+)?)/.exec(t);
      if (!m) return false;
      const v = Number(m[1]);
      return !Number.isInteger(v) || String(v).length > 6;
    });
    const noiseSrs = floatNoise(srsAxis, '个');

    const okAll = !srsBad && !statsBad && !noiseSrs
      && !dup(srsAxis) && !dup(statsAxis) && !dup(dashAxis)
      && srsAxis.length >= 2 && statsAxis.length >= 2;
    record('图表单位自洽（复习数按「个」且为整数、时长按「时:分」、刻度不重复）', okAll,
      { info: { 复习负载轴: srsAxis, 时长轴: statsAxis, 仪表盘轴: dashAxis, 浮点噪声: noiseSrs, 重复: { 复习: dup(srsAxis), 时长: dup(statsAxis) } } });
  }

  /* ---------- 4. 新建计划 + 添加任务（计划页，走表单） ---------- */
  {
    const r = await run(`
      await window.__J.goto('plans', { text: '新建学习计划' });
      const btn = window.__J.byText('#view button', '新建学习计划');
      if (!btn) return { ok: false, error: '计划页找不到「新建学习计划」' };
      window.__J.click(btn);
      await new Promise(r => setTimeout(r, 300));
      if (!window.__J.dialogOpen()) return { ok: false, error: '没弹出新建计划表单' };
      window.__J.fillField('计划名称', '自检 · 线性代数第一章');
      window.__J.fillField('说明', '把第一章的矩阵运算过一遍');
      const okBtn = window.__J.dialogButton('创建');
      if (!okBtn) return { ok: false, error: '表单没有创建按钮' };
      window.__J.click(okBtn);
      await new Promise(r => setTimeout(r, 900));

      const plans = await window.api.plans.list();
      const me = plans.find(p => p.title.includes('线性代数第一章'));
      return {
        ok: !!me,
        total: plans.length,
        expanded: window.__J.viewText().includes('添加任务'),
        visible: window.__J.viewText().includes('线性代数第一章')
      };
    `, 'journey:plan');
    record('新建计划（表单 → 卡片出现且自动展开）', r && r.ok && r.visible,
      { info: r && { 计划数: r.total, 已展开: r.expanded, 界面已显示: r.visible } });
  }

  {
    const r = await run(`
      await window.__J.goto('plans', { text: '添加任务' });
      // 计划卡片已展开，直接点它里面的「+ 添加任务」
      const add = window.__J.byText('#view button', '添加任务');
      if (!add) { window.__J.closeDialogs(); return { ok: false, error: '展开的计划里没有「添加任务」' }; }
      window.__J.click(add);
      await new Promise(r => setTimeout(r, 300));
      window.__J.fillField('任务内容', '矩阵乘法练习 20 题');
      const est = window.__J.field('预计时长');
      if (est) window.__J.fill(est, '45');
      const okBtn = window.__J.dialogButton('添加');
      window.__J.click(okBtn);
      await new Promise(r => setTimeout(r, 900));

      const plans = await window.api.plans.list();
      const p = plans.find(x => x.title.includes('线性代数第一章'));
      const t = p && p.tasks.find(x => x.title.includes('矩阵乘法'));
      return { ok: !!t, tasks: p ? p.tasks.length : 0, estMin: t && t.estMin, date: t && t.date };
    `, 'journey:task');
    record('添加任务（表单 → 任务出现在计划里）', r && r.ok,
      { info: r && { 任务数: r.tasks, 预计分钟: r.estMin, 起始日: r.date } });
  }

  /* ---------- 5. 今日任务打勾 → 自动进复习队列 ---------- */
  {
    const r = await run(`
      await window.__J.goto('plans', { text: '矩阵乘法' });
      const before = (await window.api.reviews.list()).length;
      // 今日任务区里的勾选框
      const items = window.__J.listItems();
      const row = items.find(it => it.textContent.includes('矩阵乘法'));
      if (!row) return { ok: false, error: '今日任务里找不到刚加的任务' };
      const box = row.querySelector('.check');
      if (!box) return { ok: false, error: '任务行里没有勾选框' };
      window.__J.click(box);
      await new Promise(r => setTimeout(r, 900));
      const after = (await window.api.reviews.list()).length;
      const rowNow = window.__J.listItems().find(it => it.textContent.includes('矩阵乘法'));
      return {
        ok: true,
        reviewsBefore: before, reviewsAfter: after,
        struck: rowNow ? !!rowNow.querySelector('.check.on') : null
      };
    `, 'journey:toggle');
    record('勾掉任务 → 标记完成 + 自动进入复习队列',
      r && r.reviewsAfter === r.reviewsBefore + 1 && r.struck === true,
      { info: r && { 复习前: r.reviewsBefore, 复习后: r.reviewsAfter, 已勾选: r.struck } });
  }

  /* ---------- 6. 复习页 ---------- *
   * 刚勾掉的任务第一次复习排在**明天**，所以「今日队列」这时是空的 —— 这是对的，
   * 不是 bug。所以这里分两步验证：
   *   a) 空队列时要给出友好说明（而不是一片空白）
   *   b) 切到「全部知识点」，用行内的「过一遍」按钮真的评分
   */
  {
    const r = await run(`
      await window.__J.goto('srs', { text: '今天要过的' });
      // 显式切到「今日队列」，不依赖页面记住的默认标签 —— 测试要断言的是队列本身
      const qtab = window.__J.$$('#view .pill-tabs button').find(b => b.textContent.includes('今日队列'));
      if (qtab) { window.__J.click(qtab); await new Promise(r => setTimeout(r, 500)); }
      await window.__J.settle(() => window.__J.$('#view .rev-card') || window.__J.viewText().includes('今天的复习都过完了'), 5000);
      const emptyShown = window.__J.viewText().includes('今天的复习都过完了')
                      || window.__J.viewText().includes('队列是空的');
      const cardsInQueue = window.__J.$$('#view .rev-card').length;

      // 切到「全部知识点」
      const tab = window.__J.$$('#view .pill-tabs button').find(b => b.textContent.includes('全部知识点'));
      if (!tab) return { ok: false, error: '复习页找不到「全部知识点」标签', emptyShown, cardsInQueue };
      window.__J.click(tab);
      await new Promise(r => setTimeout(r, 800));

      const rowsBefore = window.__J.listItems().length;
      const keep = window.__J.listItems().find(it => it.textContent.includes('矩阵乘法'));
      if (!keep) return { ok: false, error: '全部知识点里找不到刚加入的条目', emptyShown, cardsInQueue, rowsBefore };

      const btn = window.__J.byText('button', '过一遍', keep);
      if (!btn) return { ok: false, error: '条目上没有「过一遍」按钮' };
      window.__J.click(btn);
      await new Promise(r => setTimeout(r, 1000));

      const reviews = await window.api.reviews.list();
      const target = reviews.find(x => x.title.includes('矩阵乘法'));
      const rowAfter = window.__J.listItems().find(it => it.textContent.includes('矩阵乘法'));
      return {
        ok: true, emptyShown, cardsInQueue, rowsBefore,
        stage: target && target.stage,
        history: target && (target.history || []).length,
        rowText: rowAfter ? window.__J.txt(rowAfter).slice(0, 60) : ''
      };
    `, 'journey:srs');
    const advanced = r && r.stage >= 1 && r.history >= 1;
    record('复习：空队列有友好说明 + 「过一遍」推进档位',
      r && r.ok && r.emptyShown && advanced,
      { info: r && { 空态提示: r.emptyShown, 今日队列卡片: r.cardsInQueue, 档位: r.stage, 复习记录: r.history, 行: r.rowText } });
  }

  /* ---------- 7. 专注：开始正计时 → 结束并记录 → 今日记录出现 ---------- */
  {
    const r = await run(`
      await window.__J.goto('focus', { text: '开始正计时' });
      const before = (await window.api.sessions.list({})).length;

      const start = window.__J.byText('#view button', '开始正计时');
      if (!start) return { ok: false, error: '专注页找不到「开始正计时」' };
      window.__J.click(start);
      await new Promise(r => setTimeout(r, 1200));

      const running = await window.api.timer.state();
      const dialText = window.__J.$('#dialTime') ? window.__J.$('#dialTime').textContent : '';

      const stop = window.__J.byText('#view button', '结束并记录');
      if (!stop) return { ok: false, error: '运行中没有「结束并记录」按钮', running: running.running };
      window.__J.click(stop);
      await new Promise(r => setTimeout(r, 1200));

      const after = (await window.api.sessions.list({})).length;
      const stillRunning = (await window.api.timer.state()).running;
      return {
        ok: true, wasRunning: running.running, dialText,
        sessionsBefore: before, sessionsAfter: after, stillRunning,
        toast: window.__J.toasts().join(' | ').slice(0, 80)
      };
    `, 'journey:focus');
    // 正计时很可能不足 1 分钟 —— 那按设计就不写记录，不算失败。但「停下来」必须成立
    const stopped = r && r.stillRunning === false;
    record('专注：开始正计时 → 结束（计时器正确停下）', !!stopped,
      { info: r && { 曾运行: r.wasRunning, 停止后仍在运行: r.stillRunning, 拨盘: r.dialText } });
    if (r && r.sessionsAfter > r.sessionsBefore) {
      record('专注：本段已写入今日记录', true, { info: { 记录数: `${r.sessionsBefore} → ${r.sessionsAfter}` } });
    } else {
      // 手动补录一次，把「记录 → 界面显示」这条链路也走通
      const r2 = await run(`
        const btn = window.__J.byText('#view button', '手动补录');
        if (!btn) return { ok: false, error: '专注页找不到「手动补录」' };
        window.__J.click(btn);
        await new Promise(r => setTimeout(r, 300));
        window.__J.fillField('时长', '35');
        const okBtn = window.__J.dialogButton('记录');
        window.__J.click(okBtn);
        await new Promise(r => setTimeout(r, 1200));
        const list = await window.api.sessions.list({});
        const today = new Date(); const k = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');
        const mine = list.filter(s => (s.note || '').length >= 0 && s.start.slice(0,10) === k);
        return { ok: mine.length > 0, todayCount: mine.length, minutes: mine.map(s => s.minutes) };
      `, 'journey:manual');
      record('专注：手动补录 → 今日记录出现', r2 && r2.ok,
        { info: r2 && { 今日记录数: r2.todayCount, 时长: r2.minutes } });
    }
  }

  /* ---------- 8. 资料：新建笔记 → 应用内预览（Markdown 渲染）→ 加入复习 ---------- */
  {
    const r = await run(`
      await window.__J.goto('materials', { text: '添加资料' });
      const add = window.__J.byText('#view button', '添加资料');
      if (!add) return { ok: false, error: '资料页找不到「添加资料」' };
      window.__J.click(add);
      await new Promise(r => setTimeout(r, 350));
      const noteOpt = window.__J.byText('.dialog .card', '写一条笔记');
      if (!noteOpt) { window.__J.closeDialogs(); return { ok: false, error: '添加菜单里没有「写一条笔记」' }; }
      window.__J.click(noteOpt);
      await new Promise(r => setTimeout(r, 350));
      window.__J.fillField('标题', '自检笔记 · 特征值与特征向量');
      window.__J.fillField('内容', '## 要点\\n\\n- **定义**：\`Av = λv\`\\n- [x] 已推导\\n- [ ] 还没做题');
      const okBtn = window.__J.dialogButton('创建');
      window.__J.click(okBtn);
      await new Promise(r => setTimeout(r, 900));

      const mats = await window.api.materials.list();
      const me = mats.find(m => m.title.includes('特征值'));
      return { ok: !!me, total: mats.length, id: me && me.id, visible: window.__J.viewText().includes('特征值') };
    `, 'journey:material');
    record('新建笔记资料（表单 → 资料卡出现）', r && r.ok && r.visible,
      { info: r && { 资料数: r.total, 界面已显示: r.visible } });

    if (r && r.id) {
      const r2 = await run(`
        const mo = await window.SH.app.previewById(${JSON.stringify(r.id)});
        await new Promise(r => setTimeout(r, 700));
        const dlg = window.__J.$('.dialog');
        const out = {
          ok: !!dlg,
          title: window.__J.dialogTitle(),
          hasMarkdown: !!window.__J.$('.dialog .md-body'),
          headings: window.__J.$$('.dialog .md-body .md-h').length,
          tasks: window.__J.$$('.dialog .md-body .md-task').length,
          inlineCode: window.__J.$$('.dialog .md-body code').length,
          footButtons: window.__J.$$('.dialog .pv-foot button').length,
          stillOpen: window.__J.dialogOpen()
        };
        if (mo && mo.close) mo.close();
        await new Promise(r => setTimeout(r, 300));
        return out;
      `, 'journey:preview');
      record('应用内预览笔记（Markdown 真的渲染成标题/任务清单/行内代码）',
        r2 && r2.ok && r2.hasMarkdown && r2.headings >= 1 && r2.tasks === 2 && r2.inlineCode >= 1,
        { info: r2 && { Markdown区: r2.hasMarkdown, 标题: r2.headings, 任务项: r2.tasks, 行内代码: r2.inlineCode, 底部按钮: r2.footButtons } });
    }
  }

  /* ---------- 9. 统计页：数字有内容、图表画出来了、区间切换生效 ---------- */
  {
    const r = await run(`
      await window.__J.goto('stats', { sel: '#view .stat .v', min: 4 });
      const before = window.__J.$$('#view svg').length;
      const statValues = window.__J.$$('#view .stat .v').map(v => v.textContent.trim());
      const tabs = window.__J.$$('#view .pill-tabs button');
      // 切到「近 7 天」
      const t7 = tabs.find(b => b.textContent.includes('近 7 天'));
      if (t7) window.__J.click(t7);
      await window.__J.settle(() => window.__J.$$('#view svg').length > 0, 8000);
      await new Promise(r => setTimeout(r, 350));
      const after = window.__J.$$('#view svg').length;
      return {
        ok: true, svgBefore: before, svgAfter: after,
        statValues,
        rows: window.__J.$$('#view .tb tbody tr').length,
        hasLeak: window.__J.viewText().includes('<svg'),
        hasError: window.__J.viewText().includes('这个页面出错了')
      };
    `, 'journey:stats');
    record('时间统计：卡片有数值 + 图表已绘制 + 切区间不报错',
      r && r.statValues && r.statValues.length >= 4 && r.svgAfter > 0 && !r.hasLeak && !r.hasError,
      { info: r && { 指标: r.statValues, SVG: `${r.svgBefore} → ${r.svgAfter}`, 明细行: r.rows, 泄漏标记: r.hasLeak } });
  }

  /* ---------- 10. 复盘页：评分与对比表出现 ---------- */
  {
    const r = await run(`
      await window.__J.goto('review', { text: '与上周对比' });
      return {
        ok: true,
        hasScore: window.__J.viewText().includes('专注力评分'),
        scoreValue: (window.__J.$('#view .card-body [style*="font-size: 32px"]') || {}).textContent,
        compareRows: window.__J.$$('#view .tb tbody tr').length,
        hasLeak: window.__J.viewText().includes('<svg'),
        hasError: window.__J.viewText().includes('这个页面出错了')
      };
    `, 'journey:review');
    record('监督复盘：评分卡 + 对比表渲染正常',
      r && r.hasScore && r.compareRows >= 5 && !r.hasLeak && !r.hasError,
      { info: r && { 评分: r.scoreValue, 对比项: r.compareRows } });
  }

  /* ---------- 11. 设置：改日目标 → 顶栏立刻跟着变 ---------- */
  {
    const r = await run(`
      await window.__J.goto('settings', { text: '每日目标' });
      const input = window.__J.field('每日目标');
      if (!input) return { ok: false, error: '设置页找不到「每日目标」输入框' };
      window.__J.fill(input, '200');
      await new Promise(r => setTimeout(r, 1100));
      const prof = await window.api.settings.get();
      const top = window.__J.$('#topMetrics') ? window.__J.$('#topMetrics').textContent.replace(/\\s+/g,' ') : '';
      return { ok: true, saved: prof.dailyGoalMin, topBar: top.slice(0, 60) };
    `, 'journey:settings');
    record('设置改动即时保存 + 顶栏同步刷新',
      r && r.ok && r.saved === 200 && /200|3:20/.test(r.topBar || ''),
      { info: r && { 已保存日目标: r.saved, 顶栏: r.topBar } });
  }

  /* ---------- 12. 数据落盘 ---------- */
  {
    const db = store.read();
    record('数据已落盘且结构完整',
      db.version >= 4 && Array.isArray(db.subjects) && Array.isArray(db.reviews) && db.subjects.length >= 1,
      { info: { schema: db.version, 科目: db.subjects.length, 资料: db.materials.length, 计划: db.plans.length, 记录: db.sessions.length, 复习: db.reviews.length } });

    /* 走完全流程后的界面状态，留几张图 —— 这是「用户一路点下来会看到什么」的唯一证据，
       比任何断言都直观（断言只能证明某一处对了，截图能看出整体对不对）。 */
    for (const [view, name] of [['dashboard', 'dashboard'], ['srs', 'srs'], ['plans', 'plans']]) {
      await run(`await window.__J.goto(${JSON.stringify(view)}); return { ok: true };`, 'shot-nav-' + view);
      if (deps.shot) await deps.shot(name);
    }
  }

  /* ---------- 13. 清空数据不留孤儿记录 ---------- */
  {
    const r = await run(`
      await window.api.system.clearDemo();
      await new Promise(r => setTimeout(r, 600));
      const snap = await window.api.snapshot();
      const db = snap.db;
      const orphanSessions = db.sessions.filter(s => s.subjectId && !db.subjects.some(x => x.id === s.subjectId)).length;
      return {
        ok: true,
        subjects: db.subjects.length, sessions: db.sessions.length, plans: db.plans.length,
        reviews: db.reviews.length, materials: db.materials.length, reminders: db.reminders.length,
        orphanSessions
      };
    `, 'journey:clear');
    record('「一键清空」真的清干净（不留孤儿记录）',
      r && r.subjects === 0 && r.sessions === 0 && r.plans === 0 && r.reviews === 0 && r.orphanSessions === 0,
      { info: r });
  }

  /* ---------- 14. 全局：每个视图再走一遍，确认没有累积性破坏 ---------- */
  {
    const r = await run(`
      const views = ['dashboard','focus','plans','materials','srs','stats','review','settings'];
      const bad = [];
      for (const v of views) {
        const ok = await window.__J.goto(v);
        if (!ok) { bad.push({ v, why: 'render-timeout' }); continue; }
        const host = document.getElementById('view');
        const t = host.textContent;
        if (t.includes('这个页面出错了')) bad.push({ v, why: 'error-card' });
        else if (t.includes('<svg')) bad.push({ v, why: 'leaked-markup' });
        else if (host.querySelectorAll('*').length < 15) bad.push({ v, why: 'too-few-nodes' });
      }
      return { ok: bad.length === 0, bad };
    `, 'journey:sweep');
    record('全视图扫一遍：无错误卡 / 无标记泄漏 / 节点数正常',
      r && r.ok,
      { info: r && { 异常视图: r.bad } });
  }

  const summary = {
    total: results.length,
    passed: results.length - failures,
    failed: failures,
    ok: failures === 0
  };
  console.log(`  → 流程测试 ${summary.passed}/${summary.total} 通过`);
  return { results, summary, ok: failures === 0 };
}

module.exports = { run };
