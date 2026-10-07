/* views/settings.js —— 设置：把系统调成适合自己节奏的样子 */
(function () {
  'use strict';
  const SH = window.SH;
  const h = SH.h, api = SH.api, F = SH.fmt;

  const PALETTE = ['#2563eb', '#3b5bfd', '#7c3aed', '#c026d3', '#db2777', '#dc2626', '#ea580c', '#d97706', '#65a30d', '#0d9488', '#0891b2', '#475569'];
  const REPEAT = { daily: '每天', weekdays: '工作日', weekly: '每周', once: '仅一次' };

  SH.views.settings = {
    title: '设置',
    sub: () => '数据全部存在本机，不会上传任何服务器',

    async load() {
      const [info, backups, autostart] = await Promise.all([
        api.system.info(), api.system.backupList(), api.autostart.detect()
      ]);
      return { info, backups, autostart };
    },

    render(root, S, x) {
      const p = S.db.profile;
      root.appendChild(h('div', { class: 'grid g2' },
        profileCard(S, p),
        goalCard(S, p)));
      root.appendChild(h('h2', { class: 'section' }, '提醒通道'));
      root.appendChild(daemonCard(S, x.autostart, x.info));
      root.appendChild(h('div', { class: 'grid g2' },
        pomodoroCard(S, p),
        notifyCard(S, p)));
      root.appendChild(h('h2', { class: 'section' }, '复习'));
      root.appendChild(reviewCard(S, p));
      root.appendChild(h('h2', { class: 'section' }, '科目'));
      root.appendChild(subjectCard(S));
      root.appendChild(h('h2', { class: 'section' }, '定时提醒'));
      root.appendChild(reminderCard(S));
      root.appendChild(h('h2', { class: 'section' }, '数据与应用'));
      root.appendChild(dataCard(S, x));
    }
  };

  /* ---------------- 后台提醒守护 ---------------- */
  function daemonCard(S, a, info) {
    if (!a || !a.supported) {
      return card('后台提醒', null,
        h('div', { class: 'small muted' },
          `当前平台（${a ? a.platform : '未知'}）暂不支持注册系统级后台提醒。` +
          '应用运行时提醒仍然正常工作；要完全退出后也收到提醒，需要自行配置系统计划任务。'));
    }

    const state = h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap', marginBottom: '12px' } },
      a.installed
        ? h('span', { class: 'chip ok' }, a.loaded ? '后台提醒已开启' : '已注册（未运行）')
        : h('span', { class: 'chip warn' }, '后台提醒未开启'),
      h('span', { class: 'small muted' }, `巡检间隔 ${Math.round(a.intervalSec / 60)} 分钟`),
      a.daemonLastRunAt ? h('span', { class: 'small muted' }, `上次巡检 ${F.relTime(a.daemonLastRunAt)}`) : null,
      a.daemonRuns ? h('span', { class: 'small muted' }, `累计 ${a.daemonRuns} 次`) : null);

    const explain = h('div', { class: 'set-row' },
      h('div', { class: 's-label' },
        h('b', null, '为什么需要它'),
        h('span', null, '应用完全退出后，进程内的定时器也一起消失，「到点提醒」就断了。' +
          '开启后台提醒后，系统会定时拉起一个只跑几十毫秒的巡检进程，到点直接发系统通知。')));

    const logBox = h('div');
    if (a.recentLog && a.recentLog.length) {
      const list = h('div', { class: 'list', style: { maxHeight: '180px', overflow: 'auto', border: '1px solid var(--border)', borderRadius: '8px' } });
      a.recentLog.forEach((e) => list.appendChild(h('div', { class: 'list-item', style: { padding: '8px 12px' } },
        h('span', { class: 'chip ' + (e.delivered ? 'ok' : 'warn') }, e.delivered ? '已送达' : '发送失败'),
        h('div', { style: { flex: '1', minWidth: 0 } },
          h('div', { class: 'li-title', style: { fontSize: '12.5px' } }, e.title),
          h('div', { class: 'li-sub' }, e.reason || '')),
        h('span', { class: 'small muted nowrap' }, F.relTime(e.at)))));
      logBox.appendChild(h('div', { class: 'small muted', style: { margin: '14px 0 6px' } }, '后台提醒发出的通知（最近 10 条）'));
      logBox.appendChild(list);
    }

    const actions = h('div', { class: 'row', style: { gap: '9px', flexWrap: 'wrap', marginTop: '12px' } },
      a.installed
        ? h('button', { class: 'btn danger', onClick: () => daemonAction(api.autostart.uninstall, '正在取消…') }, '关闭后台提醒')
        : h('button', { class: 'btn primary', onClick: () => daemonAction(api.autostart.install, '正在注册…') }, '开启后台提醒'),
      h('button', { class: 'btn', onClick: async () => {
        SH.toast({ title: '正在试跑巡检…', timeout: 1500 });
        const r = await api.autostart.test();
        SH.modal({
          title: r.ok ? '巡检链路正常' : '巡检报错',
          body: h('div', null,
            h('div', { style: { fontSize: '13.5px', marginBottom: '10px', color: r.ok ? 'var(--text)' : 'var(--danger)' } }, r.message || ''),
            r.raw ? h('pre', { class: 'pv-pre', style: { maxHeight: '300px', overflow: 'auto', background: 'var(--surface-2)', padding: '10px', borderRadius: '8px' } }, r.raw) : null),
          wide: true
        });
      } }, '测试巡检'),
      h('div', { style: { flex: '1' } }),
      h('button', { class: 'btn ghost sm', onClick: () => SH.app.reload() }, '刷新状态'));

    const detail = h('details', { class: 'rev-reveal', style: { marginTop: '12px' } },
      h('summary', null, '它是怎么工作的（技术细节）'),
      h('div', { class: 'small muted', style: { lineHeight: '1.8', paddingTop: '6px' } },
        h('div', null, h('b', null, '机制：'), a.method === 'launchd'
          ? 'macOS LaunchAgent（launchctl），每 ' + Math.round(a.intervalSec / 60) + ' 分钟拉起一次纯 Node 巡检进程'
          : 'Windows 任务计划程序（schtasks），每 ' + Math.round(a.intervalSec / 60) + ' 分钟拉起一次静默巡检'),
        h('div', null, h('b', null, '不会重复提醒：'), '应用运行时会把「我还活着」的心跳写进数据目录；守护看到心跳就主动让位。两边共用的「已触发」记录会互相读取，不会各提醒一次。'),
        h('div', null, h('b', null, '注册位置：'), h('span', { class: 'mono', style: { wordBreak: 'break-all' } }, a.file)),
        h('div', null, h('b', null, '执行命令：'), h('span', { class: 'mono', style: { wordBreak: 'break-all', fontSize: '11.5px' } }, a.execPath + ' ' + a.daemonScript)),
        a.daemonLastError ? h('div', { style: { color: 'var(--danger)' } }, h('b', null, '上次错误：'), a.daemonLastError) : null));

    return card('后台提醒', '关掉应用也能准时提醒', state, explain, actions, logBox, detail);
  }

  async function daemonAction(fn, busyText) {
    SH.toast({ title: busyText, timeout: 1500 });
    const r = await fn();
    SH.modal({
      title: r.ok ? '设置成功' : '设置失败',
      body: h('div', { style: { fontSize: '13.5px', lineHeight: '1.8', whiteSpace: 'pre-wrap', color: r.ok ? 'var(--text)' : 'var(--danger)' } }, r.message || ''),
      wide: true
    });
    SH.app.reload();
  }

  /* ---------------- 复习设置 ---------------- */
  function reviewCard(S, p) {
    const st = S.review || {};
    return card('复习（间隔重复）', '在快要忘记的那一刻复习，性价比最高',
      h('div', { class: 'set-row' },
        h('div', { class: 's-label' }, h('b', null, '当前队列'),
          h('span', null, `待复习 ${(st.dueToday || 0) + (st.overdue || 0)} 个 · 在队列 ${st.active || 0} 个 · 已掌握 ${st.mastered || 0} 个` +
            (st.retention == null ? '' : ` · 记忆保持率 ${st.retention}%`))),
        h('button', { class: 'btn sm', onClick: () => SH.app.go('srs') }, '去复习')),
      SH.switchRow('勾掉计划任务时自动排入复习', '完成一件带资料的任务后，第二天会自动出现一次复习', p.reviewAutoAdd !== false,
        (v) => set({ reviewAutoAdd: v })),
      h('div', { class: 'set-row' },
        h('div', { class: 's-label' }, h('b', null, '固定间隔'),
          h('span', null, '1 / 2 / 4 / 7 / 15 / 30 / 60 天，走完 7 轮视为掌握。间隔按约两倍递增，这是间隔重复的经典取值，不建议改。'))));
  }

  const set = async (patch) => { await api.settings.update(patch); await SH.app.refresh(); };

  /**
   * 卡片外壳。注意用 rest 收集正文 —— 早先写成 (title, desc, body, extra)，
   * 结果多传的字段会被当成 extra 塞进卡片头部，出现「一行里挤着标题和输入框」。
   */
  function card(title, desc, ...children) {
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', null, title),
        desc ? h('span', { class: 'small muted head-desc', title: desc }, desc) : null),
      h('div', { class: 'card-body' }, ...children));
  }

  /* ---------------- 个人 ---------------- */
  function profileCard(S, p) {
    const name = h('input', { class: 'input', value: p.name || '', placeholder: '怎么称呼你（可留空）' });
    name.addEventListener('change', () => set({ name: name.value.trim() }));

    const start = h('select', { class: 'select' },
      ...[[1, '周一'], [0, '周日'], [6, '周六']].map(([v, l]) => h('option', { value: v, selected: Number(p.weekStart) === v }, l + ' 作为一周的开始')));
    start.addEventListener('change', () => set({ weekStart: Number(start.value) }));

    return card('个人', null,
      h('label', { class: 'field' }, h('span', { class: 'lb' }, '称呼'), name),
      h('label', { class: 'field' }, h('span', { class: 'lb' }, '一周从哪天开始'), start,
        h('span', { class: 'hint' }, '影响周报和「本周」的统计口径')));
  }

  /* ---------------- 目标 ---------------- */
  function goalCard(S, p) {
    const daily = h('input', { class: 'input', type: 'number', value: p.dailyGoalMin, min: 10, max: 900, step: 10, style: { width: '90px' } });
    daily.addEventListener('change', () => set({ dailyGoalMin: Number(daily.value) || 120 }));
    const weekly = h('input', { class: 'input', type: 'number', value: p.weeklyGoalMin, min: 30, max: 6000, step: 30, style: { width: '90px' } });
    weekly.addEventListener('change', () => set({ weeklyGoalMin: Number(weekly.value) || 720 }));

    const todayMin = S.overview.todayMinutes;
    const suggest = h('div', { class: 'small muted', style: { marginTop: '10px' } },
      `近 30 天日均 `,
      h('b', null, F.dur(Math.round((S.db.sessions || []).filter((s) => Date.now() - new Date(s.start).getTime() < 30 * 86400000).reduce((a, b) => a + b.minutes, 0) / 30))),
      `，建议把日目标定在实际日均的 1.1 ~ 1.3 倍：够得着，又不轻松。`);

    return card('学习目标', '目标定的太高会直接放弃，定得太低没有拉力',
      h('div', { class: 'set-row' },
        h('div', { class: 's-label' }, h('b', null, '每日目标'), h('span', null, `今天已学 ${F.dur(todayMin)}`)),
        h('div', { class: 'numfield' }, daily, h('span', { class: 'muted' }, '分钟'))),
      h('div', { class: 'set-row' },
        h('div', { class: 's-label' }, h('b', null, '每周目标'), h('span', null, `本周已学 ${F.dur(S.overview.weekMinutes)}`)),
        h('div', { class: 'numfield' }, weekly, h('span', { class: 'muted' }, '分钟'))),
      suggest);
  }

  /* ---------------- 番茄钟 ---------------- */
  function pomodoroCard(S, p) {
    const pom = p.pomodoro;
    const num = (key, label, hint, min, max, step, unit) => {
      const inp = h('input', { class: 'input', type: 'number', value: pom[key], min, max, step: step || 1, style: { width: '80px' } });
      inp.addEventListener('change', () => set({ pomodoro: { [key]: Number(inp.value) || pom[key] } }));
      return h('div', { class: 'set-row' },
        h('div', { class: 's-label' }, h('b', null, label), hint ? h('span', null, hint) : null),
        h('div', { class: 'numfield' }, inp, h('span', { class: 'muted' }, unit)));
    };
    return card('番茄钟', '经典比例是 25 / 5，四轮之后长休一次',
      num('focus', '专注时长', null, 5, 180, 5, '分钟'),
      num('short', '短休息', null, 1, 30, 1, '分钟'),
      num('long', '长休息', null, 5, 60, 5, '分钟'),
      num('roundsBeforeLong', '几轮后长休', '用于计算何时进入长休息', 2, 8, 1, '轮'),
      SH.switchRow('专注结束自动开始休息', '到点直接进入休息倒计时', pom.autoStartBreak, (v) => set({ pomodoro: { autoStartBreak: v } })),
      SH.switchRow('休息结束自动开始专注', '到点直接进入下一轮，适合节奏紧的时候', pom.autoStartFocus, (v) => set({ pomodoro: { autoStartFocus: v } })));
  }

  /* ---------------- 提醒 ---------------- */
  function notifyCard(S, p) {
    const n = p.notify;
    const timeInput = (key, label, hint) => {
      const inp = h('input', { class: 'input', type: 'time', value: n[key], style: { width: '110px' } });
      inp.addEventListener('change', () => set({ notify: { [key]: inp.value } }));
      return h('div', { class: 'set-row' },
        h('div', { class: 's-label' }, h('b', null, label), hint ? h('span', null, hint) : null),
        inp);
    };
    const numInput = (key, label, hint, min, max) => {
      const inp = h('input', { class: 'input', type: 'number', value: n[key], min, max, style: { width: '80px' } });
      inp.addEventListener('change', () => set({ notify: { [key]: Number(inp.value) || n[key] } }));
      return h('div', { class: 'set-row' },
        h('div', { class: 's-label' }, h('b', null, label), hint ? h('span', null, hint) : null),
        h('div', { class: 'numfield' }, inp, h('span', { class: 'muted' }, '分钟')));
    };

    return card('提醒与监督', '系统通知 + 窗口浮层双通道，关掉窗口也会提醒',
      SH.switchRow('开启提醒', '关掉后所有通知（含番茄钟到点）都不再弹出', n.enabled, (v) => set({ notify: { enabled: v } })),
      SH.switchRow('提示音', '关闭后静默弹出', n.sound, (v) => set({ notify: { sound: v } })),
      SH.switchRow('今日任务未完成预警', '到点还没做完，提醒你去收尾', n.taskReminder, (v) => set({ notify: { taskReminder: v } })),
      timeInput('taskReminderTime', '任务预警时间', '过了这个点仍有任务没做完就会提醒'),
      SH.switchRow('每日复盘摘要', '睡前推送今天的学习小结', n.dailyDigest, (v) => set({ notify: { dailyDigest: v } })),
      timeInput('dailyDigestTime', '复盘时间', null),
      numInput('overrunMin', '单段专注过长预警', '连续专注超过这么久就提醒你休息', 30, 300),
      numInput('breakOverrunMin', '休息超时预警', '休息超过这么久就催你回到专注', 3, 60),
      numInput('idleMaterialDays', '资料闲置判定', '多久没打开的视为闲置资料', 3, 365),
      h('div', { class: 'row', style: { marginTop: '12px' } },
        h('button', { class: 'btn', onClick: async () => { await api.notify.test(); } }, '测试通知通道'),
        h('div', { style: { flex: '1' } }),
        h('button', { class: 'btn ghost', onClick: () => SH.app.go('review') }, '看本周复盘')));
  }

  /* ---------------- 科目 ---------------- */
  function subjectCard(S) {
    const body = h('div');
    const list = h('div', { class: 'list' });
    (S.db.subjects || []).forEach((s) => {
      const weekMin = (S.db.sessions || [])
        .filter((x) => x.subjectId === s.id && Date.now() - new Date(x.start).getTime() < 7 * 86400000)
        .reduce((a, b) => a + b.minutes, 0);
      list.appendChild(h('div', { class: 'list-item' },
        h('span', { class: 'subj-dot', style: { background: s.color, width: '12px', height: '12px', flex: '0 0 12px' } }),
        h('div', { style: { flex: '1', minWidth: 0 } },
          h('div', { class: 'li-title' }, s.name),
          h('div', { class: 'li-sub' }, s.goalMinPerWeek ? `周目标 ${F.dur(s.goalMinPerWeek)} · 近 7 天 ${F.dur(weekMin)}` : `未设周目标 · 近 7 天 ${F.dur(weekMin)}`)),
        h('button', { class: 'btn sm ghost', html: SH.icon('edit', 13), onClick: () => editSubject(S, s) }),
        h('button', { class: 'btn sm ghost', html: SH.icon('trash', 13), onClick: async () => {
          const ok = await SH.confirm({ title: `删除科目「${s.name}」？`, message: '历史学习记录会保留，只是不再归到该科目下。', okText: '删除', danger: true });
          if (ok) { await api.subjects.remove(s.id); SH.app.refresh(); }
        } })));
    });
    if (!(S.db.subjects || []).length) body.appendChild(h('div', { class: 'small muted', style: { padding: '8px 0' } }, '还没有科目。加两个最常学的就够了。'));
    body.appendChild(list);
    body.appendChild(h('div', { style: { marginTop: '12px' } },
      h('button', { class: 'btn primary', html: SH.icon('plus', 14) + '<span style="margin-left:4px">添加科目</span>', onClick: () => editSubject(S, null) })));
    return card('科目与周目标', '周目标用来判断「这科是不是被冷落了」', body);
  }

  async function editSubject(S, s) {
    let color = s ? s.color : PALETTE[(S.db.subjects || []).length % PALETTE.length];
    const swatches = h('div', { class: 'seg' });
    const paint = () => {
      SH.clear(swatches);
      PALETTE.forEach((c) => {
        const b = h('button', {
          class: 'btn sm', type: 'button', title: c,
          style: { width: '28px', padding: '0', background: c, borderColor: color === c ? 'var(--text)' : 'transparent', borderWidth: '2px', height: '28px' }
        });
        b.addEventListener('click', () => { color = c; paint(); });
        swatches.appendChild(b);
      });
    };
    paint();

    const body = h('div');
    const nameInput = h('input', { class: 'input', value: s ? s.name : '', placeholder: '例：高等数学' });
    const goalInput = h('input', { class: 'input', type: 'number', value: s ? (s.goalMinPerWeek || 0) : 300, min: 0, max: 3000, step: 30, style: { width: '110px' } });
    body.appendChild(h('label', { class: 'field' }, h('span', { class: 'lb' }, '科目名称'), nameInput));
    body.appendChild(h('label', { class: 'field' }, h('span', { class: 'lb' }, '颜色'), swatches));
    body.appendChild(h('label', { class: 'field' }, h('span', { class: 'lb' }, '每周目标（分钟，可留 0）'), goalInput));

    const mo = SH.modal({
      title: s ? '编辑科目' : '添加科目',
      body,
      footer: [
        h('button', { class: 'btn', onClick: () => mo.close() }, '取消'),
        h('button', { class: 'btn primary', onClick: async () => {
          const name = nameInput.value.trim();
          if (!name) return;
          const payload = { name, color, goalMinPerWeek: Number(goalInput.value) || 0 };
          if (s) await api.subjects.update(s.id, payload);
          else await api.subjects.add(payload);
          mo.close();
          SH.app.refresh();
        } }, '保存')
      ]
    });
    setTimeout(() => nameInput.focus(), 50);
  }

  /* ---------------- 定时提醒 ---------------- */
  function reminderCard(S) {
    const list = h('div', { class: 'list' });
    (S.db.reminders || []).slice().sort((a, b) => a.time.localeCompare(b.time)).forEach((r) => {
      const sub = (S.db.subjects || []).find((z) => z.id === r.subjectId);
      list.appendChild(h('div', { class: 'list-item' },
        h('div', { class: 'mono', style: { fontWeight: '650', fontSize: '15px', width: '54px' } }, r.time),
        h('div', { style: { flex: '1', minWidth: 0 } },
          h('div', { class: 'li-title' }, r.title),
          h('div', { class: 'li-sub row', style: { gap: '8px' } },
            h('span', { class: 'chip' }, REPEAT[r.repeat] || r.repeat),
            r.repeat === 'weekly' && (r.weekdays || []).length ? h('span', null, r.weekdays.map((d) => '周' + F.WD[d]).join('、')) : null,
            sub ? h('span', { class: 'row', style: { gap: '5px' } }, h('span', { class: 'subj-dot', style: { background: sub.color } }), sub.name) : null)),
        h('label', { class: 'switch' },
          h('input', { type: 'checkbox', checked: r.enabled, onChange: async (e) => { await api.reminders.update(r.id, { enabled: e.target.checked }); SH.app.refresh(); } }),
          h('i')),
        h('button', { class: 'btn sm ghost', html: SH.icon('edit', 13), onClick: () => editReminder(S, r) }),
        h('button', { class: 'btn sm ghost', html: SH.icon('trash', 13), onClick: async () => {
          await api.reminders.remove(r.id); SH.app.refresh();
        } })));
    });
    if (!(S.db.reminders || []).length) list.appendChild(h('div', { class: 'card-body small muted' }, '还没有定时提醒。加一个「每天 19:30 开始学习」试试。'));

    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', null, '我的提醒'),
        h('div', { class: 'grow', style: { flex: '1' } }),
        h('button', { class: 'btn primary sm', html: SH.icon('plus', 13) + '<span style="margin-left:4px">新建提醒</span>', onClick: () => editReminder(S, null) })),
      list,
      h('div', { class: 'card-body small muted', style: { borderTop: '1px solid var(--border)' } },
        '提醒需要应用在运行（可以最小化到菜单栏）。到点后会同时发系统通知和窗口浮层；如果那分钟应用没开，15 分钟内重新打开会补一次。'));
  }

  async function editReminder(S, r) {
    const v = await SH.formDialog({
      title: r ? '编辑提醒' : '新建提醒',
      fields: [
        { name: 'title', label: '提醒内容', value: r ? r.title : '开始学习', placeholder: '例：晚自习第一段' },
        { name: 'time', label: '时间', type: 'time', value: r ? r.time : '19:30' },
        { name: 'repeat', label: '重复', type: 'select', value: r ? r.repeat : 'daily', options: Object.entries(REPEAT).map(([k, l]) => ({ value: k, label: l })) },
        { name: 'weekdays', label: '每周哪几天（选「每周」时生效）', type: 'weekdays', value: r ? r.weekdays : [] },
        { name: 'date', label: '日期（选「仅一次」时生效）', type: 'date', value: r ? r.date : F.dayKey() },
        { name: 'type', label: '类型', type: 'select', value: r ? r.type : 'study', options: [{ value: 'study', label: '学习提醒（会带上本周该科时长）' }, { value: 'review', label: '复盘提醒' }, { value: 'custom', label: '自定义' }] },
        { name: 'subjectId', label: '关联科目', type: 'select', value: r ? r.subjectId : '', options: [{ value: '', label: '不指定' }, ...(S.db.subjects || []).map((z) => ({ value: z.id, label: z.name }))] }
      ],
      okText: r ? '保存' : '创建'
    });
    if (!v || !v.title) return;
    if (r) await api.reminders.update(r.id, v);
    else await api.reminders.add(v);
    SH.app.refresh();
  }

  /* ---------------- 数据 ---------------- */
  function dataCard(S, x) {
    const p = S.db.profile;
    const info = x.info;

    const backupList = h('div', { class: 'list', style: { maxHeight: '220px', overflow: 'auto' } });
    x.backups.slice(0, 14).forEach((b) => {
      backupList.appendChild(h('div', { class: 'list-item' },
        h('div', { style: { flex: '1', minWidth: 0 } },
          h('div', { class: 'li-title mono', style: { fontSize: '12.5px' } }, b.name),
          h('div', { class: 'li-sub' }, `${new Date(b.mtime).toLocaleString('zh-CN')} · ${(b.size / 1024).toFixed(1)} KB`)),
        h('button', { class: 'btn sm', onClick: async () => {
          const ok = await SH.confirm({ title: '从这个备份恢复？', message: '当前数据会先被自动备份，然后用这份备份覆盖。', okText: '恢复' });
          if (!ok) return;
          const r = await api.system.restoreBackup(b.name);
          if (r.ok) { SH.toast({ title: '已恢复', kind: 'ok' }); SH.app.refresh(); }
          else SH.toast({ title: '恢复失败', body: r.message, kind: 'warn' });
        } }, '恢复')));
    });

    return h('div', { class: 'grid g2' },
      card('应用行为', null,
        SH.switchRow('开机自动启动', '需要应用本体已经放在固定位置', p.launchAtLogin, async (v) => { await set({ launchAtLogin: v }); }),
        SH.switchRow('关闭窗口时最小化到菜单栏', '关掉后提醒会失效，除非应用仍在托盘运行', p.minimizeToTray, (v) => set({ minimizeToTray: v })),
        h('div', { class: 'set-row' },
          h('div', { class: 's-label' }, h('b', null, '数据目录'), h('span', { class: 'mono', style: { wordBreak: 'break-all' } }, info.dataDir)),
          h('button', { class: 'btn sm', onClick: () => api.system.openPath(info.dataDir) }, '打开')),
        h('div', { class: 'set-row' },
          h('div', { class: 's-label' }, h('b', null, '版本信息'),
            h('span', null, `学习中心 ${info.version} · Electron ${info.electron} · ${info.platform}/${info.arch}`)))),
      card('数据与备份', '每次改动都会实时写盘，每天自动留一份备份',
        h('div', { class: 'set-row' },
          h('div', { class: 's-label' }, h('b', null, '导出 / 导入'), h('span', null, '导出成 JSON 可以换电脑继续用')),
          h('button', { class: 'btn sm', onClick: async () => {
            const r = await api.system.exportData();
            if (r.ok) SH.toast({ title: '已导出', body: r.path, kind: 'ok', timeout: 6000 });
          } }, '导出'),
          h('button', { class: 'btn sm', onClick: async () => {
            const ok = await SH.confirm({ title: '导入数据？', message: '会覆盖当前所有数据（覆盖前自动备份一份）。', okText: '选择文件' });
            if (!ok) return;
            const r = await api.system.importData();
            if (r.ok) { SH.toast({ title: '已导入', kind: 'ok' }); SH.app.refresh(); }
            else if (r.message) SH.toast({ title: '导入失败', body: r.message, kind: 'warn' });
          } }, '导入')),
        h('div', { class: 'set-row' },
          h('div', { class: 's-label' }, h('b', null, '示例数据'), h('span', null, S.db.meta.demo ? '当前包含示例数据（四门科目、一个示例计划和 21 天记录）' : '示例数据已清空')),
          h('button', { class: 'btn sm', onClick: async () => {
            const ok = await SH.confirm({ title: '清空所有数据？', message: '科目、资料、计划、学习记录和提醒都会清空，只保留设置项。清空前会自动备份。', okText: '清空', danger: true });
            if (!ok) return;
            const r = await api.system.clearDemo();
            if (r) { SH.toast({ title: '已清空，可以开始记录自己的了', kind: 'ok' }); SH.app.refresh(); }
          } }, '一键清空')),
        h('div', { style: { marginTop: '10px' } },
          h('div', { class: 'small muted', style: { marginBottom: '6px' } }, `自动备份（最近 ${x.backups.length} 份）`),
          backupList)));
  }
})();
