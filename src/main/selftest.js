'use strict';
/**
 * selftest.js —— 真机验收脚本（仅开发用）
 *
 * 用法：STUDY_HUB_SELFTEST=1 <electron> .
 * 做四件事：
 *   1. 逐个切换全部视图，捕获渲染层任何未处理异常与 console.error
 *   2. 走一遍「开始计时 → 暂停 → 继续 → 结束并记录」，确认真写出了学习记录
 *   3. 手动触发一次提醒规则扫描，确认通知链路不断
 *   4. 每个视图截一张图存到 outDir，随后退出
 * 这样做而不是靠单测：这个应用 80% 的风险在「界面渲染 + 主进程状态」的交互上，
 * 只有真正把窗口开起来点一遍才能发现。
 */

const fs = require('fs');
const path = require('path');

const VIEWS = ['dashboard', 'focus', 'plans', 'materials', 'srs', 'stats', 'review', 'settings'];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function run(ctx, outDir) {
  const { mainWindow, timer, notifier, scheduler, store } = ctx;
  const A = require('./analytics');
  const U = require('./util');
  const ROOT = require('path').join(__dirname, '..', '..');
  const report = { startedAt: new Date().toISOString(), steps: [], errors: [], shots: [], ok: true };

  /**
   * 自检要跑几十项操作，中途出问题时如果只看到「进程没了」会完全无从下手。
   * 所以每推入一个步骤就立刻往 stdout 和 progress.log 各写一行（带内存占用），
   * 崩溃时看最后一行就知道死在哪一步。之前主进程 OOM 就是靠这个定位的。
   */
  const progressFile = path.join(outDir, 'progress.log');
  const mem = () => {
    const m = process.memoryUsage();
    return `${Math.round(m.rss / 1048576)}M rss/${Math.round(m.heapUsed / 1048576)}M heap`;
  };
  const steps = [];
  steps.push = function (...items) {
    for (const it of items) {
      const line = `[stage] ${String(it && it.step)}  ${mem()}\n`;
      try { process.stdout.write(line); } catch (_) {}
      try { fs.appendFileSync(progressFile, line); } catch (_) {}
    }
    return Array.prototype.push.apply(this, items);
  };
  report.steps = steps;

  const wc = mainWindow.webContents;

  /**
   * 给 executeJavaScript 套一层超时。
   *
   * 没有这层的话，渲染层里任何一处死循环都会让自检**永久挂住**，而表现只是
   * 「跑了几分钟没动静」—— 完全看不出是哪一步出的问题。加了超时之后会明确报出
   * 「这一步在渲染层卡住了」，并且自检本身还能继续跑完剩下的检查。
   */
  const evalJs = (code, timeoutMs = 15000, label = '') =>
    Promise.race([
      wc.executeJavaScript(code),
      new Promise((_r, reject) => setTimeout(() => reject(new Error(`渲染层执行超时（${label || '未命名'}，${timeoutMs}ms）—— 页面里可能有死循环或未响应的同步操作`)), timeoutMs))
    ]).catch((err) => ({ __evalError: String(err && err.message || err) }));

  // 采集渲染层的异常
  const pageErrors = [];
  wc.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) pageErrors.push({ level, message, line, sourceId });
  });
  wc.on('render-process-gone', (_e, details) => {
    report.errors.push({ where: 'render-process-gone', details });
    report.ok = false;
  });

  await sleep(2500);

  fs.mkdirSync(outDir, { recursive: true });

  /* ---------- 1. 逐视图渲染 + 截图 ---------- */
  for (const view of VIEWS) {
    const before = pageErrors.length;
    const res = await evalJs(`
      (async () => {
        try {
          await window.SH.app.go(${JSON.stringify(view)});
          await new Promise(r => setTimeout(r, 420));
          const host = document.getElementById('view');
          const text = host ? host.textContent : '';
          // 回归守卫：图表函数返回 SVG 源码字符串，若漏了归一化就会被当文本显示出来
          const leaked = text.includes('<svg') || text.includes('</text>') || text.includes('stroke-dasharray=');
          return {
            ok: !leaked,
            view: ${JSON.stringify(view)},
            nodes: host ? host.querySelectorAll('*').length : 0,
            hasErrorCard: text.includes('这个页面出错了'),
            leakedMarkup: leaked,
            leakedSample: leaked ? text.slice(Math.max(0, text.indexOf('<svg') - 20), text.indexOf('<svg') + 80) : '',
            title: document.getElementById('viewTitle').textContent,
            sub: document.getElementById('viewSub').textContent.slice(0, 60)
          };
        } catch (e) { return { ok: false, view: ${JSON.stringify(view)}, error: String(e && e.stack || e) }; }
      })()
    `).catch((err) => ({ ok: false, view, error: String(err) }));

    const newErrors = pageErrors.slice(before);
    report.steps.push({ step: 'render:' + view, ...res, consoleErrors: newErrors.length });
    if (!res || res.__evalError || !res.ok || res.hasErrorCard || res.leakedMarkup || res.nodes < 20) {
      report.ok = false;
      report.errors.push({ where: 'render:' + view, res, newErrors });
    }

    try {
      const img = await wc.capturePage();
      const file = path.join(outDir, `${VIEWS.indexOf(view) + 1}-${view}.png`);
      fs.writeFileSync(file, img.toPNG());
      report.shots.push(file);
    } catch (err) {
      report.errors.push({ where: 'capture:' + view, error: String(err) });
    }
  }

  /* ---------- 2. 计时全链路 ---------- */
  const sessionsBefore = store.read().sessions.length;
  const t1 = timer.start({ mode: 'pomodoro', phase: 'focus', subjectId: (store.read().subjects[0] || {}).id });
  report.steps.push({ step: 'timer:start', running: t1.running, phase: t1.phase });
  await sleep(600);
  const t2 = timer.pause();
  report.steps.push({ step: 'timer:pause', paused: t2.paused, interruptions: t2.interruptions });
  await sleep(300);
  const t3 = timer.resume();
  report.steps.push({ step: 'timer:resume', paused: t3.paused });
  const t4 = timer.markDistraction();
  report.steps.push({ step: 'timer:distraction', interruptions: t4.interruptions });
  await sleep(2500);
  const stopped = timer.stop();
  const sessionsAfter = store.read().sessions.length;
  report.steps.push({
    step: 'timer:stop',
    recorded: !!stopped.session,
    minutes: stopped.session && stopped.session.minutes,
    score: stopped.session && stopped.session.focusScore,
    sessionsDelta: sessionsAfter - sessionsBefore
  });
  if (!stopped.session || sessionsAfter !== sessionsBefore + 1) {
    // 1 分钟以下是设计上不记录的，这里只提示，不算失败
    report.steps.push({ step: 'timer:stop:note', info: '不足 1 分钟未写入记录（符合设计）' });
  }

  /* ---------- 2b. 番茄钟「走到点」全链路 ---------- */
  // 真实等满 25 分钟不现实，所以把 startedAt 往前倒推，让下一拍 tick 直接判定该阶段结束。
  // 这条路径是产品的心脏（到点提醒 + 自动写入记录 + 切阶段），必须真跑一次。
  const beforePhase = store.read().sessions.length;
  const st0 = timer.start({ mode: 'pomodoro', phase: 'focus', subjectId: (store.read().subjects[0] || {}).id });
  const phaseTotal = st0.phaseTotalMs;
  const phaseEvents = [];
  const onPhase = (p) => phaseEvents.push(p);
  timer.once('phase-complete', onPhase);
  timer.state.startedAt = Date.now() - phaseTotal - 1500;   // 倒推，使 elapsed > phaseTotal
  await sleep(2600);                                        // 等 2 拍 tick
  timer.off('phase-complete', onPhase);

  const afterPhase = store.read().sessions.length;
  const stAfter = timer.getState();
  report.steps.push({
    step: 'pomodoro:phase-complete',
    phaseEvent: phaseEvents[0] || null,
    recorded: afterPhase === beforePhase + 1,
    recordedMinutes: (store.read().sessions[afterPhase - 1] || {}).minutes,
    recordedScore: (store.read().sessions[afterPhase - 1] || {}).focusScore,
    nextPhase: stAfter.phase,
    round: stAfter.round,
    running: stAfter.running
  });
  if (afterPhase !== beforePhase + 1 || !phaseEvents.length || stAfter.phase !== 'short') {
    report.ok = false;
    report.errors.push({ where: 'pomodoro:phase-complete', info: '专注到点没有正确写记录或切换到短休息', afterPhase, beforePhase, stAfter });
  }
  timer.stop();

  /* ---------- 2c. 手工补录（sessions.add）与资料/任务回写 ---------- */
  const matBefore = store.read().materials[1];
  const matMinBefore = matBefore.timeSpentMin || 0;
  const manual = await evalJs(`
    window.api.sessions.add({ subjectId: '', materialId: ${JSON.stringify(matBefore.id)}, minutes: 42, end: new Date().toISOString(), note: '自检补录' })
      .then(r => ({ id: r.id, minutes: r.minutes })).catch(e => ({ error: String(e) }))
  `).catch((e) => ({ error: String(e) }));
  await sleep(300);
  const matAfter = store.read().materials.find((m) => m.id === matBefore.id) || {};
  report.steps.push({
    step: 'session:manual-add',
    created: !!(manual && manual.id),
    minutes: manual && manual.minutes,
    materialTimeBefore: matMinBefore,
    materialTimeAfter: matAfter.timeSpentMin,
    materialStatus: matAfter.status
  });
  if (!manual || !manual.id || (matAfter.timeSpentMin || 0) !== matMinBefore + 42) {
    report.ok = false;
    report.errors.push({ where: 'session:manual-add', manual, matMinBefore, matAfter: matAfter.timeSpentMin });
  }
  if (manual && manual.id) store.remove('sessions', manual.id);

  /* ---------- 1b. 复习（间隔重复）全链路 ---------- */
  {
    const before = store.read().reviews.length;
    const q = A.reviewQueue(store.read(), U.dayKey());
    const target = [...q.overdue, ...q.due][0];

    let graded = null;
    if (target) {
      const stageBefore = target.stage;
      graded = timer && null;
      graded = await evalJs(`
        window.api.reviews.grade(${JSON.stringify(target.id)}, 'good')
          .then(r => ({ stage: r.stage, nextAt: r.nextAt, mastered: r.mastered, attempts: (r.history||[]).length }))
          .catch(e => ({ error: String(e) }))
      `);
      report.steps.push({
        step: 'srs:grade-good',
        title: target.title,
        stageBefore,
        stageAfter: graded && graded.stage,
        nextAt: graded && graded.nextAt,
        attempts: graded && graded.attempts
      });
      if (!graded || graded.error || graded.stage <= stageBefore) {
        report.ok = false;
        report.errors.push({ where: 'srs:grade-good', graded, stageBefore });
      }
    } else {
      report.steps.push({ step: 'srs:grade-good', skipped: '示例数据里没有到期的复习项' });
    }

    // 「忘了」必须把 stage 打回 0 —— 这是间隔重复能否自我纠正的关键
    const forgotTarget = store.read().reviews.find((r) => !r.mastered && !r.archived);
    if (forgotTarget) {
      const r = await evalJs(`
        window.api.reviews.grade(${JSON.stringify(forgotTarget.id)}, 'forgot').then(x => ({ stage: x.stage, lapses: x.lapses, nextAt: x.nextAt })).catch(e => ({ error: String(e) }))
      `);
      report.steps.push({ step: 'srs:grade-forgot', title: forgotTarget.title, result: r });
      if (!r || r.error || r.stage !== 0) {
        report.ok = false;
        report.errors.push({ where: 'srs:grade-forgot', r });
      }
    }

    // 新增一个知识点，验证「自动排到次日」
    const created = await evalJs(`
      window.api.reviews.add({ title: '自检知识点', note: '自动化测试用' })
        .then(r => ({ stage: r.stage, nextAt: r.nextAt, learnedAt: r.learnedAt })).catch(e => ({ error: String(e) }))
    `);
    const expectNext = U.dayKey(U.addDays(new Date(), 1));
    report.steps.push({ step: 'srs:add', created, expectNext });
    if (!created || created.error || created.nextAt !== expectNext) {
      report.ok = false;
      report.errors.push({ where: 'srs:add', created, expectNext });
    }
    if (created && created.nextAt) {
      // 收尾：把自检产生的数据清掉
      const list = store.read().reviews.filter((x) => x.title === '自检知识点');
      for (const x of list) store.remove('reviews', x.id);
    }
    report.steps.push({ step: 'srs:stats', stats: A.reviewStats(store.read(), 14) });
    report.steps.push({ step: 'srs:count', before, after: store.read().reviews.length });
  }

  /* ---------- 1c. 任务打卡 → 自动排入复习 ---------- */
  {
    const plan = store.read().plans[0];
    const task = plan && (plan.tasks || []).find((t) => t.repeat === 'none' && !t.done);
    if (task) {
      const before = store.read().reviews.filter((r) => r.title === task.title).length;
      await evalJs(`window.api.plans.toggleTask(${JSON.stringify(plan.id)}, ${JSON.stringify(task.id)}, ${JSON.stringify(U.dayKey())})`);
      await sleep(300);
      const after = store.read().reviews.filter((r) => r.title === task.title).length;
      report.steps.push({ step: 'srs:auto-from-task', title: task.title, reviewsBefore: before, reviewsAfter: after });
      if (after <= before) {
        report.ok = false;
        report.errors.push({ where: 'srs:auto-from-task', info: '勾掉任务后没有自动进入复习队列', task: task.title });
      }
      // 还原，免得自检改动了演示数据
      await evalJs(`window.api.plans.toggleTask(${JSON.stringify(plan.id)}, ${JSON.stringify(task.id)}, ${JSON.stringify(U.dayKey())})`);
      await sleep(200);
      for (const r of store.read().reviews.filter((x) => x.title === task.title && x.auto)) store.remove('reviews', r.id);
    } else {
      report.steps.push({ step: 'srs:auto-from-task', skipped: '没有可用的单次任务' });
    }
  }

  /* ---------- 1d. 预览：文本 / Markdown / 图片 探测 ---------- */  {
    const probe = await evalJs(`
      (async () => {
        const out = {};
        const mats = await window.api.materials.list();
        for (const m of mats.slice(0, 8)) {
          const p = await window.api.preview.probe(m.id);
          out[m.title.slice(0, 14)] = p.ok ? p.kind : 'ERR:' + p.message;
        }
        return out;
      })()
    `).catch((e) => ({ fatal: String(e) }));
    report.steps.push({ step: 'preview:probe', result: probe });

    // 真造一个 Markdown 文件、导进资料库、读回来渲染，验证整条链路
    const tmp = path.join(outDir, 'selftest-note.md');
    fs.writeFileSync(tmp, [
      '# 自检笔记',
      '',
      '这是 **粗体**、*斜体*、`代码`、~~删除线~~ 与 [链接](https://example.com)。',
      '',
      '## 列表',
      '- [x] 已完成项',
      '- [ ] 待办项',
      '1. 第一',
      '2. 第二',
      '',
      '```js',
      'const a = "*不是斜体*";',
      '```',
      '',
      '> 引用里的 **加粗**',
      '',
      '| 列A | 列B |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '| 危险 |',
      '| --- |',
      '| <img src=x onerror=alert(1)> |'
    ].join('\n'), 'utf8');

    const mdResult = await evalJs(`
      (async () => {
        const m = await window.api.materials.add({ title: '自检 Markdown', type: 'note', path: ${JSON.stringify(tmp)}, ext: 'md' });
        const r = await window.api.preview.read(m.id, 'text');
        const html = window.SH.markdown.render(r.text || '');
        const stats = window.SH.markdown.stats(r.text || '');
        return {
          materialId: m.id,
          probeKind: (await window.api.preview.probe(m.id)).kind,
          ok: r.ok,
          escaped: html.includes('&lt;img'),
          hasRawScript: /<img\\s/i.test(html),
          hasH1: html.includes('<h1'),
          hasH2: html.includes('<h2'),
          hasStrong: html.includes('<strong>'),
          hasTable: html.includes('md-table'),
          hasPre: html.includes('md-pre'),
          codeUntouched: html.includes('*不是斜体*'),
          hasQuote: html.includes('md-quote'),
          hasTask: html.includes('md-task'),
          chars: stats.chars, lines: stats.lines, minutes: stats.minutes
        };
      })()
    `).catch((e) => ({ fatal: String(e) }));
    report.steps.push({ step: 'preview:markdown', result: mdResult });

    if (!mdResult || mdResult.fatal || !mdResult.ok) {
      report.ok = false;
      report.errors.push({ where: 'preview:markdown', mdResult });
    } else {
      // 最关键的一条：Markdown 里嵌入的 HTML 必须被转义，不能被当标签执行
      if (!mdResult.escaped || mdResult.hasRawScript) {
        report.ok = false;
        report.errors.push({ where: 'preview:markdown:xss', info: 'Markdown 内嵌 HTML 没有被转义', mdResult });
      }
      if (!mdResult.hasH1 || !mdResult.hasStrong || !mdResult.hasTable || !mdResult.hasPre || !mdResult.codeUntouched) {
        report.ok = false;
        report.errors.push({ where: 'preview:markdown:render', info: 'Markdown 渲染结果不完整', mdResult });
      }
      const mid = mdResult.materialId;
      if (mid) store.remove('materials', mid);
    }
    try { fs.unlinkSync(tmp); } catch (_) {}
  }

  /* ---------- 1e. 提醒守护进程 ---------- */
  {
    const fsr = require('fs');
    const tmpData = path.join(outDir, 'daemon-data');
    fsr.mkdirSync(tmpData, { recursive: true });
    // 把当前数据快照复制一份给守护用，避免守护写真实数据目录
    fsr.writeFileSync(path.join(tmpData, 'study-hub.json'), JSON.stringify(store.read()), 'utf8');

    const dry = await new Promise((resolve) => {
      const { execFile } = require('child_process');
      execFile(process.execPath, [path.join(ROOT, 'src', 'daemon', 'reminder-daemon.js'),
        '--once', '--dry-run', '--force', '--data-dir', tmpData],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30000 },
      (err, stdout, stderr) => resolve({ err: err ? String(err.message) : '', stdout: String(stdout), stderr: String(stderr) }));
    });
    let parsed = null;
    try { parsed = JSON.parse(dry.stdout); } catch (_) {}
    report.steps.push({
      step: 'daemon:dry-run',
      ok: !!(parsed && parsed.ok),
      fired: parsed ? (parsed.fired || []).map((x) => x.key) : null,
      error: dry.err || (parsed ? null : dry.stderr.slice(0, 300))
    });
    if (!parsed || !parsed.ok) {
      report.ok = false;
      report.errors.push({ where: 'daemon:dry-run', dry: dry.stdout.slice(0, 500), err: dry.err, stderr: dry.stderr.slice(0, 300) });
    }

    // 幂等：连跑两次，第二次不应再命中同一批规则
    const stateFile = path.join(tmpData, 'daemon-state.json');
    const real1 = await new Promise((resolve) => {
      require('child_process').execFile(process.execPath, [path.join(ROOT, 'src', 'daemon', 'reminder-daemon.js'),
        '--once', '--force', '--quiet', '--data-dir', tmpData],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30000 },
      (err) => resolve(!err));
    });
    const firstState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    await new Promise((resolve) => {
      require('child_process').execFile(process.execPath, [path.join(ROOT, 'src', 'daemon', 'reminder-daemon.js'),
        '--once', '--force', '--quiet', '--data-dir', tmpData],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30000 },
      (err) => resolve(!err));
    });
    const secondState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    report.steps.push({
      step: 'daemon:idempotent',
      ranOk: real1,
      firstFired: firstState.lastFiredCount,
      secondFired: secondState.lastFiredCount,
      seq: secondState.seq,
      logEntries: secondState.log.length
    });
    if (secondState.lastFiredCount !== 0) {
      report.ok = false;
      report.errors.push({ where: 'daemon:idempotent', info: '守护第二次运行仍然重复命中规则', secondState: secondState.lastFiredCount });
    }

    // 心跳让位
    const aliveFile = path.join(tmpData, 'app-alive.json');
    fs.writeFileSync(aliveFile, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
    const skipRes = await new Promise((resolve) => {
      require('child_process').execFile(process.execPath, [path.join(ROOT, 'src', 'daemon', 'reminder-daemon.js'),
        '--once', '--data-dir', tmpData],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30000 },
      (err, stdout) => resolve(String(stdout)));
    });
    let skipParsed = null;
    try { skipParsed = JSON.parse(skipRes); } catch (_) {}
    report.steps.push({ step: 'daemon:yield-to-app', skipped: skipParsed ? skipParsed.skipped : null });
    if (!skipParsed || !skipParsed.skipped) {
      report.ok = false;
      report.errors.push({ where: 'daemon:yield-to-app', info: '有了心跳守护仍然抢着发通知，会导致重复提醒' });
    }
    try { fs.writeFileSync(aliveFile, JSON.stringify({ pid: process.pid, at: 1 }), 'utf8'); } catch (_) {}

    // 清理
    try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch (_) {}
  }

  /* ---------- 2d. 预览弹窗真的能开出来 ---------- */
  {
    const mdId = store.read().materials.find((m) => /\.md$/i.test(m.path || '') || m.type === 'note' && m.body)?.id;
    const noteId = store.read().materials.find((m) => (m.body || '').length > 20)?.id;
    const targetId = mdId || noteId;
    if (targetId) {
      const r = await evalJs(`
        (async () => {
          try {
            const mo = await window.SH.app.previewById(${JSON.stringify(targetId)});
            await new Promise(r => setTimeout(r, 600));
            const dlg = document.querySelector('.dialog');
            const out = {
              ok: !!dlg,
              title: dlg ? (dlg.querySelector('h3') || {}).textContent : '',
              hasMarkdown: !!document.querySelector('.dialog .md-body'),
              mdBlocks: document.querySelectorAll('.dialog .md-body > *').length,
              toolbarItems: document.querySelectorAll('.dialog .pv-toolbar > *').length,
              footButtons: document.querySelectorAll('.dialog .pv-foot button').length
            };
            if (mo && mo.close) mo.close();
            return out;
          } catch (e) { return { ok: false, reason: String(e && e.stack || e) }; }
        })()
      `).catch((e) => ({ ok: false, reason: String(e) }));
      report.steps.push({ step: 'preview:modal', result: r });
      if (!r || !r.ok || (!r.hasMarkdown && r.mdBlocks === 0)) {
        report.ok = false;
        report.errors.push({ where: 'preview:modal', r });
      }
    } else {
      report.steps.push({ step: 'preview:modal', skipped: '没有可内联预览的资料' });
    }
  }

  /* ---------- 2f. 浮层不会失控堆积 ---------- */
  {
    steps.push({ step: 'toast:cap:start' });
    await evalJs(`
      (() => {
        for (let i = 0; i < 8; i++) {
          window.SH.toast({ title: '并发提醒 ' + i, body: '测试上限', kind: 'warn', timeout: 60000 });
        }
        return true;
      })()
    `).catch(() => {});
    steps.push({ step: 'toast:cap:created' });
    await sleep(500);
    const counts = await evalJs(`({ toasts: document.querySelectorAll('#toasts .toast').length })`).catch(() => null);
    steps.push({ step: 'toast:cap', counts });
    if (!counts || counts.__evalError || counts.toasts > 3) {
      report.ok = false;
      report.errors.push({ where: 'toast:cap', info: '同时弹出的浮层超过上限，会遮挡界面', counts });
    }
    await evalJs(`document.querySelectorAll('#toasts .toast').forEach(t => t.remove()); true`).catch(() => {});
    steps.push({ step: 'toast:cap:cleared' });
  }

  /* ---------- 2g. 截图：复习页的另外两个标签 ---------- */
  // 先关掉可能还开着的弹窗，否则截出来的图上盖着一个预览框，看不出页面本身
  await evalJs(`document.querySelectorAll('.mask').forEach(m => m.remove()); true`, 5000).catch(() => {});
  for (const mode of ['all', 'curve']) {
    const label = mode === 'all' ? '全部知识点' : '遗忘曲线';
    await evalJs(`
      (async () => {
        await window.SH.app.go('srs');
        await new Promise(r => setTimeout(r, 300));
        const btns = [...document.querySelectorAll('#view .pill-tabs button')];
        const b = btns.find(x => x.textContent.includes(${JSON.stringify(label)}));
        if (b) b.click();
        await new Promise(r => setTimeout(r, 600));
        return true;
      })()
    `).catch(() => {});
    const info = await evalJs(`({
      nodes: document.getElementById('view').querySelectorAll('*').length,
      leaked: document.getElementById('view').textContent.includes('<svg') || document.getElementById('view').textContent.includes('</text>'),
      svg: document.querySelectorAll('#view svg').length,
      errorCard: document.getElementById('view').textContent.includes('这个页面出错了')
    })`).catch((e) => ({ leakError: String(e) }));
    steps.push({ step: 'srs-tab:' + mode, ...info });
    if (!info || info.__evalError || info.leaked || info.errorCard || info.nodes < 20) {
      report.ok = false;
      report.errors.push({ where: 'srs-tab:' + mode, info });
    }
    try {
      const img = await wc.capturePage();
      const file = path.join(outDir, `srs-${mode}.png`);
      fs.writeFileSync(file, img.toPNG());
      report.shots.push(file);
    } catch (_) {}
    steps.push({ step: 'srs-tab:shot:' + mode });
  }

  await evalJs(`window.SH.app.go('dashboard'); true`).catch(() => {});
  await sleep(300);

  /* ---------- 3. 提醒通道 ---------- */
  try {
    const before = await evalJs(`document.querySelectorAll('#toasts .toast').length`).catch(() => 0);
    notifier.send({ kind: 'info', title: '自检：通知通道', body: '系统通知 + 窗口浮层', force: true });
    await sleep(400);
    const after = await evalJs(`document.querySelectorAll('#toasts .toast').length`).catch(() => 0);
    report.steps.push({ step: 'notify:toast-visible', toastsBefore: before, toastsAfter: after, added: after - before, systemSupported: notifier.supported });
    if (after <= before) { report.ok = false; report.errors.push({ where: 'notify', info: '窗口浮层没有出现' }); }
    // 一条通知只能产生一个浮层 —— 早先 Notifier 同时回调了 toast 和 history，
    // 主进程把两者都转发成浮层，于是每条提醒都弹两次
    if (after - before !== 1) {
      report.ok = false;
      report.errors.push({ where: 'notify:duplicate', info: `一条通知产生了 ${after - before} 个浮层，应为 1 个` });
    }
  } catch (err) {
    report.errors.push({ where: 'notify', error: String(err) });
  }

  /* ---------- 4. 调度规则 ---------- */
  try {
    const before = (store.read().scheduler.lastFired || {});
    const fired = scheduler.check();
    const after = (store.read().scheduler.lastFired || {});
    report.steps.push({
      step: 'scheduler:check',
      fired: fired || [],
      firedKeysBefore: Object.keys(before).length,
      firedKeysAfter: Object.keys(after).length
    });
  } catch (err) {
    report.ok = false;
    report.errors.push({ where: 'scheduler', error: String(err && err.stack || err) });
  }

  /* ---------- 5. 启动链路可用性 ---------- */
  /**
   * 这一组检查的是「用户照 README 敲命令能不能跑起来」，而不是应用本身的功能。
   * 之所以值得放进自检：这两类问题都属于「应用代码完全正确、但用户一定跑不起来」，
   * 而且报错信息和应用毫无关系，排查成本极高：
   *   · node_modules/.bin/electron 缺失（npm install 中途失败会留下这种半成品状态）
   *     → `npm start` 报 `electron: command not found`
   *   · 环境里有 ELECTRON_RUN_AS_NODE → Electron 退化成纯 Node，
   *     报 `Cannot read properties of undefined (reading 'setAppUserModelId')`
   */
  {
    const binLink = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
    const distExe = path.join(ROOT, 'node_modules', 'electron', 'dist',
      process.platform === 'win32' ? 'electron.exe' : path.join('Electron.app', 'Contents', 'MacOS', 'Electron'));
    const launch = {
      distExists: fs.existsSync(distExe),
      binLinkExists: fs.existsSync(binLink),
      pathTxt: (() => {
        try { return fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'path.txt'), 'utf8').trim(); } catch (_) { return ''; }
      })(),
      runAppExists: fs.existsSync(path.join(ROOT, 'tools', 'run-app.js')),
      ensureRuntimeExists: fs.existsSync(path.join(ROOT, 'tools', 'ensure-runtime.js')),
      startScript: (() => {
        try { return require(path.join(ROOT, 'package.json')).scripts.start; } catch (_) { return ''; }
      })(),
      prestartScript: (() => {
        try { return require(path.join(ROOT, 'package.json')).scripts.prestart || ''; } catch (_) { return ''; }
      })()
    };
    report.steps.push({ step: 'launch:chain', ...launch });
    if (!launch.distExists) {
      report.ok = false;
      report.errors.push({ where: 'launch:dist', info: 'Electron 二进制不在 node_modules/electron/dist 里' });
    }
    if (!launch.binLinkExists) {
      report.ok = false;
      report.errors.push({ where: 'launch:bin', info: 'node_modules/.bin/electron 不存在 —— npm start 会报 command not found' });
    }
    if (launch.startScript !== 'node tools/run-app.js') {
      report.ok = false;
      report.errors.push({ where: 'launch:start', info: `package.json 的 start 应走 tools/run-app.js（它负责清理破坏性环境变量），当前是：${launch.startScript}` });
    }
    if (launch.prestartScript !== 'node tools/ensure-runtime.js') {
      report.ok = false;
      report.errors.push({ where: 'launch:prestart', info: '缺少 prestart 自愈脚本，npm install 半途失败后 npm start 会直接报错' });
    }
  }

  /* ---------- 6. 关键 IPC 冒烟 ---------- */
  const ipcProbe = await evalJs(`
    (async () => {
      const out = {};
      const p = async (k, fn) => { try { const v = await fn(); out[k] = Array.isArray(v) ? 'array[' + v.length + ']' : (v && typeof v === 'object' ? 'object' : String(v)); } catch (e) { out[k] = 'ERR:' + String(e).slice(0, 120); } };
      await p('snapshot', () => window.api.snapshot());
      await p('overview', () => window.api.stats.overview());
      await p('daily', () => window.api.stats.daily(30));
      await p('heatmap', () => window.api.stats.heatmap(18));
      await p('hourly', () => window.api.stats.hourly(30));
      await p('weeklyReport', () => window.api.stats.weeklyReport(0));
      await p('planReport', () => window.api.stats.planReport());
      await p('materialReport', () => window.api.stats.materialReport());
      await p('plansToday', () => window.api.plans.today());
      await p('materials', () => window.api.materials.list());
      await p('reminders', () => window.api.reminders.list());
      await p('settings', () => window.api.settings.get());
      await p('sysinfo', () => window.api.system.info());
      await p('history', () => window.api.notify.history());
      return out;
    })()
  `).catch((err) => ({ fatal: String(err) }));
  report.steps.push({ step: 'ipc-smoke', result: ipcProbe });
  if (ipcProbe && ipcProbe.__evalError) { report.ok = false; report.errors.push({ where: 'ipc-smoke', error: ipcProbe.__evalError }); }
  Object.entries(ipcProbe || {}).forEach(([k, v]) => {
    if (typeof v === 'string' && v.startsWith('ERR:')) {
      report.ok = false;
      report.errors.push({ where: 'ipc:' + k, error: v });
    }
  });

  /* ---------- 7. 图表确实画出来了 ---------- */
  await evalJs(`window.SH.app.go('stats')`).catch(() => {});
  await sleep(700);
  const svgCount = await evalJs(`document.querySelectorAll('#view svg').length`);
  const rectCount = await evalJs(`document.querySelectorAll('#view svg rect, #view svg path, #view svg circle').length`);
  report.steps.push({ step: 'charts', svg: svgCount, shapes: rectCount });
  if (svgCount && svgCount.__evalError) { report.ok = false; report.errors.push({ where: 'charts', info: svgCount.__evalError }); }
  else if (!svgCount || !rectCount) { report.ok = false; report.errors.push({ where: 'charts', svgCount, rectCount }); }

  /* ---------- 8. 界面级端到端流程 ---------- */
  /**
   * 前面各组的「渲染 / 计时 / 复习 / 预览 / 守护 / 通知 / 启动链路 / IPC / 图表」都是直接调 api 验证后端。
   * 这一组换个维度：只点界面上真实的按钮、填真实的表单，验证**接线**。
   * 两者缺一不可 —— api 全绿但按钮没绑事件，用户点下去照样没反应。
   */
  {
    const journey = require('./journey');
    const helpers = {
      evalJs,
      wait: sleep,
      readDb: async () => store.read(),
      shot: async (name) => {
        try {
          const img = await wc.capturePage();
          const file = path.join(outDir, 'journey-' + name + '.png');
          fs.writeFileSync(file, img.toPNG());
          report.shots.push(file);
          return file;
        } catch (_) { return null; }
      }
    };
    console.log('\n  ── 界面级端到端流程 ──');
    const jr = await journey.run(ctx, outDir, helpers);
    report.steps.push({ step: 'journey', summary: jr.summary, results: jr.results });
    if (!jr.ok) {
      report.ok = false;
      report.errors.push({
        where: 'journey',
        info: `${jr.summary.failed} 项流程检查未通过`,
        failed: jr.results.filter((r) => !r.ok)
      });
    }
    // 流程测试会造数据，结束前清干净，免得影响后续截图
    await evalJs(`(async () => { await window.api.system.clearDemo(); return true; })()`, 8000, 'journey-clean').catch(() => {});
    await sleep(400);
    await evalJs(`window.SH.app.go('dashboard'); true`, 5000).catch(() => {});
    await sleep(400);
  }

  if (pageErrors.length) {
    report.ok = false;
    report.errors.push({ where: 'console', list: pageErrors.slice(0, 20) });
  }

  report.finishedAt = new Date().toISOString();
  report.summary = {
    viewsOk: report.steps.filter((s) => String(s.step).startsWith('render:') && s.ok && !s.hasErrorCard).length + '/' + VIEWS.length,
    consoleErrors: pageErrors.length,
    shots: report.shots.length
  };
  return report;
}

module.exports = { run, VIEWS };
