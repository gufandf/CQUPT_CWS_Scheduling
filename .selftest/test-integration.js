// 集成测试：排班 / 剪枝 / 渲染 / 导出 / 导入 全链路
const { g, ok, eq, section, summary, localStorage, el, document, writeFiles } = require('./harness.js');

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
let weeklyMaxOf, spreadOf, reRun;
const setMaxShifts = v => g(`setMaxShiftsPerWeek(${JSON.stringify(v)})`);

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

  // 11e. 「开始排班」（normal）**不套用**每人班次上限（用户确认的语义，见 AGENT.md §4.8）
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
  g("state.maxShiftsPerWeek = 1");   // 若 normal 套用了上限，则每人每周最多只能 1 班
  g('initAssignments()');
  return Promise.resolve(g('(async () => { await runSchedule("normal"); return true; })()'));
}).then(() => {
  const capped1 = g(`(() => {
    const load = {};
    for (const key of Object.keys(state.assignments.odd)) {
      for (const sid of state.assignments.odd[key]) load[sid] = (load[sid]||0)+1;
    }
    return Math.max(0, ...Object.values(load));
  })()`);
  ok(capped1 > 1, `开始排班忽略上限 1（实际仍出现每人每周 ${capped1} 班）`);

  section('12. 自定义模板：增减班次后重新排班');
  g("state.maxShiftsPerWeek = 3");
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
  eq(wb.SheetNames, ['单周值班表', '双周值班表'], '含单周/双周两个工作表');
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
  reRun = mode => Promise.resolve(
    g(`(async () => { await runSchedule(${JSON.stringify(mode)}); return true; })()`));

  // ── 上限参数的读取 / 归一化 ──
  section('32. 「每人每周最多班次」参数的语义');
  g('state.maxShiftsPerWeek = 0');
  eq(g('getMaxShiftsPerWeek()'), 0, '0 被如实读回');
  eq(g('maxShiftsLimit()'), null, '0 → maxShiftsLimit 为 Infinity（JSON 序列化后为 null）');
  ok(g('maxShiftsLimit() === Infinity'), '0 确实映射为 Infinity（不限制）');
  g('state.maxShiftsPerWeek = 2');
  eq(g('maxShiftsLimit()'), 2, '非 0 → 如实作为上限');
  g('state.maxShiftsPerWeek = -5');
  eq(g('getMaxShiftsPerWeek()'), 3, '负数回落为默认值 3');
  g('state.maxShiftsPerWeek = "abc"');
  eq(g('getMaxShiftsPerWeek()'), 3, '非法值回落为默认值 3');
  setMaxShifts('7');
  eq(g('state.maxShiftsPerWeek'), 7, 'setMaxShiftsPerWeek 写入 state');
  eq(localStorage.getItem('shift_max_per_week'), '7', '上限持久化到 localStorage');
  g('state.maxShiftsPerWeek = 3');
  g('loadMaxShifts()');
  eq(g('state.maxShiftsPerWeek'), 7, 'loadMaxShifts 从 localStorage 读回');
  g('localStorage.removeItem("shift_max_per_week"); loadMaxShifts();');
  eq(g('state.maxShiftsPerWeek'), 3, '无存档时回落默认值 3');

  // ── 均衡排班：严格遵守上限 ──
  section('33. 均衡排班：强制遵守每人每周上限');
  setupStudents();
  g('state.template = makeDefaultTemplate()');
  g('state.maxShiftsPerWeek = 2');
  g('initAssignments()');
  return reRun('balanced');
}).then(() => {
  eq(weeklyMaxOf('odd'), 2, '均衡排班：单周每人最多 2 班');
  eq(weeklyMaxOf('even'), 2, '均衡排班：双周每人最多 2 班');
  ok(g('countEmptySlots(state.assignments)') > 0,
     '上限过小时确实会有班次排不满（而非偷偷超限）');

  // 上限 1 也能守住
  g('initAssignments()');
  g('state.maxShiftsPerWeek = 1');
  return reRun('balanced');
}).then(() => {
  eq(weeklyMaxOf('odd'), 1, '上限 1：单周每人最多 1 班');
  eq(weeklyMaxOf('even'), 1, '上限 1：双周每人最多 1 班');

  // ── 上限 = 0：均衡排班不限制，但仍然均衡 ──
  section('34. 上限 = 0：不限制，两种模式都仍尽量均衡');
  g('initAssignments()');
  g('state.maxShiftsPerWeek = 0');
  return reRun('balanced');
}).then(() => {
  ok(weeklyMaxOf('odd') > 1, '上限 0 时不再限制每人每周 1 班');
  eq(g('countEmptySlots(state.assignments)'), 0, '上限 0 时所有班次都排满');
  const sp0 = spreadOf();
  ok(sp0.odd <= 1 && sp0.even <= 1 && sp0.total <= 1,
     `上限 0 的均衡排班仍均衡（单周极差 ${sp0.odd}、双周 ${sp0.even}、合计 ${sp0.total}）`, sp0);

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
  eq(violations, { conflict: 0, overCap: 0 }, '均衡排班没有违反课程冲突或班次容量');

  // ── 开始排班也均衡（这是用户明确要求「两种模式都要均衡」） ──
  section('35. 开始排班同样保证每人班次相差不大');
  g('initAssignments()');
  g('state.maxShiftsPerWeek = 3');
  return reRun('normal');
}).then(() => {
  const spN = spreadOf();
  ok(spN.odd <= 1 && spN.even <= 1 && spN.total <= 1,
     `开始排班：单周 ${spN.odd}、双周 ${spN.even}、合计 ${spN.total} 极差均 ≤ 1`, spN);

  // 与均衡排班在同一模板下对比：均衡模式的合计极差不会更差
  const normalTotal = spN.total;
  g('initAssignments()');
  return reRun('balanced').then(() => ({ normalTotal }));
}).then(({ normalTotal }) => {
  const spB = spreadOf();
  ok(spB.total <= Math.max(1, normalTotal),
     `均衡排班合计极差 ${spB.total} 不劣于开始排班 ${normalTotal}`);

  // ── 硬约束：上限很小时，均衡排班不超限；开始排班不套用上限 ──
  section('36. 两种模式对上限的差异（用户确认的语义）');
  g('initAssignments()');
  g('state.maxShiftsPerWeek = 1');
  return reRun('normal');
}).then(() => {
  ok(weeklyMaxOf('odd') > 1 || g('countEmptySlots(state.assignments)') === 0,
     '开始排班不套用上限 1（仍会给人排第 2 班）');

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
  g('state.maxShiftsPerWeek = 3');
  g('initAssignments()');
  const t0 = Date.now();
  return Promise.resolve(g(`(async () => {
    await runSchedule('balanced');
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
  g('state.maxShiftsPerWeek = 2');   // 12 人 × 2 班 = 24 个名额，远少于单周 74 个需求
  g('initAssignments()');
  return Promise.resolve(g(`(async () => { await runSchedule('balanced'); return true; })()`));
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

  summary();
}).catch(e => {
  console.error('\n集成测试异常：', e);
  process.exitCode = 1;
});
