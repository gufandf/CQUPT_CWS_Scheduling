// 集成测试：排班 / 剪枝 / 渲染 / 导出 / 导入 全链路
const { g, ok, eq, section, summary, localStorage, el, document, writeFiles, rawHtml } = require('./harness.js');

// ── 构造学生课表数据 ──
const mkCourse = (name, weekday, begin, period, weeks, ignored) => ({
  name, courseId: `${name}_d${weekday}_p${begin}`, courseNum: 'C1', teacher: 'T', type: '必修',
  location: '101', rawWeek: '1-16周', weekday, beginPeriod: begin, endPeriod: begin + period - 1,
  periods: Array.from({ length: period }, (_, i) => begin + i), weeks,
  oddWeeks: weeks.filter(w => w % 2 === 1), evenWeeks: weeks.filter(w => w % 2 === 0),
  hasOdd: weeks.some(w => w % 2 === 1), hasEven: weeks.some(w => w % 2 === 0),
  isFullDay: period >= 8, ignored: !!ignored, autoIgnored: false,
});

// ── 后续 then 之间共享的 helper（在 §32 起赋值） ──
let weeklyMaxOf, spreadOf, reRun, reRunLegacyMode;
const setMaxShifts = v => g(`setMaxShiftsPerWeek(${JSON.stringify(v)})`);
// 「限制每人每周班次」开关：上限是否生效只看它，不再看 runSchedule 的参数（见 §32）
const setMaxEnabled = on => g(`setMaxShiftsEnabled(${!!on})`);

function setupStudents() {  const all = Array.from({ length: 16 }, (_, i) => w => true);
  const courses = {
    // 早班(10:00-12:05 → 冲突节次3,4)有课 → 不能排早班
    '2025210001': [mkCourse('高数', 3, 3, 2, [1, 2, 3, 4, 5, 6, 7, 8])],
    // 全周无课
    '2025210002': [], '2025210003': [], '2025210004': [], '2025210005': [],
    '2025210006': [], '2025210007': [], '2025210008': [], '2025210009': [],
    '2025210010': [], '2025210011': [], '2025210012': [], '2025210013': [],
    '2025210014': [], '2025210015': [], '2025210016': [],
  };
  const students = Object.keys(courses).map(sid => ({
    sid, name: '同学' + sid.slice(-4), status: 'ready', courses: courses[sid],
    rawCourses: [], nowWeek: 8,
  }));
  g(`state.students = ${JSON.stringify(students)}`);
  return students;
}

section('9. 排班初始化：按模板生成槽位');
setupStudents();
g('state.template = makeDefaultTemplate()');
g('initAssignments()');
const oddKeys = g('Object.keys(state.assignments.odd)');
// 工作日 6 班 × 5 天 + 周末 4 班 × 2 天 = 38
eq(oddKeys.length, 38, '单周槽位数 = 工作日 6×5 + 周末 4×2 = 38');
eq(g('Object.keys(state.assignments.even).length'), 38, '双周槽位数同样为 38');
ok(oddKeys.includes('odd_d0_wd0'), '含 周一早班 槽位');
ok(oddKeys.includes('odd_d4_wd5'), '含 周五晚班② 槽位');
ok(oddKeys.includes('odd_d5_we0'), '含 周六早班 槽位');
ok(!oddKeys.includes('odd_d5_wd0'), '周末不使用工作日班次定义');

section('10. 单双周班次：只生成对应周的槽位');
g(`state.template = normalizeTemplate({ name:'单双周', groups:{
  weekday:[
    {id:'wdA',label:'单周班',start:'10:00',end:'12:05',capacity:2,weeks:'odd'},
    {id:'wdB',label:'双周班',start:'14:00',end:'15:50',capacity:2,weeks:'even'}
  ],
  weekend:[{id:'weA',label:'通用',start:'10:00',end:'12:00',capacity:1,weeks:'all'}]
}})`);
g('initAssignments()');
const oddK = g('Object.keys(state.assignments.odd)');
const evenK = g('Object.keys(state.assignments.even)');
ok(oddK.includes('odd_d0_wdA'), '单周班在单周生成槽位');
ok(!oddK.includes('odd_d0_wdB'), '双周班不在单周生成槽位');
ok(evenK.includes('even_d0_wdB'), '双周班在双周生成槽位');
ok(!evenK.includes('even_d0_wdA'), '单周班不在双周生成槽位');
ok(oddK.includes('odd_d5_weA') && evenK.includes('even_d5_weA'), '通用班次在单双周都生成');
eq(oddK.filter(k => k.startsWith('odd_d0_')).length, 1, '周一单周仅 1 个槽位（单周班）');
eq(evenK.filter(k => k.startsWith('even_d0_')).length, 1, '周一双周仅 1 个槽位（双周班）');

section('11. 自动排班：冲突检测 + 人数上限 + 公平性');
g('state.template = makeDefaultTemplate()');
g('initAssignments()');
const run = g('(async () => { await runSchedule(); return true; })()');
Promise.resolve(run).then(() => {
  // 11a. 人数不超过 capacity
  const over = g(`(() => {
    const bad = [];
    for (const wt of ['odd','even']) {
      for (const key of Object.keys(state.assignments[wt])) {
        const info = resolveShift(key);
        const cap = info && info.shift.capacity;
        const n = state.assignments[wt][key].length;
        if (n > cap) bad.push({key, n, cap});
      }
    }
    return bad;
  })()`);
  eq(over, [], '任何班次都没有超过模板设定的人数上限');

  // 11b. 冲突学生不被排到有课班次
  const conflictViolations = g(`(() => {
    const bad = [];
    for (const wt of ['odd','even']) {
      for (const key of Object.keys(state.assignments[wt])) {
        const info = resolveShift(key);
        if (!info) continue;
        for (const sid of state.assignments[wt][key]) {
          const st = state.students.find(s => s.sid === sid);
          if (st && hasConflict(st.courses, info.dayIdx + 1, info.shift.conflictPeriods, wt)) {
            bad.push({key, sid});
          }
        }
      }
    }
    return bad;
  })()`);
  eq(conflictViolations, [], '没有把有课的学生排进冲突班次');

  // 11c. 周三早班(第3-4节有课)不应排到 2025210001
  const wedEarly = g("state.assignments.odd['odd_d2_wd0'] || []");
  ok(!wedEarly.includes('2025210001'), '周三第3-4节有课的学生未被排入周三早班');
  // 该生其他天可以排
  const anyOther = g(`(() => {
    for (const wt of ['odd','even'])
      for (const key of Object.keys(state.assignments[wt]))
        if (state.assignments[wt][key].includes('2025210001')) return true;
    return false;
  })()`);
  ok(anyOther, '该学生仍被排到其他无冲突班次（冲突只排除单天）');

  // 11d. 公平性：每人班次数的极差 <= 1
  const spread = g(`(() => {
    const counts = state.students.map(s => getStudentShiftCount(s.sid));
    return { min: Math.min(...counts), max: Math.max(...counts) };
  })()`);
  ok(spread.max - spread.min <= 1, `排班公平：每人班次数极差 ${spread.max - spread.min} ≤ 1`, spread);

  // 11e. 未勾选「限制每人每周班次」开关时，**不套用**每人班次上限
  //      （去掉「均衡排班」按钮后的新语义，见 AGENT.md §4.8）
  const weeklyLoads = g(`(() => {
    const out = [];
    for (const wt of ['odd','even']) {
      const load = {};
      for (const key of Object.keys(state.assignments[wt])) {
        for (const sid of state.assignments[wt][key]) load[sid] = (load[sid]||0)+1;
      }
      out.push(Math.max(0, ...Object.values(load)));
    }
    return out;
  })()`);
  ok(weeklyLoads.some(n => n > 0), `开始排班确实排了班（单周最多 ${weeklyLoads[0]}、双周最多 ${weeklyLoads[1]}）`);
  setMaxEnabled(false);
  setMaxShifts(1);   // 开关未勾选 → 这个 1 不该起作用，否则每人每周最多只能 1 班
  g('initAssignments()');
  return Promise.resolve(g('(async () => { await runSchedule(); return true; })()'));
}).then(() => {
  const capped1 = g(`(() => {
    const load = {};
    for (const key of Object.keys(state.assignments.odd)) {
      for (const sid of state.assignments.odd[key]) load[sid] = (load[sid]||0)+1;
    }
    return Math.max(0, ...Object.values(load));
  })()`);
  ok(capped1 > 1, `开关未勾选时忽略上限 1（实际仍出现每人每周 ${capped1} 班）`);

  section('12. 自定义模板：增减班次后重新排班');
  setMaxShifts(3);
  setMaxEnabled(false);
  g(`state.template = normalizeTemplate({ name:'两班制', groups:{
    weekday:[
      {id:'m',label:'上午',start:'08:00',end:'12:00',capacity:4},
      {id:'a',label:'下午',start:'14:00',end:'18:00',capacity:4}
    ],
    weekend:[{id:'w',label:'全天',start:'09:00',end:'17:00',capacity:3}]
  }})`);
  g('initAssignments()');
  return Promise.resolve(g('(async () => { await runSchedule(); return true; })()'));
}).then(() => {
  const keys = g('Object.keys(state.assignments.odd)');
  eq(keys.length, 2 * 5 + 1 * 2, '自定义模板：2班×5天 + 1班×2天 = 12 个槽位');
  const caps = g(`(() => {
    const out = {};
    for (const key of Object.keys(state.assignments.odd)) {
      const info = resolveShift(key);
      out[info.shift.label] = info.shift.capacity;
    }
    return out;
  })()`);
  eq(caps['上午'], 4, '自定义「上午」班次人数上限 4 生效');
  eq(caps['下午'], 4, '自定义「下午」班次人数上限 4 生效');

  const full = g("(state.assignments.odd['odd_d0_m']||[]).length");
  eq(full, 4, `自定义「上午」班次排满 4 人（08:00-12:00 与第1-4节冲突，仅无课者可选）`);

  section('13. 模板变更 → 失效排班剪枝（核心防错位验证）');
  // 用默认模板排好班
  g('state.template = makeDefaultTemplate()');
  g('initAssignments()');
  return Promise.resolve(g('(async () => { await runSchedule(); return true; })()'));
}).then(() => {
  const before = g('JSON.stringify(state.assignments.odd["odd_d0_wd0"])');
  ok(JSON.parse(before).length === 2, '默认模板下 周一早班 排了 2 人');

  // 场景 A：删除「早班」→ 其排班应被清除，其他班次保留
  const otherBefore = g("JSON.stringify(state.assignments.odd['odd_d0_wd1'])");
  g(`state.template = normalizeTemplate((() => {
    const t = makeDefaultTemplate();
    t.groups.weekday = t.groups.weekday.filter(s => s.id !== 'wd0');
    return t;
  })())`);
  g('persistTemplate()');
  const dropped = g('pruneInvalidAssignments()');
  ok(dropped.length > 0, `删除班次后剪枝清除了 ${dropped.length} 处失效排班`);
  eq(g("state.assignments.odd['odd_d0_wd0']"), undefined, '被删除班次的排班已清除');
  eq(g("JSON.stringify(state.assignments.odd['odd_d0_wd1'])"), otherBefore, '其他班次的排班完整保留');
  eq(g("Object.keys(state.assignments.odd).filter(k => k.includes('wd0')).length"), 0, '不再残留 wd0 键');

  section('14. 关键防错位验证：新增班次不会错占他人排班');
  // 场景 B：在默认模板基础上"插入"一个更早的班次（旧实现按下标索引必然错位）
  g('state.template = makeDefaultTemplate()');
  g('initAssignments()');
  return Promise.resolve(g('(async () => { await runSchedule(); return true; })()'));
}).then(() => {
  const earlyBefore = g("JSON.stringify(state.assignments.odd['odd_d0_wd0'])");   // 早班 10:00-12:05
  const noonBefore = g("JSON.stringify(state.assignments.odd['odd_d0_wd1'])") ;  // 午班① 12:05-13:45

  // 在最前面插入一个 08:00-10:00 的新班次
  g(`state.template = normalizeTemplate((() => {
    const t = makeDefaultTemplate();
    t.groups.weekday.unshift({ id:'newEarly', label:'新增早班', start:'08:00', end:'10:00', capacity:2, weeks:'all' });
    return t;
  })())`);
  g('persistTemplate()');
  g('pruneInvalidAssignments()');

  eq(g("JSON.stringify(state.assignments.odd['odd_d0_wd0'])"), earlyBefore,
     '插入新班次后，原「早班」排班仍归属早班（旧按下标实现会整体错位到新班次）');
  eq(g("JSON.stringify(state.assignments.odd['odd_d0_wd1'])"), noonBefore,
     '插入新班次后，原「午班①」排班仍归属午班①');
  eq(g("state.assignments.odd['odd_d0_newEarly']"), [], '新班次槽位为空，等待排班');

  const info = g("resolveShift('odd_d0_wd0')");
  eq(info.shift.label, '早班', '键 odd_d0_wd0 仍解析为「早班」');
  eq(info.shift.start, '10:00', '早班开始时间未被改动');

  section('15. 单双周改为仅单周 → 双周排班被清除');
  g('state.template = makeDefaultTemplate()');
  g('initAssignments()');
  return Promise.resolve(g('(async () => { await runSchedule(); return true; })()'));
}).then(() => {
  const evenBefore = g("JSON.stringify(state.assignments.even['even_d0_wd0'])");
  ok(JSON.parse(evenBefore).length > 0, '双周 周一早班 原本有排班');
  g(`state.template = normalizeTemplate((() => {
    const t = makeDefaultTemplate();
    t.groups.weekday.find(s => s.id === 'wd0').weeks = 'odd';
    return t;
  })())`);
  const dropped = g('pruneInvalidAssignments()');
  eq(g("state.assignments.even['even_d0_wd0']"), undefined, '双周排班已随「改为仅单周」清除');
  ok(g("state.assignments.odd['odd_d0_wd0']") !== undefined, '单周排班保留');
  ok(dropped.length > 0, '剪枝生效');

  section('16. 渲染：网格骨架与分组');
  g(`state.currentView='duty'; state.currentWeek='odd';`);
  g('renderSchedule()');
  const html = el('scheduleContainer').innerHTML;
  ok(html.includes('周一至周五'), '值班表渲染含「周一至周五」分组行');
  ok(html.includes('周六至周日'), '值班表渲染含「周六至周日」分组行');
  ok(html.includes('早班'), '渲染含班次名称');
  ok(html.includes('odd_d0_wd0'), '渲染含稳定 id 的槽位键');
  const cells = (html.match(/class="shift-cell[^"]*" data-key/g) || []).length;
  eq(cells, 38, '有效班次格 38 个（工作日 5天×6班=30 + 周末 2天×4班=8）');
  eq((html.match(/shift-cell void/g) || []).length, 32, '跨分组占位格 32 个（工作日6班×周末2天=12 + 周末4班×工作日5天=20）');
  eq(cells + 32, 70, '总格数 70 = 工作日 6×7 + 周末 4×7，无遗漏无重复');

  section('17. 空课表渲染');
  g('renderFreeSchedule()');
  const freeHtml = el('freeContainer').innerHTML;
  ok(freeHtml.includes('周一至周五') && freeHtml.includes('周六至周日'), '空课表含两个分组');
  ok(freeHtml.includes('全员空闲'), '无课学生显示「全员空闲」');
  ok(freeHtml.includes('2025210001') === false, '空课表不显示学号（只显示姓名）');

  section('18. 分组独立：工作日与周末班次数不同也能正确渲染');
  g(`state.template = normalizeTemplate({ name:'不对称', groups:{
    weekday:[{id:'a',label:'W1',start:'09:00',end:'10:00',capacity:1},
             {id:'b',label:'W2',start:'11:00',end:'12:00',capacity:1},
             {id:'c',label:'W3',start:'13:00',end:'14:00',capacity:1},
             {id:'d',label:'W4',start:'15:00',end:'16:00',capacity:1},
             {id:'e',label:'W5',start:'17:00',end:'18:00',capacity:1}],
    weekend:[{id:'z',label:'E1',start:'10:00',end:'11:00',capacity:1}]
  }})`);
  g('initAssignments()');
  // renderSchedule 在完全无排班时会提前返回，这里放入最小排班以触发渲染
  g("state.assignments.odd['odd_d0_a']=['S1']");
  g('renderSchedule()');
  const h2 = el('scheduleContainer').innerHTML;
  ok(h2.includes('W5'), '工作日第5个班次正常渲染');
  ok(h2.includes('E1'), '周末唯一班次正常渲染');
  ok(h2.includes('void'), '周末列在工作日行渲染为占位格（void）');
  eq(g('Object.keys(state.assignments.odd).length'), 5 * 5 + 1 * 2, '不对称模板槽位数 = 5×5 + 1×2 = 27');

  section('19. Excel 导出：变长班次集合');
  writeFiles.length = 0;
  g('state.template = makeDefaultTemplate()');
  g('initAssignments()');
  return Promise.resolve(g('(async () => { await runSchedule(); return true; })()'));
}).then(() => {
  writeFiles.length = 0;
  g('exportDutySchedule()');
  eq(writeFiles.length, 1, '导出值班表调用了一次 XLSX.writeFile');
  const wb = writeFiles[0].wb;
  eq(wb.SheetNames, ['单周值班表', '双周值班表', '人员表'], '含单周/双周值班表 + 人员表三个工作表');
  const rows = wb.Sheets['单周值班表'].rows;
  const flat = rows.map(r => r.join('|'));
  ok(flat.some(r => r.includes('周一至周五')), '值班表含工作日分段行');
  ok(flat.some(r => r.includes('周六至周日')), '值班表含周末分段行');
  ok(flat.some(r => r.startsWith('早班 10:00-12:05')), '含班次名与时间');
  ok(flat.some(r => r.startsWith('晚班② 19:45-21:35')), '含最后一个班次');
  eq(rows.filter(r => r[0] && r[0].includes('早班 10:00-12:05')).length, 1, '同一班次仅一行');
  ok(rows[0][0] === '时间段' && rows[0].length === 9, '表头 时间段 + 7天 + 人数');
  ok(rows.some(r => r[r.length - 1] === 2), '末列写出该班次人数');

  // 空课表依赖 ready 学生，此处补一名无课学生
  g("state.students = [{sid:'2025210002',name:'同学0002',status:'ready',courses:[],rawCourses:[],nowWeek:8}]");
  writeFiles.length = 0;
  g('exportFreeSchedule()');
  eq(writeFiles.length, 1, '导出空课表调用了一次 XLSX.writeFile');
  eq(writeFiles[0].wb.SheetNames, ['单周空课表', '双周空课表'], '含单周/双周空课表');
  const freeRows = writeFiles[0].wb.Sheets['单周空课表'].rows;
  ok(freeRows.some(r => r.join('|').includes('同学0002')), '空课表写出空闲学生姓名');
  ok(freeRows.some(r => r.join('|').includes('周一至周五')), '空课表含工作日分段行');
  ok(freeRows.some(r => r.join('|').includes('周六至周日')), '空课表含周末分段行');

  section('20. 数据导出/导入往返（含模板）');
  g('exportData()');
  // exportData 通过 Blob+URL 下载，这里直接检查其组装的数据对象
  const exported = g(`JSON.stringify({
    version: 3, template: state.template, assignments: state.assignments,
    students: state.students.map(s => ({ sid: s.sid, name: s.name, rawCourses: s.rawCourses || [], ignoredCourses: [] }))
  })`);
  const parsed = JSON.parse(exported);
  ok(parsed.template && parsed.template.groups.weekday.length === 6, '导出数据内含完整模板');
  eq(parsed.version, 3, '数据版本号升到 3（含模板）');

  // 模拟导入：改内存为空白后按导出内容恢复
  const beforeOdd = g("JSON.stringify(state.assignments.odd['odd_d0_wd0'])");
  g('state.assignments = { odd:{}, even:{} }; state.template = normalizeTemplate({});');
  // 走真实的导入逻辑（handleImportFile 内部流程）
  g(`(function(){
    const data = ${exported};
    if (data.template) { state.template = normalizeTemplate(data.template); persistTemplate(); }
    state.assignments = data.assignments;
    remapAssignmentIds(_idRemap);
    pruneInvalidAssignments();
    state.students = data.students.map(s => ({ sid:s.sid, name:s.name, status:'ready', courses:[], rawCourses:s.rawCourses }));
  })()`);
  eq(g("JSON.stringify(state.assignments.odd['odd_d0_wd0'])"), beforeOdd, '导入后 周一早班 排班完整恢复');
  eq(g('state.template.groups.weekday.length'), 6, '导入后模板完整恢复');
  ok(g('state.students.length') > 0, '导入后学生列表恢复');
  eq(g('state.students[0].name'), '同学0002', '导入后学生姓名恢复');
  eq(g('state.students[0].status'), 'ready', '有课表数据的学生导入后为 ready 状态');

  section('21. 向后兼容：导入旧版（无 template 字段）数据文件');
  const legacy = g(`JSON.stringify({
    version: 2,
    students: [{ sid:'2025210001', name:'老王', rawCourses: [], ignoredCourses: [] }],
    assignments: { odd: { 'odd_d0_wd0': ['2025210001'] }, even: {} }
  })`);
  g('state.template = makeDefaultTemplate(); state.assignments = { odd:{}, even:{} };');
  g(`(function(){
    const data = ${legacy};
    if (data.template) { state.template = normalizeTemplate(data.template); }
    state.assignments = data.assignments;
    remapAssignmentIds(_idRemap);
    pruneInvalidAssignments();
  })()`);
  eq(g("state.assignments.odd['odd_d0_wd0']"), ['2025210001'], '旧版数据（下标式键 wd0 恰好同名）排班保留');
  eq(g('state.template.groups.weekday.length'), 6, '无 template 字段时沿用当前默认模板');

  section('22. 未知键剪枝：导入含无效班次的数据');
  g('state.template = makeDefaultTemplate();');
  g(`state.assignments = { odd: {
    'odd_d0_wd0': ['A'],
    'odd_d0_wdGONE': ['B'],
    'odd_d3_we9': ['C'],
    'odd_d9_wd0': ['D'],
    'bad_key': ['E'],
    'odd_d0': ['F']
  }, even: {} }`);
  const pruned = g('pruneInvalidAssignments()');
  eq(g("state.assignments.odd['odd_d0_wd0']"), ['A'], '合法排班保留');
  eq(g("state.assignments.odd['odd_d0_wdGONE']"), undefined, '已删除班次的排班被清除');
  eq(g("state.assignments.odd['odd_d3_we9']"), undefined, '周末班次放到工作日的非法键被清除');
  eq(g("state.assignments.odd['odd_d9_wd0']"), undefined, '越界星期被清除');
  eq(g("state.assignments.odd['bad_key']"), undefined, '格式错误的键被清除');
  eq(g("state.assignments.odd['odd_d0']"), undefined, '残缺键被清除');
  eq(pruned.length, 5, '共剪枝 5 处失效数据');
  ok(pruned.includes('odd_d0_wdGONE') && pruned.includes('odd_d9_wd0'), '剪枝返回值含被清除的键名（可用于提示用户）');

  section('23. 模板校验：非法输入被拦截');
  // 说明：normalizeTemplate 在导入阶段就会丢弃 start>=end 的班次；
  // 编辑器中时间是被直接改到草稿上的，由 validateDraft 负责拦截。此处走真实编辑路径。
  g('state.tplDraft = makeDefaultTemplate()');
  g("tplUpdate('weekday',0,'start','23:00')");
  let errs = g('validateDraft()');
  ok(errs.some(e => e.includes('结束时间必须晚于开始时间')), '倒置时间（结束早于开始）被校验拦截');
  eq(errs.length, 1, '倒置时间只报 1 条错误');
  g("tplUpdate('weekday',0,'start','10:00')");
  eq(g('validateDraft()'), [], '时间改回后校验通过');
  errs = g('validateDraft()');

  g(`state.tplDraft = normalizeTemplate({ name:'', groups:{
    weekday:[{id:'x',label:'X',start:'10:00',end:'12:00',capacity:1}],
    weekend:[{id:'y',label:'Y',start:'10:00',end:'12:00',capacity:1}]
  }})`);
  state_tplDraft_name_blank: {
    g("state.tplDraft.name = ''");
    errs = g('validateDraft()');
    ok(errs.some(e => e.includes('名称')), '空模板名被拦截');
  }

  // 全部班次停用
  g(`state.tplDraft = normalizeTemplate({ name:'停用', groups:{
    weekday:[{id:'x',label:'X',start:'10:00',end:'12:00',capacity:1,enabled:false}],
    weekend:[{id:'y',label:'Y',start:'10:00',end:'12:00',capacity:1}]
  }})`);
  errs = g('validateDraft()');
  ok(errs.some(e => e.includes('停用')), '整组停用被拦截');

  // 单双周只覆盖一周：现在是**合法配置**（用户明确要求允许），只提示不拦截
  g(`state.tplDraft = normalizeTemplate({ name:'周次', groups:{
    weekday:[{id:'x',label:'X',start:'10:00',end:'12:00',capacity:1,weeks:'odd'}],
    weekend:[{id:'y',label:'Y',start:'10:00',end:'12:00',capacity:1}]
  }})`);
  errs = g('validateDraft()');
  eq(errs, [], '工作日仅单周有班次 → 不再被拦截（合法）');
  ok(g('templateWarnings()').some(w => w.includes('双周')), '仍给出「双周不排班」提示');
  eq(g("groupWeekScope(state.tplDraft.groups.weekday)"), 'odd', '该分组被识别为「仅单周」');
  eq(g("groupWeekScope(state.tplDraft.groups.weekend)"), 'all', '周末组覆盖单双周');
  eq(g("hasShiftsForWeek('odd', state.tplDraft)"), true, '单周有生效班次');
  eq(g("hasShiftsForWeek('even', state.tplDraft)"), true, '双周在周末组仍有生效班次');

  // 整个模板只有单周班次 → 仍然合法，但提示双周空表
  g(`state.tplDraft = normalizeTemplate({ name:'仅单周', groups:{
    weekday:[{id:'x',label:'X',start:'10:00',end:'12:00',capacity:1,weeks:'odd'}],
    weekend:[{id:'y',label:'Y',start:'10:00',end:'12:00',capacity:1,weeks:'odd'}]
  }})`);
  eq(g('validateDraft()'), [], '全模板仅单周 → 合法');
  eq(g("hasShiftsForWeek('even', state.tplDraft)"), false, '双周确实没有任何生效班次');
  ok(g('templateWarnings()').some(w => w.includes('双周没有任何生效班次')), '提示整周空表');

  // 合法模板
  g(`state.tplDraft = normalizeTemplate(makeDefaultTemplate())`);
  eq(g('validateDraft()'), [], '默认模板校验通过（无错误）');

  section('24. 编辑器草稿操作');
  g('state.tplDraft = makeDefaultTemplate()');
  const n0 = g("state.tplDraft.groups.weekday.length");
  g("tplAddShift('weekday')");
  eq(g("state.tplDraft.groups.weekday.length"), n0 + 1, '添加班次：工作日 +1');
  g("tplDuplicateShift('weekday',0)");
  eq(g("state.tplDraft.groups.weekday.length"), n0 + 2, '复制班次：工作日再 +1');
  ok(g("state.tplDraft.groups.weekday[1].label.includes('副本')"), '复制出的班次名称带「(副本)」');
  ok(g("state.tplDraft.groups.weekday[0].id !== state.tplDraft.groups.weekday[1].id"), '复制出的班次 id 唯一');

  // 上下移动
  const firstLabel = g("state.tplDraft.groups.weekend[0].label");
  g("tplMoveShift('weekend',0,1)");
  ok(g("state.tplDraft.groups.weekend[1].label") === firstLabel, '下移：原第 1 个变为第 2 个');
  g("tplMoveShift('weekend',1,-1)");
  ok(g("state.tplDraft.groups.weekend[0].label") === firstLabel, '上移：恢复原位');

  // 冲突节次手工切换
  g("state.tplDraft = makeDefaultTemplate(); tplTogglePeriod('weekday',0,7)");
  ok(g("state.tplDraft.groups.weekday[0].autoConflict") === false, '手工点选节次后转为手工模式');
  ok(g("state.tplDraft.groups.weekday[0].conflictPeriods.includes(7)"), '新增节次 7 已加入');
  g("tplTogglePeriod('weekday',0,7)");
  ok(g("state.tplDraft.groups.weekday[0].conflictPeriods.includes(7)") === false, '再次点击取消节次 7');
  g("tplRederivePeriods('weekday',0)");
  ok(g("state.tplDraft.groups.weekday[0].autoConflict") === true, '「恢复自动」回到自动模式');
  eq(g("state.tplDraft.groups.weekday[0].conflictPeriods"), [3, 4], '恢复自动后按时间推导回 [3,4]');

  // 时间变更时自动重算
  g("state.tplDraft = makeDefaultTemplate();");
  g("tplUpdate('weekday',0,'start','08:00')");
  ok(g("state.tplDraft.groups.weekday[0].conflictPeriods.includes(1)"), '自动模式下改开始时间 → 冲突节次同步重算（含第1节）');
  // 手工模式下改时间不覆盖用户选择
  g("state.tplDraft = makeDefaultTemplate(); tplTogglePeriod('weekday',0,7);");
  const manualPeriods = g("JSON.stringify(state.tplDraft.groups.weekday[0].conflictPeriods)");
  g("tplUpdate('weekday',0,'start','08:00')");
  eq(g("JSON.stringify(state.tplDraft.groups.weekday[0].conflictPeriods)"), manualPeriods,
     '手工模式下改时间不覆盖用户手工指定的节次');

  // 停用切换
  g("tplToggleEnabled('weekday',0)");
  ok(g("state.tplDraft.groups.weekday[0].enabled") === false, '停用切换生效');

  // 人数
  g("tplUpdate('weekday',0,'capacity','5')");
  eq(g("state.tplDraft.groups.weekday[0].capacity"), 5, '人数改为 5');
  g("tplUpdate('weekday',0,'capacity','0')");
  eq(g("state.tplDraft.groups.weekday[0].capacity"), 1, '人数 0 被钳制为 1');
  g("tplUpdate('weekday',0,'capacity','abc')");
  eq(g("state.tplDraft.groups.weekday[0].capacity"), 1, '非法人数回退为 1');

  section('25. 渲染编辑器 HTML');
  g('state.tplDraft = makeDefaultTemplate()');
  g('renderTemplateEditor()');
  const ed = el('tplBody').innerHTML;
  ok(ed.includes('周一至周五') && ed.includes('周六至周日'), '编辑器含两个分组');
  ok(ed.includes('tplAddShift'), '编辑器含「添加班次」按钮');
  ok(ed.includes('type="time"'), '编辑器含时间选择控件');
  ok(ed.includes('tpl-num'), '编辑器含人数输入框');
  ok(ed.includes('仅单周') && ed.includes('仅双周'), '编辑器含单双周选择');
  ok(ed.includes('冲突课程节次'), '编辑器含冲突节次区');
  ok(ed.includes('自动推导'), '编辑器显示自动推导模式徽章');
  ok(ed.includes('tplRederiveAll'), '编辑器含「全部自动推导」按钮');
  ok(ed.includes('tplRemoveShift') && ed.includes('tplDuplicateShift'), '编辑器含删除/复制班次按钮');
  ok(ed.includes('tplMoveShift'), '编辑器含排序按钮');

  section('26. 保存模板：应用 + 剪枝 + 持久化');
  g('state.template = makeDefaultTemplate(); initAssignments();');
  g("state.assignments.odd['odd_d0_wd0'] = ['S1'];");
  g(`state.tplDraft = normalizeTemplate((() => {
    const t = makeDefaultTemplate();
    t.name = '保存测试';
    t.groups.weekday = t.groups.weekday.filter(s => s.id !== 'wd0');   // 删掉早班
    return t;
  })())`);
  g('saveTemplateEditor()');
  eq(g('state.template.name'), '保存测试', '保存后新模板生效');
  eq(g('state.tplDraft'), null, '保存后草稿被清空');
  eq(g('state.assignments.odd["odd_d0_wd0"]'), undefined, '被删班次的排班已清除');
  ok(!!localStorage.getItem('shift_duty_template_v1'), '保存后写入 localStorage');
  ok(JSON.parse(localStorage.getItem('shift_duty_template_v1')).name === '保存测试', 'localStorage 内容为新模板');

  section('27. 取消编辑不影响生效模板');
  g('state.template = makeDefaultTemplate()');
  const tplBefore = g('JSON.stringify(state.template)');
  g('openTemplateEditor()');
  g("tplAddShift('weekday'); tplAddShift('weekend')");
  g('closeTemplateEditor()');
  eq(g('JSON.stringify(state.template)'), tplBefore, '取消后生效模板未被修改');
  eq(g('state.tplDraft'), null, '取消后草稿被清空');

  section('28. 删除有排班的班次：走确认流程');
  g('state.template = makeDefaultTemplate(); initAssignments();');
  g("state.assignments.odd['odd_d0_wd0'] = ['S1','S2'];");
  g('state.tplDraft = makeDefaultTemplate()');
  const lenBefore = g("state.tplDraft.groups.weekday.length");
  // 有排班时点击删除 → 先弹出确认框，草稿尚未改变
  g("tplRemoveShift('weekday',0)");
  eq(g("state.tplDraft.groups.weekday.length"), lenBefore, '有排班时删除先弹确认，草稿暂不变');
  eq(el('confirmModal').classList.contains('show'), true, '有排班时删除 → 弹出确认框');
  eq(el('confirmTitle').textContent, '删除班次', '确认框标题正确');
  g('closeConfirm()');
  eq(el('confirmModal').classList.contains('show'), false, '取消后确认框关闭');
  // 无排班时直接删除
  g("state.assignments = { odd:{}, even:{} }");
  g("tplRemoveShift('weekday',0)");
  eq(g("state.tplDraft.groups.weekday.length"), lenBefore - 1, '无排班时直接删除');

  section('29. 恢复默认模板');
  g('state.template = normalizeTemplate({ name:"自定义", groups:{ weekday:[{id:"only",label:"唯一",start:"09:00",end:"10:00",capacity:1}], weekend:[] } })');
  g('openTemplateEditor()');
  eq(g("state.tplDraft.groups.weekday.length"), 1, '草稿反映当前自定义模板');
  g('state.tplDraft = makeDefaultTemplate()');   // resetTemplateToDefault 的确认回调体
  eq(g("state.tplDraft.groups.weekday.length"), 6, '恢复默认后草稿为 6 个工作日班次');
  eq(g("state.tplDraft.groups.weekend.length"), 4, '恢复默认后草稿为 4 个周末班次');
  g('closeTemplateEditor()');

  section('30. 时间冲突边界（半开区间语义）');
  // 班次 10:00-11:10 与第4节 11:10-11:55 首尾相接 → 不冲突
  eq(g("deriveConflictPeriods('10:00','11:10')"), [3], '10:00-11:10 → [3]（第4节11:10起，不相接冲突）');
  eq(g("deriveConflictPeriods('11:10','11:55')"), [4], '11:10-11:55 → 恰好第4节');
  eq(g("deriveConflictPeriods('11:00','11:10')"), [], '课间 11:00-11:10 → 无冲突');
  eq(g("deriveConflictPeriods('08:45','08:55')"), [], '两节课之间 08:45-08:55 → 无冲突');
  eq(g("deriveConflictPeriods('08:00','08:56')"), [1, 2], '08:00-08:56 跨第1、2节 → [1,2]');

  return true;
}).then(() => {
  section('31. 排班键与模板一致性（无孤儿数据）');
  g('state.template = makeDefaultTemplate(); initAssignments();');
  const orphans = g(`(() => {
    const bad = [];
    for (const wt of ['odd','even']) {
      for (const key of Object.keys(state.assignments[wt])) {
        const info = resolveShift(key);
        if (!info) { bad.push(key); continue; }
        if (!shiftAppliesToWeek(info.shift, wt)) bad.push(key + '(周次不匹配)');
      }
    }
    return bad;
  })()`);
  eq(orphans, [], 'initAssignments 后不存在孤儿键');
  return true;
}).then(() => {
  // ══════════════════════════════════════════════════════════
  //  每人每周班次上限 + 两种排班模式
  //  注意：这些 helper 定义在模块作用域之外的 then 回调里，后续 then 也要用，
  //  因此挂在模块级变量上（局部 const 在下一个 then 里不可见）。
  // ══════════════════════════════════════════════════════════
  weeklyMaxOf = wt => g(`(() => {
    const load = {};
    for (const key of Object.keys(state.assignments.${wt})) {
      for (const sid of state.assignments.${wt}[key]) load[sid] = (load[sid]||0)+1;
    }
    return Object.values(load).length ? Math.max(...Object.values(load)) : 0;
  })()`);
  spreadOf = () => g(`(() => {
    const sids = state.students.map(s => s.sid);
    const s = loadStats(state.assignments, sids);
    return { odd: s.oddSpread, even: s.evenSpread, total: s.totalSpread };
  })()`);
  reRun = () => Promise.resolve(
    g('(async () => { await runSchedule(); return true; })()'));
  // 故意用旧签名调用：runSchedule 现在没有参数，旧 mode 参数必须被完全忽略
  reRunLegacyMode = mode => Promise.resolve(
    g(`(async () => { await runSchedule(${JSON.stringify(mode)}); return true; })()`));

  // ── 上限参数的读取 / 归一化 / 开关三态 ──
  section('32. 「每人每周最多班次」参数的语义');
  // 先清掉可能残留的存档，验证「无存档」时的默认状态
  g('localStorage.removeItem("shift_max_per_week"); localStorage.removeItem("shift_max_enabled");');
  g('state.maxShiftsPerWeek = 99; state.maxShiftsEnabled = true;');   // 故意写成非默认，验证 loadMaxShifts 会覆盖
  g('loadMaxShifts()');
  eq(g('getMaxShiftsPerWeek()'), 3, '无存档时数值回落默认值 3');
  eq(g('state.maxShiftsEnabled'), false, '无存档时「限制每人每周班次」开关默认不勾选（false）');

  g('state.maxShiftsPerWeek = 0');
  eq(g('getMaxShiftsPerWeek()'), 0, '0 被如实读回');
  eq(g('maxShiftsLimit()'), null, '未勾选开关 → maxShiftsLimit 为 Infinity（JSON 序列化后为 null）');
  ok(g('maxShiftsLimit() === Infinity'), '未勾选开关确实映射为 Infinity（不限制）');
  g('state.maxShiftsPerWeek = 2');
  eq(g('maxShiftsLimit()'), null, '未勾选开关时无论数值多少都不限制（Infinity）');
  setMaxEnabled(true);
  eq(g('maxShiftsLimit()'), 2, '勾选开关 → 数值 2 如实作为上限');
  g('state.maxShiftsPerWeek = 0');
  eq(g('maxShiftsLimit()'), null, '勾选开关但数值为 0 → 仍视为不限制（Infinity）');
  ok(g('maxShiftsLimit() === Infinity'), '勾选开关 + 数值 0 确实映射为 Infinity');
  setMaxEnabled(false);
  eq(g('maxShiftsLimit()'), null, '再取消勾选 → 又回到不限制（Infinity）');
  ok(g('maxShiftsLimit() === Infinity'), '取消勾选后上限立即失效');

  g('state.maxShiftsPerWeek = -5');
  eq(g('getMaxShiftsPerWeek()'), 3, '负数回落为默认值 3');
  g('state.maxShiftsPerWeek = "abc"');
  eq(g('getMaxShiftsPerWeek()'), 3, '非法值回落为默认值 3');

  // setMaxShiftsPerWeek 的归一化：0 / 负数 / 非法值一律回落到 MAX_SHIFTS_DEFAULT(3)
  // （数值框最小为 1，0 不再表示「不限制」；不限制改由开关表达）
  setMaxShifts('0');
  eq(g('state.maxShiftsPerWeek'), 3, "setMaxShiftsPerWeek('0') 回落为默认值 3（0 不再表示不限制）");
  eq(g('MAX_SHIFTS_DEFAULT'), 3, 'MAX_SHIFTS_DEFAULT 仍为 3');
  setMaxShifts('-5');
  eq(g('state.maxShiftsPerWeek'), 3, "setMaxShiftsPerWeek('-5') 回落为默认值 3");
  setMaxShifts('abc');
  eq(g('state.maxShiftsPerWeek'), 3, "setMaxShiftsPerWeek('abc') 回落为默认值 3");
  setMaxShifts('7');
  eq(g('state.maxShiftsPerWeek'), 7, 'setMaxShiftsPerWeek 写入 state');
  eq(localStorage.getItem('shift_max_per_week'), '7', '上限持久化到 localStorage');
  setMaxShifts('200');
  eq(g('state.maxShiftsPerWeek'), 99, "setMaxShiftsPerWeek('200') 被上限 99 钳制");
  eq(g('getMaxShiftsPerWeek()'), 99, 'getMaxShiftsPerWeek 同样以 99 封顶');

  // 开关本身的持久化：'1' / '0'，且重新 load 能读回
  setMaxEnabled(true);
  eq(g('state.maxShiftsEnabled'), true, 'setMaxShiftsEnabled(true) 写入 state');
  eq(localStorage.getItem('shift_max_enabled'), '1', "勾选后 localStorage['shift_max_enabled'] === '1'");
  setMaxEnabled(false);
  eq(localStorage.getItem('shift_max_enabled'), '0', "取消勾选后 localStorage['shift_max_enabled'] === '0'");
  setMaxEnabled(true);
  g('state.maxShiftsEnabled = false; loadMaxShifts();');
  eq(g('state.maxShiftsEnabled'), true, 'loadMaxShifts 从 localStorage 读回勾选状态');
  setMaxShifts('7');
  g('state.maxShiftsPerWeek = 3');
  g('loadMaxShifts()');
  eq(g('state.maxShiftsPerWeek'), 7, 'loadMaxShifts 从 localStorage 读回数值');
  g('localStorage.removeItem("shift_max_per_week"); localStorage.removeItem("shift_max_enabled"); loadMaxShifts();');
  eq(g('state.maxShiftsPerWeek'), 3, '无存档时数值回落默认值 3（再确认一次）');
  eq(g('state.maxShiftsEnabled'), false, '无存档时开关回落为不勾选（再确认一次）');

  // syncMaxShiftsInput：数值框禁用态 / 开关勾选态 / 说明文案三处必须跟着开关走
  setMaxShifts(2);
  setMaxEnabled(false);
  eq(el('maxShiftsInput').disabled, true, '未勾选时数值框禁用（disabled === true）');
  eq(el('maxShiftsToggle').checked, false, '未勾选时开关控件未选中');
  ok(!String(el('maxShiftsHint').textContent).includes('已限制'), '未勾选时说明文案不含「已限制」');
  setMaxEnabled(true);
  eq(el('maxShiftsInput').disabled, false, '勾选后数值框可用（disabled === false）');
  eq(el('maxShiftsToggle').checked, true, '勾选后开关控件选中');
  ok(String(el('maxShiftsHint').textContent).includes('已限制'),
     `勾选后说明文案含「已限制」（实际：${el('maxShiftsHint').textContent}）`);
  ok(String(el('maxShiftsHint').textContent).includes('2'), '勾选后说明文案含当前数值 2');
  g('syncMaxShiftsInput()');
  eq(el('maxShiftsInput').value, '2', 'syncMaxShiftsInput 把归一化后的数值写进输入框');
  setMaxEnabled(false);

  // ── 上限只看开关：runSchedule 的旧 mode 参数必须被忽略 ──
  section('32b. runSchedule() 忽略旧的 mode 参数（上限只看开关）');
  setupStudents();
  g('state.template = makeDefaultTemplate()');
  g('initAssignments()');
  setMaxShifts(1);      // 数值写成 1，但开关未勾选
  setMaxEnabled(false);
  return reRunLegacyMode('balanced');   // 旧调用点会传 'balanced'，新代码必须忽略它
}).then(() => {
  ok(weeklyMaxOf('odd') > 1 || g('countEmptySlots(state.assignments)') === 0,
     '未勾选开关时 runSchedule("balanced") 不套用上限 1（mode 参数已失效）');

  // 反向确认：旧参数 'normal' 也换不来「不限制」，限制与否只认开关
  g('initAssignments()');
  setMaxShifts(1);
  setMaxEnabled(true);
  return reRunLegacyMode('normal');
}).then(() => {
  eq(weeklyMaxOf('odd'), 1, '勾选开关时 runSchedule("normal") 同样套用上限 1（mode 参数不影响开关语义）');

  // ── 勾选开关后才强制遵守上限 ──
  section('33. 勾选开关后强制遵守每人每周上限');
  setupStudents();
  g('state.template = makeDefaultTemplate()');
  setMaxShifts(2);
  setMaxEnabled(true);
  g('initAssignments()');
  return reRun();
}).then(() => {
  eq(weeklyMaxOf('odd'), 2, '勾选开关 + 上限 2：单周每人最多 2 班');
  eq(weeklyMaxOf('even'), 2, '勾选开关 + 上限 2：双周每人最多 2 班');
  ok(g('countEmptySlots(state.assignments)') > 0,
     '上限过小时确实会有班次排不满（而非偷偷超限）');

  // 上限 1 也能守住
  g('initAssignments()');
  setMaxShifts(1);
  setMaxEnabled(true);
  return reRun();
}).then(() => {
  eq(weeklyMaxOf('odd'), 1, '上限 1：单周每人最多 1 班');
  eq(weeklyMaxOf('even'), 1, '上限 1：双周每人最多 1 班');

  // ── 上限 = 0（勾选状态）：0 仍表示「不限制」，且仍然均衡 ──
  // 注意：数值框现在会把 0 归一化成默认值 3（见 §32），所以 0 只可能来自导入的数据文件；
  // 但 maxShiftsLimit() 对 0 的「不限制」语义必须保住，这里直接写 state 来锁住它。
  section('34. 勾选开关但上限 = 0：不限制，仍尽量均衡');
  g('initAssignments()');
  g('state.maxShiftsPerWeek = 0');
  setMaxEnabled(true);
  return reRun();
}).then(() => {
  ok(g('maxShiftsLimit() === Infinity'), '勾选开关 + 上限 0 → 仍然不限制（Infinity）');
  ok(weeklyMaxOf('odd') > 1, '上限 0 时不再限制每人每周 1 班');
  eq(g('countEmptySlots(state.assignments)'), 0, '上限 0 时所有班次都排满');
  const sp0 = spreadOf();
  ok(sp0.odd <= 1 && sp0.even <= 1 && sp0.total <= 1,
     `上限 0 的排班仍均衡（单周极差 ${sp0.odd}、双周 ${sp0.even}、合计 ${sp0.total}）`, sp0);

  // ── 均衡排班必须遵守课程冲突与容量（不能为了均衡违规） ──
  const violations = g(`(() => {
    const bad = { conflict: 0, overCap: 0 };
    for (const wt of ['odd','even']) {
      for (const key of Object.keys(state.assignments[wt])) {
        const info = resolveShift(key);
        if (!info) continue;
        const slot = state.assignments[wt][key];
        if (slot.length > info.shift.capacity) bad.overCap++;
        for (const sid of slot) {
          const st = state.students.find(s => s.sid === sid);
          if (st && hasConflict(st.courses, info.dayIdx + 1, info.shift.conflictPeriods, wt)) bad.conflict++;
        }
      }
    }
    return bad;
  })()`);
  eq(violations, { conflict: 0, overCap: 0 }, '勾选开关的排班没有违反课程冲突或班次容量');

  // ── 不勾选开关时同样均衡（用户明确要求：不限制 ≠ 放弃均衡） ──
  section('35. 不勾选开关时同样保证每人班次相差不大');
  g('initAssignments()');
  setMaxShifts(3);
  setMaxEnabled(false);
  return reRun();
}).then(() => {
  const spN = spreadOf();
  ok(spN.odd <= 1 && spN.even <= 1 && spN.total <= 1,
     `不勾选开关：单周 ${spN.odd}、双周 ${spN.even}、合计 ${spN.total} 极差均 ≤ 1`, spN);

  // 与勾选开关的结果对比：取消勾选后的合计极差不会更差
  const normalTotal = spN.total;
  g('initAssignments()');
  setMaxEnabled(true);
  return reRun().then(() => ({ normalTotal }));
}).then(({ normalTotal }) => {
  const spB = spreadOf();
  ok(spB.total <= Math.max(1, normalTotal),
     `勾选开关的合计极差 ${spB.total} 不劣于不勾选时 ${normalTotal}`);

  // ── 硬约束：勾选且上限很小时不超限；不勾选时不套用上限 ──
  section('36. 开关对上限的差异（用户确认的语义）');
  g('initAssignments()');
  setMaxShifts(1);
  setMaxEnabled(false);
  return reRun();
}).then(() => {
  ok(weeklyMaxOf('odd') > 1 || g('countEmptySlots(state.assignments)') === 0,
     '不勾选开关时不套用上限 1（仍会给人排第 2 班）');

  section('37. balanceCost / 单元工具的边界');
  g('state.assignments = { odd: {}, even: {} }');
  eq(g('balanceCost(state.assignments, [])'), 0, '无学生 → 代价 0（不抛异常）');
  eq(g('countEmptySlots(state.assignments)'), 0, '空 assignments → 0 个空槽位');
  eq(g('squaredDeviation([])'), 0, '空数组偏差平方和 0');
  eq(g('squaredDeviation([5,5,5])'), 0, '全相等 → 偏差平方和 0');
  eq(g('squaredDeviation([0,2])'), 2, '[0,2] 相对均值 1 的平方和 = 1+1 = 2');
  eq(g('weeklyLoadOf(state.assignments, "odd", "nobody")'), 0, '未排班的人单周计数 0');
  eq(g('totalLoadOf(state.assignments, "nobody")'), 0, '未排班的人合计计数 0');

  // ── 闭式增量公式必须与真实代价函数一致（性能优化不能改变语义） ──
  section('38. 均衡搜索的 O(1) 增量公式与真实代价一致');
  // 一次替换不改变总和 ⇒ 均值不变 ⇒ ΔΣv² = 2(新−旧) 对每个受影响的人成立
  //   delta = 4 − 2·gain，gain = (h−l) + (H−L)
  // 这里用真实 balanceCost() 逐组交叉验证，防止以后改代价函数却忘了改增量公式。
  g(`state.students = [
    {sid:'A',name:'A',status:'ready',courses:[]},
    {sid:'B',name:'B',status:'ready',courses:[]},
    {sid:'C',name:'C',status:'ready',courses:[]}
  ]`);
  let deltaMismatch = -1;
  for (let trial = 0; trial < 400; trial++) {
    const h = 1 + Math.floor(Math.random() * 6);
    const l = Math.floor(Math.random() * 6);
    const ea = Math.floor(Math.random() * 6);
    const eb = Math.floor(Math.random() * 6);
    const res = g(`(() => {
      const sids = ['A','B','C'];
      const h=${h}, l=${l}, ea=${ea}, eb=${eb};
      const A = {
        odd:  { x: new Array(h).fill('A').concat(new Array(l).fill('B')) },
        even: { y: new Array(ea).fill('A').concat(new Array(eb).fill('B')) }
      };
      const before = balanceCost(A, sids);
      const i = A.odd.x.indexOf('A');
      if (i < 0) return null;
      A.odd.x[i] = 'B';
      return { actual: balanceCost(A, sids) - before, closed: 4 - 2 * ((h - l) + (h + ea) - (l + eb)) };
    })()`);
    if (res === null) continue;
    if (Math.abs(res.actual - res.closed) > 1e-9) { deltaMismatch = { h, l, ea, eb, ...res }; break; }
  }
  eq(deltaMismatch, -1, '400 组随机场景下，闭式增量与实际代价变化完全一致');

  // ── 规模与性能：不能被均衡搜索拖垮（曾因 O(n) 代价重算慢到 30 秒） ──
  section('39. 规模可用性（100 人量级不退化）');
  const many = [];
  for (let i = 0; i < 100; i++) {
    const sid = '2025' + String(300000 + i);
    const courses = [];
    for (let c = 0; c < 4; c++) {
      const wd = (i + c) % 7 + 1;
      const begin = ((i * 3 + c * 5) % 10) + 1;
      courses.push(mkCourse('K' + c, wd, begin, 2, [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]));
    }
    many.push({ sid, name: 'S' + i, status: 'ready', courses, rawCourses: [], nowWeek: 8 });
  }
  g(`state.students = ${JSON.stringify(many)}`);
  g('state.template = makeDefaultTemplate()');
  setMaxShifts(3);
  setMaxEnabled(true);
  g('initAssignments()');
  const t0 = Date.now();
  return Promise.resolve(g(`(async () => {
    await runSchedule();
    return Date.now();
  })()`)).then(t1 => ({ t1, ms: t1 - t0 }));
}).then(({ ms }) => {
  ok(ms < 5000, `100 人均衡排班耗时 ${ms}ms < 5000ms（未退化）`);
  const sp = spreadOf();
  ok(sp.odd <= 1 && sp.even <= 1 && sp.total <= 1,
     `100 人规模仍均衡（单周 ${sp.odd}、双周 ${sp.even}、合计 ${sp.total}）`, sp);
  const hard = g(`(() => {
    const bad = { conflict: 0, overCap: 0, overLimit: 0 };
    for (const wt of ['odd','even']) {
      for (const key of Object.keys(state.assignments[wt])) {
        const info = resolveShift(key);
        if (!info) continue;
        const slot = state.assignments[wt][key];
        if (slot.length > info.shift.capacity) bad.overCap++;
        for (const sid of slot) {
          const st = state.students.find(s => s.sid === sid);
          if (st && hasConflict(st.courses, info.dayIdx + 1, info.shift.conflictPeriods, wt)) bad.conflict++;
        }
      }
    }
    for (const wt of ['odd','even']) {
      const load = {};
      for (const key of Object.keys(state.assignments[wt]))
        for (const sid of state.assignments[wt][key]) load[sid] = (load[sid]||0)+1;
      if (Object.values(load).some(v => v > 3)) bad.overLimit++;
    }
    return bad;
  })()`);
  eq(hard, { conflict: 0, overCap: 0, overLimit: 0 }, '100 人规模下三类硬约束全部保持');

  // ── 名额不足时要摊到整周，不能被工作日吃光 ──
  section('40. 名额紧张时「摊到整周」，周末不被饿死');
  // 曾经的问题：贪心按「先周一到周日」顺序填，上限卡紧时工作日把名额吃光，周末 0 人。
  // 修复：同难度内按「组内第几个班次 → 星期几」交错。
  const small = [];
  for (let i = 0; i < 12; i++) {
    small.push({ sid: '2025' + String(400000 + i), name: 'T' + i, status: 'ready',
                 courses: [], rawCourses: [], nowWeek: 8 });   // 全部无课，纯粹看名额分配
  }
  g(`state.students = ${JSON.stringify(small)}`);
  g('state.template = makeDefaultTemplate()');
  setMaxShifts(2);   // 12 人 × 2 班 = 24 个名额，远少于单周 74 个需求
  setMaxEnabled(true);
  g('initAssignments()');
  return Promise.resolve(g(`(async () => { await runSchedule(); return true; })()`));
}).then(() => {
  const dist = g(`(() => {
    const per = { weekday: 0, weekend: 0 };
    for (const key in state.assignments.odd) {
      const info = resolveShift(key);
      per[info.dayIdx >= 5 ? 'weekend' : 'weekday'] += state.assignments.odd[key].length;
    }
    return per;
  })()`);
  ok(dist.weekend > 0, `周末分到了名额（实际 ${dist.weekend} 人，工作日 ${dist.weekday} 人）`, dist);
  // 周末 2 天 / 共 7 天，工作日 5 天，按天数比例周末应占到约 2/7
  ok(dist.weekend / (dist.weekend + dist.weekday) >= 0.15,
     `周末占比 ${(dist.weekend / (dist.weekend + dist.weekday) * 100).toFixed(1)}% ≥ 15%（未被工作日吃光）`, dist);

  // 同难度下名额摊开：每天的排班人数不应出现「前几天满、后几天 0」
  const dry = g(`(() => {
    const per = {};
    for (const key in state.assignments.odd) {
      const info = resolveShift(key);
      per[info.dayIdx] = (per[info.dayIdx] || 0) + state.assignments.odd[key].length;
    }
    return Object.values(per);
  })()`);
  ok(dry.every(v => v > 0), `7 天每天都有排班（各天人数 ${dry.join('/')}）`, dry);

  const spSmall = spreadOf();
  eq([spSmall.odd, spSmall.even, spSmall.total], [0, 0, 0],
     '名额紧张时仍完全均衡（12 人各 2 班，极差 0）');

  // ── 41. 排班锁定：锁住「该同学 + 该班次」这个位置 ──
  // 语义是「位置」而非「人」：锁定后重新排班（开关勾选 / 不勾选各跑）该位置原样保留，
  // 但该同学在其它班次、以及其它同学进入这个班次，仍由算法自由安排。
  section('41. 排班锁定：重新排班不改变锁定位置');
  const lockStudents = [];
  for (let i = 0; i < 30; i++) {
    lockStudents.push({ sid: '2025' + String(600000 + i), name: 'K' + i, status: 'ready',
                        courses: [], rawCourses: [], nowWeek: 8 });   // 全员无课，纯看锁定效果
  }
  g(`state.students = ${JSON.stringify(lockStudents)}`);
  g('state.template = makeDefaultTemplate(); state.locks = { odd:{}, even:{} };');
  g('state.currentWeek = "odd"; state.currentView = "duty";');
  setMaxShifts(3);
  setMaxEnabled(false);
  g('initAssignments()');
  return Promise.resolve(g(`(async () => { await runSchedule(); return true; })()`));
}).then(() => {
  const KEY = 'odd_d0_wd0';
  const before = JSON.parse(g(`JSON.stringify(state.assignments.odd['${KEY}'])`));
  ok(before.length > 0, `排班后「${KEY}」有人，可对其加锁`, before);
  const lockedSid = before[0];

  g(`toggleLock('${KEY}','${lockedSid}')`);
  eq(g(`isLocked('${lockedSid}','${KEY}','odd')`), true, 'toggleLock 后该位置被标记为已锁定');
  eq(g(`lockedSidsOf('${KEY}','odd')`), [lockedSid], '槽位的锁定列表包含该学号');
  eq(g(`isLocked('${lockedSid}','odd_d1_wd0','odd')`), false,
     '锁定的是「该同学+该班次」而非该同学本人：同一人在其它班次不算锁定');

  // 渲染层：锁按钮存在，锁定的 tag 带 locked 类且不可拖动
  g('renderSchedule()');
  const lockHtml = el('scheduleContainer').innerHTML;
  ok(lockHtml.includes('lock-btn'), '学生标签渲染出锁定按钮');
  ok(lockHtml.includes('student-tag locked'), '已锁定的标签带上 locked 样式类');
  ok(lockHtml.includes('data-locked="1"'), '已锁定的标签标记 data-locked="1"');

  // 开关勾选 / 取消勾选各跑两次：锁定位置必须始终不变
  return Promise.resolve(g(`(async () => {
    setMaxShiftsEnabled(false);
    await runSchedule();
    setMaxShiftsEnabled(true);
    await runSchedule();
    setMaxShiftsEnabled(false);
    await runSchedule();
    setMaxShiftsEnabled(true);
    await runSchedule();
    return true;
  })()`)).then(() => lockedSid);
}).then((lockedSid) => {
  const KEY = 'odd_d0_wd0';
  const after = JSON.parse(g(`JSON.stringify(state.assignments.odd['${KEY}'])`));
  eq(after[0], lockedSid, '开关勾选 / 取消各跑两次后，锁定的人仍在该班次（未被换出）');

  // 锁定不应冻结整张表：其它槽位照常排班
  const filled = g(`(() => {
    let n = 0;
    for (const key in state.assignments.odd) if (state.assignments.odd[key].length > 0) n++;
    return n;
  })()`);
  ok(filled > 10, `锁定一个位置不影响其它槽位继续排班（${filled} 个槽位有人）`);

  // 锁定成员照常计入负载：不应因为「锁住」而被当成没排班、被反复加派到别处
  ok(g(`weeklyLoadOf(state.assignments, 'odd', '${lockedSid}') >= 1`),
     '锁定成员仍被计入该周负载统计');

  // initAssignments（重建槽位）必须保留锁定位置
  g('initAssignments()');
  eq(g(`JSON.stringify(state.assignments.odd['${KEY}'])`), JSON.stringify([lockedSid]),
     'initAssignments 重建槽位后，锁定位置原样恢复');

  // 解锁后回到普通状态
  g(`toggleLock('${KEY}','${lockedSid}')`);
  eq(g(`isLocked('${lockedSid}','${KEY}','odd')`), false, '再次点击锁按钮可解锁');
  eq(g(`lockedSidsOf('${KEY}','odd')`), [], '解锁后该槽位锁定列表为空');

  // ── 均衡搜索必须跳过锁定位置（确定性用例，不依赖随机） ──
  g(`state.students = [
    {sid:'A',name:'A',status:'ready',courses:[],rawCourses:[]},
    {sid:'B',name:'B',status:'ready',courses:[],rawCourses:[]},
    {sid:'C',name:'C',status:'ready',courses:[],rawCourses:[]}
  ]`);
  g('state.template = makeDefaultTemplate()');
  g(`state.assignments = { odd: { odd_d0_wd0:['A'], odd_d0_wd1:['A'], odd_d0_wd2:['B'] }, even: {} }`);
  g(`state.locks = { odd: { odd_d0_wd0:['A'] }, even: {} }`);   // 只锁 wd0
  g(`optimizeBalance(state.assignments, state.students, ['A','B','C'], Infinity)`);
  eq(g(`JSON.stringify(state.assignments.odd['odd_d0_wd0'])`), '["A"]',
     'optimizeBalance 不把锁定成员换出（锁定位置保持不变）');
  ok(g(`state.assignments.odd['odd_d0_wd1'][0] !== 'A'`),
     '未锁定的重复排班仍被均衡搜索调整（锁定没有冻结全表）');

  // ── 手工操作防护：锁定位置不可拖走、不可点 × 移除 ──
  g(`state.locks = { odd: { odd_d0_wd0:['A'] }, even: {} };`);
  g(`state.assignments.odd['odd_d0_wd0'] = ['A'];`);
  g('state.currentWeek = "odd";');
  g(`removeFromShift('odd_d0_wd0','A')`);
  eq(g(`JSON.stringify(state.assignments.odd['odd_d0_wd0'])`), '["A"]',
     '锁定位置点 × 不会被移除（并给出提示）');

  const prevented = g(`(() => {
    const tag = { dataset: { sid:'A', key:'odd_d0_wd0', locked:'1' },
                  classList: { add(){}, remove(){} } };
    const e = { target: { closest: () => tag }, _pd: false, preventDefault(){ e._pd = true; } };
    onDragStart(e);
    return e._pd;
  })()`);
  eq(prevented, true, '锁定标签的拖拽被拦截（不会拖走锁定位置）');

  // ── 锁定数据的规范化与剪枝 ──
  eq(g('normalizeLocks(undefined)'), { odd: {}, even: {} },
     'normalizeLocks(undefined) → 空锁定表（兼容旧文件）');
  eq(g(`JSON.stringify(normalizeLocks({ odd:{ 'odd_d0_wd0':['A','A','B'] }, even:{ 'bad key':['C'] } }))`),
     '{"odd":{"odd_d0_wd0":["A","B"]},"even":{}}',
     'normalizeLocks 去重并丢弃非法键');
  eq(g(`JSON.stringify(normalizeLocks({ odd:{ 'even_d0_wd0':['A'] } }))`), '{"odd":{},"even":{}}',
     'normalizeLocks 丢弃单双周与键不匹配的记录');

  // 班次被删除后，其锁定记录必须随之清理
  g(`state.locks = { odd: { odd_d0_wd0:['A'], odd_d0_wd1:['B'] }, even: {} };`);
  g(`state.assignments = { odd: { odd_d0_wd0:['A'], odd_d0_wd1:['B'] }, even: {} };`);
  g(`state.template = normalizeTemplate((() => {
    const t = makeDefaultTemplate();
    t.groups.weekday = t.groups.weekday.filter(s => s.id !== 'wd0');
    return t;
  })())`);
  g('pruneInvalidAssignments()');
  eq(g(`JSON.stringify(state.locks.odd)`), '{"odd_d0_wd1":["B"]}',
     '班次被删除后，指向该班次的锁定记录一并清除（不留脏数据）');

  // ── 导入 / 导出往返必须带上锁定 ──
  // 从 exportData 产生的 Blob 里取回 JSON，验证导出内容真的包含 locks
  g(`globalThis.__oldCreate = URL.createObjectURL;
     URL.createObjectURL = (b) => { globalThis.__blob = b; return 'blob:x'; };
     exportData();`);
  const exportedData = JSON.parse(g('String(__blob.parts[0])'));
  ok(Object.prototype.hasOwnProperty.call(exportedData, 'locks'), '导出的 JSON 含 locks 字段');
  eq(JSON.stringify(exportedData.locks), g('JSON.stringify(state.locks)'),
     '导出的 locks 与当前锁定状态一致');
  g('URL.createObjectURL = globalThis.__oldCreate;');

  // 模拟导入：锁定按 normalizeLocks 恢复
  const snapshot = g(`JSON.stringify({ locks: state.locks, assignments: state.assignments, students: state.students })`);
  g('state.locks = { odd:{}, even:{} }; state.assignments = { odd:{}, even:{} };');
  g(`(function(){
    const d = ${snapshot};
    state.students = d.students;
    state.assignments = d.assignments;
    state.locks = normalizeLocks(d.locks);
    remapAssignmentIds(_idRemap);
    pruneInvalidAssignments();
    pruneLocks();
  })()`);
  eq(g(`JSON.stringify(state.locks.odd)`), '{"odd_d0_wd1":["B"]}', '导入后锁定状态完整恢复');

  // 老文件没有 locks 字段 → 全部视为未锁定，不报错
  g('state.locks = normalizeLocks(undefined)');
  eq(g('JSON.stringify(state.locks)'), '{"odd":{},"even":{}}',
     '导入无 locks 字段的旧文件 → 视为全部未锁定');

  // ── 清理路径：移除同学 / 重置排班都要带走锁定 ──
  g(`state.locks = { odd: { odd_d0_wd0:['A'], odd_d0_wd1:['B'] }, even: {} };
     state.students = [
       {sid:'A',name:'A',status:'ready',courses:[],rawCourses:[]},
       {sid:'B',name:'B',status:'ready',courses:[],rawCourses:[]}
     ];
     state.assignments = { odd: { odd_d0_wd0:['A'], odd_d0_wd1:['B'] }, even: {} };`);
  g(`dropLocksOfStudent('A')`);
  eq(g(`JSON.stringify(state.locks.odd)`), '{"odd_d0_wd1":["B"]}',
     '移除同学时只清除该同学的锁定，其它人的锁定保留');

  // resetSchedule 内部走 showConfirm 回调；harness 的 addEventListener 是空实现，
  // 这里把 showConfirm 临时替换成「直接执行回调」，以便真正跑到重置逻辑。
  g(`(function(){ const old = showConfirm; showConfirm = (t, m, fn) => fn(); try { resetSchedule(); } finally { showConfirm = old; } })()`);
  eq(g('JSON.stringify(state.locks)'), '{"odd":{},"even":{}}', '重置排班后锁定一并清空');

  // ── 42. 层叠陷阱：确认弹窗必须盖在普通弹窗（尤其模板编辑器）之上 ──
  // 曾出现的问题：所有 .modal-overlay 都是 body 的直接子元素且 z-index 相同（9998），
  // 于是由 DOM 顺序决定层叠；#confirmModal 排在 #templateModal 之前，
  // 导致「模板内删除班次/分组」的确认框被模板窗口整个盖住，用户看不到、点不到，班次删不掉。
  // node 里没有 CSS 引擎，这里只能做静态断言（防止有人把抬高确认框的那条规则删掉）；
  // 真正的层叠/可点击性由浏览器端验证覆盖，见 AGENT.md §6.7。
  section('42. 层叠修复：确认弹窗不被其它弹窗盖住');
  const css = rawHtml();
  ok(/#confirmModal\s*\{[^}]*z-index\s*:\s*9999/.test(css),
     'CSS 中 #confirmModal 被单独抬到 z-index 9999（高于普通弹窗的 9998）');
  ok(/\.modal-overlay\s*\{[^}]*z-index\s*:\s*9998/.test(css),
     '普通弹窗仍为 9998（确认框基准层不变）');
  ok(/\.toast\s*\{[^}]*z-index\s*:\s*10000/.test(css),
     'Toast 仍凌驾于所有弹窗之上（10000），提示不会被遮');

  // 确认框必须排在模板窗口之前 —— 正是这个顺序 + 相同 z-index 才引发事故；
  // 一旦有人把 #confirmModal 挪到模板窗口之后，「抬高一层」就成了唯一保障，顺序不再是隐患。
  const iConfirm = css.indexOf('id="confirmModal"');
  const iTemplate = css.indexOf('id="templateModal"');
  ok(iConfirm > 0 && iTemplate > 0 && iConfirm < iTemplate,
     '锁定前提仍成立：#confirmModal 在 DOM 中先于 #templateModal（故必须靠 z-index 压住它）');

  // 受影响的三条路径都是「模板窗内弹确认框」，确认它们的入口都存在
  ok(g('typeof tplRemoveShift') === 'function', '删除班次入口存在（会弹确认框）');
  ok(g('typeof tplRemoveGroup') === 'function', '删除分组入口存在（会弹确认框）');
  ok(g('typeof resetTemplateToDefault') === 'function', '恢复默认模板入口存在（会弹确认框）');

  // ── 43. 连续 / 分散排班偏好（「连续排班」开关，见 AGENT.md §4.10） ──
  // 口径（用户确认）：同一天首尾相接的班次算「连班」(+2)，相邻两天都值班也算连续 (+1)。
  // 勾选「连续排班」= 尽量提高该分数；不勾选 = 反过来尽量降低（分散）。
  section('43. 连续 / 分散排班偏好');

  g('state.template = makeDefaultTemplate()');
  const cctx = 'makeContinuityContext("odd")';
  eq(g(`continuityScoreOf(new Set(['0|wd0','0|wd1']), ${cctx})`), 2,
     '周一「早班+午班①」首尾相接 → 连续分 2');
  eq(g(`continuityScoreOf(new Set(['0|wd0','0|wd1','0|wd2']), ${cctx})`), 4,
     '周一连上三个班（两对连班）→ 连续分 4');
  eq(g(`continuityScoreOf(new Set(['0|wd0','0|wd3']), ${cctx})`), 0,
     '同一天但中间断开的两个班（早班+下午班）→ 不算连续');
  eq(g(`continuityScoreOf(new Set(['0|wd0','1|wd0']), ${cctx})`), 1,
     '相邻两天都值班 → 连续分 1');
  eq(g(`continuityScoreOf(new Set(['0|wd0','2|wd0']), ${cctx})`), 0,
     '隔了一天（周一+周三）→ 不算连续');
  eq(g(`continuityScoreOf(new Set(), ${cctx})`), 0, '没有班次 → 连续分 0');
  eq(g(`isBackToBackShifts({start:'10:00',end:'12:05'},{start:'12:05',end:'13:45'})`), true,
     '首尾相接（空档 0 分钟）算连班');
  eq(g(`isBackToBackShifts({start:'10:00',end:'12:05'},{start:'12:35',end:'13:45'})`), true,
     '空档 30 分钟以内仍算连班（同一次到岗）');
  eq(g(`isBackToBackShifts({start:'10:00',end:'12:05'},{start:'12:36',end:'13:45'})`), false,
     '空档超过 30 分钟不算连班');
  eq(g(`isBackToBackShifts({start:'12:05',end:'13:45'},{start:'10:00',end:'12:05'})`), false,
     '顺序颠倒不算连班（不能倒着接）');

  // 开关的持久化
  g('setContinuousScheduling(true)');
  eq(g('state.continuousShifts'), true, 'setContinuousScheduling(true) 写入 state');
  eq(localStorage.getItem('shift_continuous'), '1', '开关持久化到 localStorage');
  g('setContinuousScheduling(false)');
  g('loadContinuousScheduling()');
  eq(g('state.continuousShifts'), false, 'loadContinuousScheduling 读回开关值');
  g('localStorage.removeItem("shift_continuous"); loadContinuousScheduling();');
  eq(g('state.continuousShifts'), false, '无存档时默认「分散」（不勾选）');

  // 界面：开关控件与说明文案
  ok(rawHtml().includes('id="continuousToggle"'), '侧栏存在「连续排班」开关控件');
  ok(rawHtml().includes('setContinuousScheduling(this.checked)'),
     '开关的勾选事件接到 setContinuousScheduling');
  g('setContinuousScheduling(true); syncContinuousInput();');
  eq(el('continuousToggle').checked, true, 'syncContinuousInput 把勾选状态同步到控件');
  ok(String(el('continuousHint').textContent).includes('连成片'), '勾选后说明文案变为「连成片」');
  g('setContinuousScheduling(false); syncContinuousInput();');
  eq(el('continuousToggle').checked, false, '取消勾选后控件同步为未选中');
  ok(String(el('continuousHint').textContent).includes('分散'), '未勾选时说明文案为「分散」');

  /** 取某人某周的连续分（测试辅助，与实现同口径） */
  const prefScore = (wt, sid) => g(`(() => {
    const octx = makeContinuityContext('${wt}');
    const set = new Set();
    for (const k in state.assignments.${wt}) {
      const info = resolveShift(k);
      if (info && state.assignments.${wt}[k].includes('${sid}')) set.add(occupiedSlotKey(info.dayIdx, info.shift.id));
    }
    return continuityScoreOf(set, octx);
  })()`);

  // 勾选「连续排班」：把两个人的班次各自并到同一天首尾相接
  g(`state.students = [
    {sid:'A',name:'A',status:'ready',courses:[],rawCourses:[]},
    {sid:'B',name:'B',status:'ready',courses:[],rawCourses:[]}
  ]`);
  g(`state.assignments = { odd: {
        odd_d0_wd0:['A'], odd_d4_wd0:['A'],
        odd_d0_wd1:['B'], odd_d4_wd1:['B']
      }, even: {} }`);
  g(`state.locks = { odd:{}, even:{} }`);
  eq(prefScore('odd', 'A') + prefScore('odd', 'B'), 0, '初始状态：两人都是「周一 + 周五」，一点不连续');
  g('setContinuousScheduling(true)');
  const costBeforeCluster = g('balanceCost(state.assignments, ["A","B"])');
  const movedCluster = g('optimizeContinuity(state.assignments, state.students, ["A","B"])');
  ok(movedCluster > 0, `连续模式确实做了 ${movedCluster} 次「换人」`);
  eq(g('balanceCost(state.assignments, ["A","B"])'), costBeforeCluster,
     '交换不改变任何人的班次数 → 均衡代价分毫不动（连续偏好不会反噬均衡）');
  eq(prefScore('odd', 'A') + prefScore('odd', 'B'), 4,
     '连续模式：两人各自形成一对连班（连续分 0 → 4）');

  // 不勾选（分散）：把原来连在一起的班次拆开
  g(`state.assignments = { odd: {
        odd_d0_wd0:['A'], odd_d0_wd1:['A'],
        odd_d0_wd2:['B'], odd_d4_wd3:['B']
      }, even: {} }`);
  eq(prefScore('odd', 'A'), 2, '初始状态：A 周一连班（连续分 2）');
  g('setContinuousScheduling(false)');
  const costBeforeSpread = g('balanceCost(state.assignments, ["A","B"])');
  g('optimizeContinuity(state.assignments, state.students, ["A","B"])');
  eq(g('balanceCost(state.assignments, ["A","B"])'), costBeforeSpread,
     '分散模式同样是等价交换 → 均衡代价不变');
  eq(prefScore('odd', 'A') + prefScore('odd', 'B'), 0,
     '分散模式把连班拆开（连续分 2 → 0）');

  // 课程冲突是硬约束：能形成连班但会撞课的交换必须被拒绝
  g(`state.students = [
    {sid:'A',name:'A',status:'ready',rawCourses:[],courses:[${JSON.stringify(mkCourse('甲课', 1, 5, 2, [1,2,3,4,5,6,7,8]))}]},
    {sid:'B',name:'B',status:'ready',rawCourses:[],courses:[${JSON.stringify(mkCourse('乙课', 1, 3, 2, [1,2,3,4,5,6,7,8]))}]}
  ]`);
  g(`state.assignments = { odd: {
        odd_d0_wd0:['A'], odd_d4_wd0:['A'],
        odd_d0_wd2:['B'], odd_d4_wd1:['B']
      }, even: {} }`);
  g(`state.locks = { odd:{}, even:{} }`);
  g('setContinuousScheduling(true)');
  eq(g('optimizeContinuity(state.assignments, state.students, ["A","B"])'), 0,
     '两个能凑成连班的交换都会撞课 → 一次都不换');
  eq(g(`(() => {
    const bad = [];
    for (const wt of ['odd','even']) for (const k in state.assignments[wt]) {
      const info = resolveShift(k);
      for (const sid of state.assignments[wt][k]) {
        const st = state.students.find(s => s.sid === sid);
        if (st && hasConflict(st.courses, info.dayIdx + 1, info.shift.conflictPeriods, wt)) bad.push(k + ':' + sid);
      }
    }
    return bad;
  })()`), [], '交换之后没有任何人被排进有课的班次');

  // 端到端：跑真正的入口 runSchedule，确认「连续排班」开关确实接进了排班流程
  const prefStudents = [];
  for (let i = 0; i < 20; i++) {
    prefStudents.push({ sid: '2025' + String(800000 + i), name: 'P' + i, status: 'ready',
                        courses: [], rawCourses: [], nowWeek: 8 });
  }
  g(`state.students = ${JSON.stringify(prefStudents)}`);
  g('state.template = makeDefaultTemplate(); state.locks = {odd:{},even:{}};');
  // 这一组要看的是「连续 / 分散」偏好，因此显式勾选开关并把上限设为 3
  // （20 人 × 单周 38 个槽位，每人约 2 班，上限 3 不会干扰连续偏好，但能锁住硬约束）
  setMaxShifts(3);
  setMaxEnabled(true);
  g('setContinuousScheduling(false)');
  g('initAssignments()');
  return Promise.resolve(g(`(async () => { await runSchedule(); return totalContinuityScore(); })()`))
    .then(spreadEndScore => ({ spreadEndScore }));
}).then(({ spreadEndScore }) => {
  g('setContinuousScheduling(true)');
  g('initAssignments()');
  return Promise.resolve(g(`(async () => { await runSchedule(); return totalContinuityScore(); })()`))
    .then(clusterEndScore => ({ spreadEndScore, clusterEndScore }));
}).then(({ spreadEndScore, clusterEndScore }) => {
  ok(clusterEndScore > spreadEndScore,
     `端到端：勾选「连续排班」后全表连续分明显提升（分散 ${spreadEndScore} → 连续 ${clusterEndScore}）`);
  const spPref = g(`(() => {
    const s = loadStats(state.assignments, state.students.map(x => x.sid));
    return { odd: s.oddSpread, even: s.evenSpread, total: s.totalSpread };
  })()`);
  ok(spPref.odd <= 1 && spPref.even <= 1 && spPref.total <= 1,
     `端到端：连续模式下仍然均衡（单周 ${spPref.odd}、双周 ${spPref.even}、合计 ${spPref.total} 极差 ≤ 1）`, spPref);
  const prefViolations = g(`(() => {
    const bad = { conflict: 0, overCap: 0, overLimit: 0, dup: 0 };
    for (const wt of ['odd','even']) {
      const load = {};
      for (const key of Object.keys(state.assignments[wt])) {
        const info = resolveShift(key);
        const slot = state.assignments[wt][key];
        if (slot.length > info.shift.capacity) bad.overCap++;
        if (new Set(slot).size !== slot.length) bad.dup++;
        for (const sid of slot) {
          load[sid] = (load[sid] || 0) + 1;
          const st = state.students.find(s => s.sid === sid);
          if (st && hasConflict(st.courses, info.dayIdx + 1, info.shift.conflictPeriods, wt)) bad.conflict++;
        }
      }
      if (Object.values(load).some(v => v > 3)) bad.overLimit++;
    }
    return bad;
  })()`);
  eq(prefViolations, { conflict: 0, overCap: 0, overLimit: 0, dup: 0 },
     '端到端：连续模式仍守住容量 / 课程冲突 / 每人上限，且槽位内无重复的人');
  g('setContinuousScheduling(false); localStorage.removeItem("shift_continuous");');

  // ── 44. 人员表（导出值班表时附带，见 AGENT.md §4.11） ──
  // 口径：每人总班次 = 单周班次数 + 双周班次数；weeks:'all' 的班次每周都值，
  //       单周、双周各计一次，明细里标注为「每周」。
  section('44. 人员表：单人何时有几班（导出值班表的第三个工作表）');

  g(`state.template = normalizeTemplate({ name:'人员表用例', mode:'custom', layout:[
    {key:'g1',name:'周一',days:[0]}
  ], groups:{
    g1:[{id:'all',label:'通用班',start:'10:00',end:'12:00',capacity:9},
        {id:'odd',label:'单周班',start:'14:00',end:'16:00',capacity:9,weeks:'odd'},
        {id:'even',label:'双周班',start:'16:00',end:'18:00',capacity:9,weeks:'even'}]
  }})`.replace(/\n/g, ''));
  g('initAssignments()');
  // 槽位按「该周是否生效」生成，所以单周没有仅双周班的键，反之亦然
  eq(g("Object.keys(state.assignments.odd).sort()"), ['odd_d0_all', 'odd_d0_odd'],
     '单周槽位 = 每周班 + 仅单周班');
  eq(g("Object.keys(state.assignments.even).sort()"), ['even_d0_all', 'even_d0_even'],
     '双周槽位 = 每周班 + 仅双周班');
  // 甲：单周名单里 2 条（每周班+单周班）、双周名单里 2 条（每周班+双周班）→ 合计 4
  // 乙：只在单周名单里排了「每周班」→ 单周 1 + 双周 0 = 合计 1（与侧栏 weeklyLoadOf/totalLoadOf 同口径）
  // 丙：名单内的同学，没有任何排班 → 合计 0
  g(`state.students = [
    {sid:'2025210001',name:'甲同学',status:'ready',courses:[],rawCourses:[],nowWeek:8},
    {sid:'2025210002',name:'乙同学',status:'ready',courses:[],rawCourses:[],nowWeek:8},
    {sid:'2025210003',name:'丙同学',status:'ready',courses:[],rawCourses:[],nowWeek:8},
    {sid:'2025210004',name:'丁同学',status:'ready',courses:[],rawCourses:[],nowWeek:8}
  ]`);
  g(`state.assignments.odd.odd_d0_all = ['2025210001','2025210002'];
     state.assignments.odd.odd_d0_odd = ['2025210001'];
     state.assignments.even.even_d0_all = ['2025210001'];
     state.assignments.even.even_d0_even = ['2025210001'];
     state.assignments.odd.odd_d0_bogus = ['2025210004'];`);   // 模板中不存在的陈旧键

  // 有效排班的计数与项目既有的负载口径一致（不另造算法）
  eq(g("weeklyLoadOf(state.assignments,'odd','2025210001')"), 2, '甲的单周班次数与 weeklyLoadOf 一致');
  eq(g("totalLoadOf(state.assignments,'2025210001')"), 4, '甲的合计与 totalLoadOf 一致，为 4');
  eq(g("weeklyLoadOf(state.assignments,'odd','2025210004')"), 1,
     '陈旧键会让侧栏口径把丁算成 1（历史遗留键确实还在 assignments 里）');

  writeFiles.length = 0;
  g('exportDutySchedule()');
  eq(writeFiles.length, 1, '导出值班表仍只调用一次 XLSX.writeFile');
  const wbPerson = writeFiles[0].wb;
  eq(wbPerson.SheetNames, ['单周值班表', '双周值班表', '人员表'], '三个工作表：单周 / 双周 / 人员表');
  ok(wbPerson.Sheets['人员表'] && Array.isArray(wbPerson.Sheets['人员表'].rows), '人员表工作表已生成');
  const pRows = wbPerson.Sheets['人员表'].rows;
  const pFlat = pRows.map(r => r.join('|'));
  const sumIdx = pFlat.findIndex(r => r.startsWith('姓名|学号|单周班次|双周班次|合计'));
  ok(sumIdx > 0, '人员表含概览表头');
  const detailHeaderIdx = pFlat.findIndex(r => r.startsWith('姓名|学号|周别|星期|班次名称|时间段|分组'));
  ok(detailHeaderIdx > sumIdx, '人员表含明细表头（在概览之后）');
  // 明细数据行 = 明细表头之后、姓名列非空且不是另一个表头的行
  const detail = pRows.slice(detailHeaderIdx + 1)
    .filter(r => r[0] && r[0] !== '姓名' && !r[0].startsWith('排班明细'));
  // 概览的人员行：概览表头之后 → 明细标题之前（明细标题 = 明细表头下标 - 2：标题行 + 空行）
  const detailTitleIdx = detailHeaderIdx - 2;
  const sumRows = pRows.slice(sumIdx + 1, detailTitleIdx).filter(r => r[0] && !r[0].startsWith('说明'));
  eq(sumRows.length, 4, '概览恰好列出四名人员行', sumRows);

  // 沙箱里没有 Array#find，用显式循环取值
  const personRow = name => {
    for (const r of sumRows) if (r[0] === name) return r;
    return null;
  };
  const of = name => {
    const r = personRow(name);
    return r ? { odd: r[2], even: r[3], total: r[4] } : null;
  };
  eq(of('甲同学'), { odd: 2, even: 2, total: 4 }, '甲：单周 2 + 双周 2 = 合计 4');
  eq(of('乙同学'), { odd: 1, even: 0, total: 1 }, '乙：只在单周被排了班 → 合计 1（与侧栏口径一致）');
  eq(of('丙同学'), { odd: 0, even: 0, total: 0 }, '未排班的人员也在概览里，合计 0');
  eq(of('丁同学'), { odd: 0, even: 0, total: 0 },
     '只挂在陈旧键上的人按 0 班计（模板里已没有那个班次）');
  ok(!detail.some(r => r[1] === '2025210004'), '陈旧键不会在明细里冒出一行排班');
  eq(of('戊同学'), null, '未在名单里、也没有排班的人不会凭空出现');
  eq(personRow('丙同学').slice(0, 2), ['丙同学', '2025210003'], '概览写出姓名与学号');
  eq(personRow('甲同学').slice(2), [2, 2, 4], '概览三列依次为 单周 / 双周 / 合计');
  eq(sumRows.map(r => r[0]), ['甲同学', '乙同学', '丙同学', '丁同学'], '概览按合计班次降序、同班次按学号排序');

  // 明细顺序：先按该人所在的周（单周 → 双周）分组，组内按星期、再按班次开始时间
  const dWeek = detail.map(r => r[2]);
  eq(dWeek.length, 5, '明细总行数 = 各人实际班次数之和（2 + 2 + 1 + 0 + 0 = 5）');
  eq(dWeek, ['每周', '单周', '每周', '双周', '每周'], '明细按「所在周 → 星期 → 班次时间」排序');
  const days0 = detail.map(r => r[3]);
  eq(days0, ['周一', '周一', '周一', '周一', '周一'], '明细写出星期');
  ok(detail.every(r => typeof r[5] === 'string' && /^\d{2}:\d{2}-\d{2}:\d{2}$/.test(r[5])),
     '明细写出 HH:MM-HH:MM 时间段', detail.map(r => r[5]));
  eq(detail[0], ['甲同学', '2025210001', '每周', '周一', '通用班', '10:00-12:00', '周一'],
     '明细一行：姓名 / 学号 / 周别 / 星期 / 班次 / 时间段 / 分组');
  eq(detail[1], ['甲同学', '2025210001', '单周', '周一', '单周班', '14:00-16:00', '周一'], '仅单周班标注「单周」');
  eq(detail[3], ['甲同学', '2025210001', '双周', '周一', '双周班', '16:00-18:00', '周一'], '双周班明细正确');
  eq(detail[4], ['乙同学', '2025210002', '每周', '周一', '通用班', '10:00-12:00', '周一'], '乙在明细里只有 1 行');
  eq(detail.length, sumRows.reduce((s, r) => s + r[4], 0), '概览合计 = 明细行数（两段口径一致）');

  // 人数：单周表里通用班 2 人 + 单周班 1 人；双周表里通用班 1 人 + 双周班 1 人
  eq(g(`state.assignments.odd['odd_d0_all'].length + state.assignments.odd['odd_d0_odd'].length +
        state.assignments.even['even_d0_all'].length + state.assignments.even['even_d0_even'].length`), 5,
     '实际槽位内的人数合计为 5');

  // 清掉排班但保留名单：概览里所有人都还在，且合计归零
  g('state.assignments = { odd: {}, even: {} };');
  writeFiles.length = 0;
  g('exportDutySchedule()');
  const clearedRows = writeFiles[0].wb.Sheets['人员表'].rows;
  const clearIdx = clearedRows.map(r => r.join('|')).findIndex(r => r.startsWith('姓名|学号|单周班次'));
  const cleared = clearedRows.slice(clearIdx + 1).filter(r => r[0] && !r[0].startsWith('排班明细') && r[0] !== '姓名');
  ok(cleared.length === 4 && cleared[0][0] === '甲同学' && cleared[0][4] === 0,
     '排班清空后人员仍在概览里且合计为 0', cleared);
  ok(clearedRows.map(r => r.join('|')).some(r => r.includes('甲同学')), '名单里的人不会因为没班次而消失');

  // 完全没有数据时也要有人员表（只有提示行），不影响单双周表
  g('state.students = [];');
  writeFiles.length = 0;
  g('exportDutySchedule()');
  const emptyPerson = writeFiles[0].wb.Sheets['人员表'];
  ok(!!emptyPerson, '空排班时人员表仍然存在');
  eq(writeFiles[0].wb.SheetNames, ['单周值班表', '双周值班表', '人员表'], '空排班时仍是三个工作表');
  ok(emptyPerson.rows.map(r => r.join('|')).some(r => r.includes('暂无排班数据')), '空排班时人员表给出提示行');
  ok(writeFiles[0].wb.Sheets['单周值班表'].rows.length > 0, '单周值班表结构不受空人员表影响');

  // 空课表不带人员表（用户明确只加在值班表）
  g("state.students = [{sid:'2025210002',name:'同学0002',status:'ready',courses:[],rawCourses:[],nowWeek:8}]");
  writeFiles.length = 0;
  g('exportFreeSchedule()');
  eq(writeFiles[0].wb.SheetNames, ['单周空课表', '双周空课表'], '空课表仍只有单双周两个工作表（不加人员表）');

  // ── 45. 顶部菜单栏：文件 / 个性化 / 关于（二级菜单） ──
  // 用户要求把导入 / 导出类入口收进顶部「文件」二级菜单，切换主题收进「个性化」，
  // 使用指南收进「关于」，并在「关于」下新增「软件信息」。
  // node 里没有布局引擎，这里做「入口存在 + 逻辑接线 + 层叠规则」的静态与行为断言；
  // 下拉面板能否真的点到，靠浏览器验证（与 §6.7 同类问题）。
  section('45. 顶部菜单栏：文件 / 个性化 / 关于');

  const menuHtml = rawHtml();
  ['menuFile', 'menuPersonal', 'menuAbout'].forEach(id => {
    ok(menuHtml.includes(`id="${id}"`), `存在一级菜单 ${id}`);
  });
  ok(menuHtml.includes('class="top-menubar"'), '顶部存在 .top-menubar 菜单栏');

  // 「文件」二级菜单里的迁移项
  // 注意：「导入学号」接的是 openSidImport（打开弹窗），不再直接接 loadStudents；
  //       另外新增了「编辑值班模板…」「重置排班…」两项。
  ['openSidImport', 'importData', 'exportDutySchedule', 'exportFreeSchedule',
   'exportData', 'exportTemplateFile', 'openTemplateEditor', 'resetSchedule'].forEach(fn => {
    ok(menuHtml.includes(`menuRun(${fn})`), `「文件」菜单接到 ${fn}`);
  });
  ok(!menuHtml.includes('menuRun(loadStudents)'),
     '「文件」菜单不再直接接 loadStudents（改为先打开学号弹窗）');
  ok(/menuRun\(function\(\)\{ document\.getElementById\('tplFileInput'\)\.click\(\); \}\)/.test(menuHtml),
     '「文件」菜单的「导入模板…」接到隐藏的 tplFileInput');
  ok(menuHtml.includes('id="menuExportDuty"') && menuHtml.includes('id="menuExportFree"'),
     '「文件」菜单保留导出值班表 / 空课表的禁用态控件 id');

  // 原位置的按钮已被移除（用户选择「完全移到菜单」）：
  // 现在 onclick="loadStudents()" 只剩两处 —— 学号弹窗里的「导入」按钮 + 隐藏兼容控件。
  eq((menuHtml.match(/onclick="loadStudents\(\)"/g) || []).length, 2,
     '「导入学号」只剩弹窗内的「导入」按钮 + 隐藏兼容控件（左侧可见按钮已移除）');
  ok(menuHtml.includes('id="btnMenuImportStudents"'),
     '隐藏兼容控件 #btnMenuImportStudents 仍保留（老脚本可继续调用 loadStudents）');
  ok(!/class="btn[^"]*" id="btnExportDuty"/.test(menuHtml),
     '左侧不再有可见的「导出值班表」按钮（只剩 display:none 的兼容控件）');
  ok(!/class="btn[^"]*" id="btnExportFree"/.test(menuHtml),
     '左侧不再有可见的「导出空课表」按钮（只剩 display:none 的兼容控件）');
  ok(!/class="btn btn-outline btn-sm" onclick="exportData\(\)"/.test(menuHtml),
     '左侧面板不再有「导出数据」按钮');
  ok(!/class="btn btn-outline btn-sm" onclick="importData\(\)"/.test(menuHtml),
     '左侧面板不再有「导入数据」按钮');
  ok(!/onclick="openGuide\(\)">使用指南/.test(menuHtml),
     '表头不再有「使用指南」按钮（已收进「关于」菜单）');
  ok(menuHtml.includes('id="btnExportDuty" style="display:none"')
     && menuHtml.includes('id="btnExportFree" style="display:none"'),
     '导出值班表 / 空课表的隐藏兼容控件仍在（老脚本与 §L23 仍可读其 disabled）');

  // ── 本轮改动：删掉的旧入口 / 新增的控件（静态断言） ──
  // 1. 左侧 .panel-header 整块已删除；表头 .header-actions 整块已删除
  ok(!menuHtml.includes('class="panel-header"'),
     '源码里不存在 class="panel-header"（左侧标题栏已删除）');
  ok(!menuHtml.includes('class="header-actions"'),
     '源码里不存在 class="header-actions"（表头「值班模板 / 重置排班」整块已删除）');
  // 2. 「均衡排班」按钮已删除：runSchedule 不再有模式参数，上限只看开关
  ok(!menuHtml.includes('id="btnBalance"'),
     '源码里不存在 id="btnBalance"（「均衡排班」按钮已删除）');
  // 3. 上限入口改成开关 + 数值框，并接到 setMaxShiftsEnabled
  ok(menuHtml.includes('id="maxShiftsToggle"'), '源码里存在 id="maxShiftsToggle"（上限开关）');
  ok(menuHtml.includes('setMaxShiftsEnabled(this.checked)'),
     '开关的勾选事件接到 setMaxShiftsEnabled(this.checked)');
  ok(menuHtml.includes('id="maxShiftsHint"'), '源码里存在 id="maxShiftsHint"（说明文案）');
  ok(!menuHtml.includes('class="limit-row"'),
     '源码里不存在 class="limit-row"（旧的「每人每周最多班次」行已换成 opt-row 开关）');
  // 4. 学号录入搬进弹窗
  ok(menuHtml.includes('id="sidImportModal"'), '源码里存在 id="sidImportModal"（学号录入弹窗）');
  ok(g('typeof openSidImport') === 'function' && g('typeof closeSidImport') === 'function',
     'openSidImport / closeSidImport 均已定义');

  // 4b. 两处引导性注释文案已被删除（用户要求）：
  //     · 「个性化」菜单里的「『连续排班』等排班偏好仍在左侧面板设置。」
  //     · 左侧面板里的「在顶部『文件』菜单里点导入学号…录入学号（…也都在那里）。」
  //     删掉指引不等于删掉功能：下面同时断言开关与菜单项仍然可用。
  ok(!menuHtml.includes('排班偏好仍在左侧面板设置'),
     '源码里已删除「个性化」菜单的「排班偏好仍在左侧面板设置」注释');
  ok(!menuHtml.includes('编辑值班模板也都在那里'),
     '源码里已删除左侧面板的「导入学号…（…也都在那里）」注释');
  ok(menuHtml.includes('id="maxShiftsToggle"') && menuHtml.includes('id="continuousToggle"'),
     '删掉指引文案后，左侧两个开关（上限 / 连续排班）仍然存在');
  ok(menuHtml.includes('menuRun(openSidImport)'),
     '删掉指引文案后，「文件」菜单的「导入学号…」入口仍然存在');

  // 5. 主题快捷按钮**已被删除**（用户要求）：
  //    切换主题现在只有「个性化」菜单一个入口，菜单栏右侧不再有 #themeToggle，
  //    连带它的 .theme-btn 样式与 toggleTheme()/updateThemeIcon() 也一并不存在。
  ok(!menuHtml.includes('id="themeToggle"'),
     '源码里不存在 id="themeToggle"（菜单栏右侧的主题快捷按钮已删除）');
  ok(!menuHtml.includes('class="theme-btn"'),
     '源码里不存在 class="theme-btn"（连带样式一并删除）');
  ok(!/\.theme-btn\s*\{/.test(menuHtml),
     'CSS 里也没有 .theme-btn 规则残留（注释里提到它不算，这里查的是规则本身）');
  ok(g('typeof toggleTheme') === 'undefined',
     'toggleTheme() 已删除（不再有循环切换的快捷入口）');
  ok(g('typeof updateThemeIcon') === 'undefined',
     'updateThemeIcon() 已删除（它只服务于那个按钮）');
  // 但「个性化」菜单的三个主题项必须还在（切换主题的唯一入口）
  ok(menuHtml.includes('id="menuThemeDark"') && menuHtml.includes('id="menuThemeLight"')
     && menuHtml.includes('id="menuThemeAuto"'),
     '「个性化」菜单的三个主题项仍在（现在是切换主题的唯一入口）');
  ok(g("typeof applyTheme") === 'function',
     'applyTheme() 仍存在（菜单项与初始化都靠它）');

  // 6. 模板弹窗防误触（重点）：源码里刻意没有 click-outside 监听，
  //    但关闭入口（× / 取消 / Esc）仍然存在，不能因为「防误触」把关闭能力也删了。
  ok(!menuHtml.includes("document.getElementById('templateModal').addEventListener"),
     '源码里没有 #templateModal 的 click-outside 监听（点遮罩不会误关模板弹窗）');
  ok(menuHtml.includes('onclick="closeTemplateEditor()"'),
     '模板弹窗仍保留 × / 取消 的关闭入口');
  ok(g('typeof closeTemplateEditor') === 'function', 'closeTemplateEditor 函数仍存在');
  g('openTemplateEditor()');
  ok(el('templateModal').classList.contains('show'), 'openTemplateEditor 打开模板弹窗');
  g('closeTemplateEditor()');
  ok(!el('templateModal').classList.contains('show'), 'closeTemplateEditor 仍能关闭模板弹窗（× / 取消 可用）');
  // 对比项：学号弹窗**有** click-outside（两者行为刻意不同）
  ok(menuHtml.includes("document.getElementById('sidImportModal').addEventListener"),
     '对照：#sidImportModal 仍然保留 click-outside 关闭监听');

  // ── 学号导入弹窗的行为（loadStudents 读弹窗里的 #sidInput） ──
  g('state.students = []');
  g('openSidImport()');
  ok(el('sidImportModal').classList.contains('show'), 'openSidImport 给弹窗加上 show 类');
  g('closeSidImport()');
  ok(!el('sidImportModal').classList.contains('show'), 'closeSidImport 移除 show 类');

  // 校验失败（非法学号）→ 弹窗**不关**，方便用户直接改
  g('openSidImport()');
  el('sidInput').value = 'abc\n12345';
  g('loadStudents()');
  eq(g('state.students.length'), 0, '非法学号不会导入任何学生');
  ok(el('sidImportModal').classList.contains('show'),
     '校验失败时弹窗保持打开（不关窗，用户可直接修改）');
  // 空输入同样不关窗
  el('sidInput').value = '   ';
  g('loadStudents()');
  ok(el('sidImportModal').classList.contains('show'), '空输入时弹窗同样保持打开');

  // 成功导入：去重 + 非 10 位过滤 + 关窗 + 清空输入框
  el('sidInput').value = '2025210001\n2025210001\n123\n2025210002\n 2025210003 ';
  g('loadStudents()');
  eq(g('state.students.map(s => s.sid)'), ['2025210001', '2025210002', '2025210003'],
     'loadStudents 去重并过滤非 10 位学号（含首尾空白）');
  ok(!el('sidImportModal').classList.contains('show'), '导入成功后自动关闭弹窗');
  eq(el('sidInput').value, '', '导入成功后清空输入框');
  // 已存在的学号不会重复添加
  g('openSidImport()');
  el('sidInput').value = '2025210001';
  g('loadStudents()');
  eq(g('state.students.length'), 3, '重复导入已存在的学号不会重复添加');
  g('state.students = []');

  // 「个性化」二级菜单：深夜模式 + 主题对勾
  ok(menuHtml.includes('id="menuThemeDark"') && menuHtml.includes('menuThemeDarkCheck'),
     '「个性化」菜单含「深夜模式」及其对勾位');
  g("applyTheme('dark')");
  eq(g("getTheme()"), 'dark', 'applyTheme("dark") 生效');
  eq(el('menuThemeDarkCheck').textContent, '✓', '切到深夜模式后菜单里打勾');
  eq(el('menuThemeLightCheck').textContent, '', '未选中的日间模式不打勾');
  g("applyTheme('light')");
  eq(el('menuThemeLightCheck').textContent, '✓', '切到日间模式后对勾跟着移动');
  eq(el('menuThemeDarkCheck').textContent, '', '切到日间后深夜模式的对勾被清掉');
  g("applyTheme('auto')");
  eq(el('menuThemeAutoCheck').textContent, '✓', '跟随系统时对勾落在「跟随系统」');
  // 主题快捷按钮已删除后，对勾的同步不能依赖它（applyTheme 必须自己刷新菜单）
  ok(g("(function(){ applyTheme('dark'); return getTheme() === 'dark'; })()"),
     'applyTheme 直接刷新菜单对勾，不依赖已删除的 updateThemeIcon');
  eq(el('menuThemeDarkCheck').textContent, '✓', '删除快捷按钮后对勾仍能正确同步');
  g("applyTheme('auto')");

  // 「关于」二级菜单：使用指南 + 软件信息
  ok(/id="menuAbout"[\s\S]*?menuRun\(openGuide\)[\s\S]*?menuRun\(openAbout\)/.test(menuHtml),
     '「关于」菜单含「使用指南」与「软件信息」两项');
  ok(menuHtml.includes('id="aboutModal"'), '存在软件信息弹窗 #aboutModal');
  ok(menuHtml.includes('id="aboutVersion"') && menuHtml.includes('id="aboutBuild"')
     && menuHtml.includes('id="aboutOrigin"'),
     '软件信息弹窗含版本 / 构建时间 / 本地地址字段');

  // 打开软件信息会填好动态字段
  g('openAbout()');
  ok(String(el('aboutVersion').textContent).startsWith('v'), '软件信息显示版本号');
  eq(el('aboutBuild').textContent, g('APP_BUILD_DATE'), '软件信息显示构建时间');
  ok(String(el('aboutOrigin').textContent).length > 0, '软件信息显示本地地址（无 location 时回落默认值）');
  ok(el('aboutModal').classList.contains('show'), 'openAbout 打开弹窗');
  g('closeAbout()');
  ok(!el('aboutModal').classList.contains('show'), 'closeAbout 关闭弹窗');

  // 下拉面板的展开 / 收起：展开是互斥的，menuRun 先收起再执行动作
  g('closeAllMenus()');
  eq(g('openMenuId'), null, '初始状态没有展开的菜单');
  g("setMenuOpen('menuFile', true)");
  eq(g('openMenuId'), 'menuFile', '展开「文件」菜单');
  ok(el('menuFile').classList.contains('open'), '「文件」菜单加上 open 类');
  g("setMenuOpen('menuAbout', true)");
  ok(!el('menuFile').classList.contains('open'), '展开另一个菜单时前一个自动收起（互斥）');
  eq(g('openMenuId'), 'menuAbout', '当前展开的是「关于」');
  let ranMenuAction = false;
  g('window.__menuProbe = function(){ window.__menuRan = true; }');
  g('menuRun(window.__menuProbe)');
  eq(g('window.__menuRan'), true, 'menuRun 执行了传入的动作');
  eq(g('openMenuId'), null, 'menuRun 执行动作前先收起了菜单（避免下拉面板浮在弹窗上）');

  // ←→ 键在一级菜单间切换；Esc 收起
  g("setMenuOpen('menuFile', true)");
  g("onMenuBarKeydown({ key:'ArrowRight', preventDefault(){} })");
  eq(g('openMenuId'), 'menuPersonal', '→ 切到下一个一级菜单');
  g("onMenuBarKeydown({ key:'ArrowLeft', preventDefault(){} })");
  eq(g('openMenuId'), 'menuFile', '← 切回上一个一级菜单');
  g("onMenuBarKeydown({ key:'Escape' })");
  eq(g('openMenuId'), null, 'Esc 收起菜单');

  // 层叠：菜单栏必须高于左/右面板，否则下拉项被盖住点不到
  const menuZ = /\.top-menubar\s*\{[^}]*z-index\s*:\s*(\d+)/.exec(menuHtml);
  const leftZ = /\.left-panel\s*\{[^}]*z-index\s*:\s*(\d+)/.exec(menuHtml);
  ok(menuZ && leftZ && Number(menuZ[1]) > Number(leftZ[1]),
     '菜单栏 z-index 高于左侧面板（下拉项不被面板盖住）',
     { menubar: menuZ && menuZ[1], leftPanel: leftZ && leftZ[1] });
  ok(/\.menu-panel\s*\{[^}]*z-index\s*:\s*(\d+)/.test(menuHtml), '下拉面板自身也声明了 z-index');
  ok(menuHtml.indexOf('id="aboutModal"') > menuHtml.indexOf('id="confirmModal"'),
     '软件信息弹窗排在确认框之后（不改变 §6.7 的层叠前提）');

  // 菜单改了入口，提示文案必须跟着指路，否则用户找不到「导入学号」
  g('state.students = []; state.currentView = "duty"; refreshView();');
  ok(String(el('scheduleNotice').textContent).includes('「文件」菜单'),
     '未导入学号时的提示条指向顶部「文件」菜单');

  summary();
}).catch(e => {
  console.error('\n集成测试异常：', e);
  process.exitCode = 1;
});
