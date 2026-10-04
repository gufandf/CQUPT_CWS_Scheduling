// 排班日分组自测：工作日/周末预设 ↔ 一周7天自由组合
// 重点验证：向后兼容、分组结构规范化、模式往返不丢排班、渲染/导出/排班跟随动态分组
const { g, ok, eq, section, summary, localStorage, el, writeFiles, rawHtml } = require('./harness.js');

const mkCourse = (name, weekday, begin, period, weeks, ignored) => ({
  name, courseId: `${name}_d${weekday}_p${begin}`, courseNum: 'C1', teacher: 'T', type: '必修',
  location: '101', rawWeek: '1-16周', weekday, beginPeriod: begin, endPeriod: begin + period - 1,
  periods: Array.from({ length: period }, (_, i) => begin + i), weeks,
  oddWeeks: weeks.filter(w => w % 2 === 1), evenWeeks: weeks.filter(w => w % 2 === 0),
  hasOdd: weeks.some(w => w % 2 === 1), hasEven: weeks.some(w => w % 2 === 0),
  isFullDay: period >= 8, ignored: !!ignored, autoIgnored: false,
});

function setupStudents(n) {
  const students = Array.from({ length: n }, (_, i) => {
    const sid = '202521' + String(i + 1).padStart(4, '0');
    return { sid, name: '同学' + sid.slice(-4), status: 'ready', courses: [], rawCourses: [], nowWeek: 8 };
  });
  g(`state.students = ${JSON.stringify(students)}`);
  return students;
}

section('L1. 预设模式：默认模板即「工作日/周末」');
const def = g('makeDefaultTemplate()');
eq(def.mode, 'weekday', '默认模板 mode = weekday');
eq(def.version, 2, '模板版本升到 2');
eq(def.layout.map(l => l.key), ['weekday', 'weekend'], '预设两组键保持 weekday / weekend（向后兼容）');
eq(def.layout.map(l => l.days), [[0, 1, 2, 3, 4], [5, 6]], '预设天数：周一~周五 / 周六~周日');

section('L2. 旧模板（无 mode/layout）→ 自动按预设解读');
const legacyTpl = g(`normalizeTemplate({ name:'旧模板', groups:{
  weekday:[{id:'wd0',label:'早班',start:'10:00',end:'12:05',capacity:2}],
  weekend:[{id:'we0',label:'周末班',start:'10:00',end:'12:00',capacity:1}]
}})`.replace(/\n/g, ''));
eq(legacyTpl.mode, 'weekday', '旧模板被解读为预设模式');
eq(legacyTpl.groups.weekday.length, 1, '旧模板工作日班次保留');
eq(legacyTpl.groups.weekend.length, 1, '旧模板周末班次保留');
eq(legacyTpl.groups.weekday[0].id, 'wd0', '旧模板班次 id 未被改写');

section('L3. 自定义分组规范化');
const custom1 = g(`normalizeTemplate({ name:'自定义', mode:'custom', layout:[
  {key:'a',name:'周一周二',days:[0,1]},
  {key:'b',name:'周三到周五',days:[2,3,4]},
  {key:'c',name:'周末',days:[5,6]}
], groups:{
  a:[{id:'a1',label:'A班',start:'10:00',end:'12:00',capacity:1}],
  b:[{id:'b1',label:'B班',start:'14:00',end:'16:00',capacity:2}],
  c:[{id:'c1',label:'C班',start:'09:00',end:'11:00',capacity:3}]
}})`.replace(/\n/g, ''));
eq(custom1.mode, 'custom', 'mode 保留为 custom');
eq(custom1.layout.map(l => l.key), ['a', 'b', 'c'], '三个自定义分组键保留');
eq(custom1.layout.map(l => l.days), [[0, 1], [2, 3, 4], [5, 6]], '各分组天数正确');
eq(custom1.groups.b.length, 1, '自定义分组班次保留');
eq(custom1.groups.b[0].id, 'b1', '自定义分组班次 id 保留');

section('L4. 分组天数去重 / 越界 / 同一天只归一个组');
const custom2 = g(`normalizeTemplate({ name:'脏', mode:'custom', layout:[
  {key:'a',name:'A',days:[0,0,1,99,-1,'x',3]},
  {key:'b',name:'B',days:[1,2,2,3]}
], groups:{ a:[], b:[] }})`.replace(/\n/g, ''));
eq(custom2.layout[0].days, [0, 1, 3], '第一组：去重 + 丢弃越界/非法值');
eq(custom2.layout[1].days, [2], '第二组：与第一组重叠的天被让出（同一天只归一个组）');

section('L5. 分组结构校验');
g(`state.tplDraft = normalizeTemplate({ name:'校验', mode:'custom', layout:[
  {key:'a',name:'A',days:[0,1]},{key:'b',name:'B',days:[2,3]}
], groups:{ a:[{id:'x',label:'X',start:'10:00',end:'12:00',capacity:1}], b:[] }})`.replace(/\n/g, ''));
eq(g('validateDraft()'), [], '合法自定义模板校验通过');

g("state.tplDraft = makeDefaultTemplate(); state.tplDraft.mode='custom'; state.tplDraft.layout[0].days=[0,1]; state.tplDraft.layout[1].days=[]");
const errsEmpty = g('validateDraft()');
ok(Array.isArray(errsEmpty), '空分组不抛异常');

section('L6. 访问器：按动态分组取班次');
g(`state.template = normalizeTemplate({ name:'两天制', mode:'custom', layout:[
  {key:'mw',name:'周一周二',days:[0,1]},
  {key:'rest',name:'其余五天',days:[2,3,4,5,6]}
], groups:{
  mw:[{id:'m1',label:'上午',start:'10:00',end:'12:00',capacity:2}],
  rest:[{id:'r1',label:'通用',start:'14:00',end:'16:00',capacity:2}]
}})`.replace(/\n/g, ''));
eq(g('getGroupKeyByDay(0)'), 'mw', '周一属于自定义分组 mw');
eq(g('getGroupKeyByDay(1)'), 'mw', '周二属于自定义分组 mw');
eq(g('getGroupKeyByDay(2)'), 'rest', '周三属于自定义分组 rest');
eq(g('getGroupKeyByDay(6)'), 'rest', '周日属于自定义分组 rest');
eq(g('getShiftsForDay(0).map(s=>s.id)'), ['m1'], '周一取到本组班次');
eq(g('getShiftsForDay(2).map(s=>s.id)'), ['r1'], '周三取到本组班次');
ok(g("getShiftById(0,'r1')") === null, '不能跨组取到别的分组的班次');

section('L7. 未分组的天 → 不排班');
g(`state.template = normalizeTemplate({ name:'留空', mode:'custom', layout:[
  {key:'a',name:'周一二',days:[0,1]}
], groups:{ a:[{id:'a1',label:'A',start:'10:00',end:'12:00',capacity:1}] }})`.replace(/\n/g, ''));
eq(g('ungroupedDays()'), [2, 3, 4, 5, 6], '未分组的天被识别出来');
eq(g('getShiftsForDay(3)'), [], '未分组的天没有班次');
g('initAssignments()');
const keysUngrouped = g('Object.keys(state.assignments.odd)');
eq(keysUngrouped.filter(k => k.startsWith('odd_d3_')).length, 0, '未分组的天不生成槽位');
eq(keysUngrouped.length, 1 * 2, '仅分组内的 2 天各 1 个槽位');
ok(!g("Object.keys(state.assignments.odd).some(k=>k.startsWith('odd_d5_'))"), '周六无槽位');

section('L8. 7 天各自一组：槽位 = 7 × 各组班次数');
g(`state.template = normalizeTemplate({ name:'每天独立', mode:'custom', layout:[
  {key:'day0',name:'周一',days:[0]},{key:'day1',name:'周二',days:[1]},
  {key:'day2',name:'周三',days:[2]},{key:'day3',name:'周四',days:[3]},
  {key:'day4',name:'周五',days:[4]},{key:'day5',name:'周六',days:[5]},
  {key:'day6',name:'周日',days:[6]}
], groups:{
  day0:[{id:'s0',label:'周一班',start:'10:00',end:'12:00',capacity:1}],
  day1:[{id:'s1',label:'周二班',start:'10:00',end:'12:00',capacity:1},
        {id:'s1b',label:'周二晚班',start:'18:00',end:'20:00',capacity:1}],
  day2:[{id:'s2',label:'周三班',start:'10:00',end:'12:00',capacity:1}],
  day3:[{id:'s3',label:'周四班',start:'10:00',end:'12:00',capacity:1}],
  day4:[{id:'s4',label:'周五班',start:'10:00',end:'12:00',capacity:1}],
  day5:[{id:'s5',label:'周六班',start:'10:00',end:'12:00',capacity:1}],
  day6:[{id:'s6',label:'周日班',start:'10:00',end:'12:00',capacity:1}]
}})`.replace(/\n/g, ''));
g('initAssignments()');
eq(g('Object.keys(state.assignments.odd).length'), 8, '7 天共 8 个槽位（周二有 2 班）');
ok(g("state.assignments.odd['odd_d1_s1b']") !== undefined, '周二第二个班次槽位存在');
ok(g("state.assignments.odd['odd_d6_s6']") !== undefined, '周日班次槽位存在');

section('L9. 模式切换：预设 → 自定义 → 预设，班次与排班都保留');
g('state.template = makeDefaultTemplate()');
g('initAssignments()');
g("state.assignments.odd['odd_d0_wd0'] = ['S1','S2']");
g("state.assignments.odd['odd_d2_wd0'] = ['S3']");
g("state.assignments.odd['odd_d5_we0'] = ['S4']");
const beforeSwitch = g('JSON.stringify(state.assignments.odd)');

g('state.tplDraft = JSON.parse(JSON.stringify(state.template))');
g("tplSetMode('custom')");
eq(g('state.tplDraft.mode'), 'custom', '切换到自定义模式');
eq(g('getLayout(state.tplDraft).length'), 2, '自定义模式下仍为 2 个分组（由预设转换而来）');
eq(g('getLayout(state.tplDraft).map(x=>x.days)'), [[0, 1, 2, 3, 4], [5, 6]], '天数原样带过去');
eq(g('state.tplDraft.groups.weekday.map(s=>s.id)'), ['wd0', 'wd1', 'wd2', 'wd3', 'wd4', 'wd5'], '班次 id 全部保留');

g("tplSetMode('weekday')");
eq(g('state.tplDraft.mode'), 'weekday', '切回预设模式');
eq(g('state.tplDraft.groups.weekday.map(s=>s.id)'), ['wd0', 'wd1', 'wd2', 'wd3', 'wd4', 'wd5'], '切回后工作日班次 id 不变');
eq(g('state.tplDraft.groups.weekend.map(s=>s.id)'), ['we0', 'we1', 'we2', 'we3'], '切回后周末班次 id 不变');

// 真正保存并剪枝：排班必须一条不少
g('saveTemplateEditor()');
g('state.assignments = { odd: ' + beforeSwitch + ', even: {} }');
g('remapAssignmentIds(_idRemap)');
const droppedAfterRoundTrip = g('pruneInvalidAssignments()');
eq(droppedAfterRoundTrip, [], '模式往返后没有任何排班被剪枝');
eq(g("JSON.stringify(state.assignments.odd['odd_d0_wd0'])"), JSON.stringify(['S1', 'S2']), '周一早班排班保留');
eq(g("JSON.stringify(state.assignments.odd['odd_d5_we0'])"), JSON.stringify(['S4']), '周六早班排班保留');

section('L10. 自定义分组重排：班次跟着天走，排班不丢');
g('state.template = makeDefaultTemplate(); initAssignments();');
g("state.assignments.odd['odd_d5_we0'] = ['X5']");
g("state.assignments.odd['odd_d6_we0'] = ['X6']");
g('state.tplDraft = JSON.parse(JSON.stringify(state.template))');
g("tplSetMode('custom')");
// 把周六从「周末」组挪到新的独立分组
g("tplAddGroup([5])");
eq(g('getLayout(state.tplDraft).length'), 3, '新增分组后共 3 组');
eq(g('getGroupForDay(5, state.tplDraft).name'), '分组3', '周六已归入新分组');
eq(g('getGroupForDay(6, state.tplDraft).days'), [6], '周日仍留在原周末分组');
// 应用草稿并剪枝（与 saveTemplateEditor 内部顺序一致）：周六的班次定义已不在该分组
g('state.template = normalizeTemplate(state.tplDraft)');
const droppedMove = g('pruneInvalidAssignments()');
ok(droppedMove.includes('odd_d5_we0'), '周六班次定义已不在该分组 → 其排班被剪枝并如实报告');
eq(g("state.assignments.odd['odd_d6_we0']"), ['X6'], '周日排班不受影响');

// 走真实保存路径：周六排班同样被清除
g("state.assignments.odd['odd_d5_we0'] = ['X5']");
g('state.tplDraft = JSON.parse(JSON.stringify(state.template))');
g('saveTemplateEditor()');
eq(g("state.assignments.odd['odd_d5_we0']"), undefined, '走 saveTemplateEditor 时周六排班同样被清除');
eq(g("state.assignments.odd['odd_d6_we0']"), ['X6'], '保存后周日排班仍然保留');

section('L11. 渲染跟随动态分组');
g(`state.template = normalizeTemplate({ name:'渲染', mode:'custom', layout:[
  {key:'g1',name:'周一周二',days:[0,1]},
  {key:'g2',name:'周三到周日',days:[2,3,4,5,6]}
], groups:{
  g1:[{id:'x1',label:'甲班',start:'10:00',end:'12:00',capacity:1}],
  g2:[{id:'y1',label:'乙班',start:'14:00',end:'16:00',capacity:1},
      {id:'y2',label:'丙班',start:'18:00',end:'20:00',capacity:1}]
}})`.replace(/\n/g, ''));
g('initAssignments()');
g("state.assignments.odd['odd_d0_x1']=['S1']");
g("state.currentView='duty'; state.currentWeek='odd';");
g('renderSchedule()');
const html = el('scheduleContainer').innerHTML;
ok(html.includes('周一周二'), '渲染含自定义分组名「周一周二」');
ok(html.includes('周三到周日'), '渲染含自定义分组名「周三到周日」');
ok(html.includes('甲班') && html.includes('乙班') && html.includes('丙班'), '渲染含各组班次名');
ok(!html.includes('周一至周五'), '不再出现旧预设分组名');
// 有效格 = 1班×2天 + 2班×5天 = 12；void = 1班×5天 + 2班×2天 = 9
eq((html.match(/class="shift-cell[^"]*" data-key/g) || []).length, 12, '有效班次格 12 个');
eq((html.match(/shift-cell void/g) || []).length, 9, '占位格 9 个');
eq((html.match(/class="shift-cell[^"]*" data-key/g) || []).length + (html.match(/shift-cell void/g) || []).length, 21,
   '总格数 21 = 1×7 + 2×7，无遗漏无重复');

section('L12. Excel 导出跟随动态分组');
g('state.template = makeDefaultTemplate(); initAssignments();');
g("state.students = [{sid:'2025210001',name:'甲同学',status:'ready',courses:[],rawCourses:[],nowWeek:8}]");
writeFiles.length = 0;
g('exportDutySchedule()');
eq(writeFiles.length, 1, '导出值班表调用了一次 XLSX.writeFile');
const rows = writeFiles[0].wb.Sheets['单周值班表'].rows;
const flat = rows.map(r => r.join('|'));
ok(flat.some(r => r.includes('周一至周五')), '预设模式导出含工作日分段行');
ok(flat.some(r => r.includes('周六至周日')), '预设模式导出含周末分段行');

g(`state.template = normalizeTemplate({ name:'导出', mode:'custom', layout:[
  {key:'a',name:'前两天',days:[0,1]},{key:'b',name:'后五天',days:[2,3,4,5,6]}
], groups:{
  a:[{id:'a1',label:'A班',start:'10:00',end:'12:00',capacity:2}],
  b:[{id:'b1',label:'B班',start:'14:00',end:'16:00',capacity:1}]
}})`.replace(/\n/g, ''));
writeFiles.length = 0;
g('exportDutySchedule()');
const rows2 = writeFiles[0].wb.Sheets['单周值班表'].rows;
const flat2 = rows2.map(r => r.join('|'));
ok(flat2.some(r => r.includes('前两天')), '自定义模式导出含自定义分组名');
ok(flat2.some(r => r.includes('后五天')), '自定义模式导出含自定义分组名');
ok(flat2.some(r => r.startsWith('A班 10:00-12:00')), '导出含班次名与时间');
const aRow = rows2.find(r => r[0] && r[0].startsWith('A班'));
eq(aRow.length, 9, 'A班行仍为 9 列（时间段 + 7 天 + 人数）');
eq(aRow.slice(3, 8), ['', '', '', '', ''], 'A班只在「前两天」的天上有单元格，其余天为空');
eq(aRow[8], 2, 'A班末列为人数 2');

section('L13. 导入导出往返：自定义分组模板');
const exportedTpl = g(`JSON.stringify(normalizeTemplate({ name:'往返', mode:'custom', layout:[
  {key:'a',name:'周一二三',days:[0,1,2]},{key:'b',name:'周四到周日',days:[3,4,5,6]}
], groups:{
  a:[{id:'a1',label:'A',start:'10:00',end:'12:00',capacity:1}],
  b:[{id:'b1',label:'B',start:'14:00',end:'16:00',capacity:2}]
}}))`.replace(/\n/g, ''));
const back = g(`normalizeTemplate(${exportedTpl})`);
eq(back.mode, 'custom', '往返后仍是自定义模式');
eq(back.layout.map(l => l.days), [[0, 1, 2], [3, 4, 5, 6]], '往返后天数分组不变');
eq(back.groups.a[0].id, 'a1', '往返后班次 id 不变（排班键可对上）');
eq(back.groups.b[0].capacity, 2, '往返后班次人数保留');

section('L14. 排班算法在自定义分组下可用（含冲突检测）');
setupStudents(12);
g(`state.template = normalizeTemplate({ name:'排班', mode:'custom', layout:[
  {key:'mw',name:'周一二',days:[0,1]},
  {key:'rest',name:'周三到周日',days:[2,3,4,5,6]}
], groups:{
  mw:[{id:'m1',label:'上午',start:'10:00',end:'12:00',capacity:2}],
  rest:[{id:'r1',label:'上午',start:'10:00',end:'12:00',capacity:2}]
}})`.replace(/\n/g, ''));
// 某学生周三第3-4节有课 → 周三上午（冲突节次 3,4）不可排
g(`state.students[0].courses = [${JSON.stringify(mkCourse('高数', 3, 3, 2, [1,2,3,4,5,6,7,8]))}]`);
g('initAssignments()');

Promise.resolve(g('(async () => { await runSchedule(); return true; })()')).then(() => {
  const over = g(`(() => {
    const bad = [];
    for (const wt of ['odd','even'])
      for (const key of Object.keys(state.assignments[wt])) {
        const info = resolveShift(key);
        const n = state.assignments[wt][key].length;
        if (info && n > info.shift.capacity) bad.push({key, n, cap: info.shift.capacity});
      }
    return bad;
  })()`);
  eq(over, [], '自定义分组下排班不超员');

  const wed = g("state.assignments.odd['odd_d2_r1'] || []");
  ok(!wed.includes('2025210001'), '自定义分组下冲突学生未被排入周三上午');
  const tue = g("state.assignments.odd['odd_d0_m1'] || []");
  ok(tue.length > 0, '同一天分组内的班次正常排到人');

  const orphans = g(`(() => {
    const bad = [];
    for (const wt of ['odd','even'])
      for (const key of Object.keys(state.assignments[wt])) {
        const info = resolveShift(key);
        if (!info || !shiftAppliesToWeek(info.shift, wt)) bad.push(key);
      }
    return bad;
  })()`);
  eq(orphans, [], '自定义分组下不存在孤儿槽位');

  section('L15. 未分组的天：排班与导出都不产生该天数据');
  g(`state.template = normalizeTemplate({ name:'留空', mode:'custom', layout:[
    {key:'a',name:'周一二',days:[0,1]}
  ], groups:{ a:[{id:'a1',label:'A',start:'10:00',end:'12:00',capacity:1}] }})`.replace(/\n/g, ''));
  g('initAssignments()');
  return Promise.resolve(g('(async () => { await runSchedule(); return true; })()'));
}).then(() => {
  eq(g('Object.keys(state.assignments.odd).length'), 2, '仅 2 个槽位（周一周二）');
  ok(!g("Object.keys(state.assignments.odd).some(k=>k.startsWith('odd_d3_'))"), '周四无槽位');
  eq(g('ungroupedDays()'), [2, 3, 4, 5, 6], '其余 5 天为未分组');

  writeFiles.length = 0;
  g('exportDutySchedule()');
  const r = writeFiles[0].wb.Sheets['单周值班表'].rows;
  ok(r.some(row => row.join('|').includes('未分组')), '导出的表中有未分组提示行');

  section('L16. 编辑器渲染：模式切换与天勾选控件');
  g('state.tplDraft = makeDefaultTemplate()');
  g('renderTemplateEditor()');
  const ed1 = el('tplBody').innerHTML;
  ok(ed1.includes('排班日分组'), '编辑器含「排班日分组」区域');
  ok(ed1.includes('工作日 / 周末'), '编辑器含预设模式按钮');
  ok(ed1.includes('一周 7 天自由组合'), '编辑器含自由组合模式按钮');
  ok(ed1.includes('tplSetMode'), '编辑器含模式切换调用');
  ok(!ed1.includes('tplToggleDay'), '预设模式下不显示天勾选');
  ok(!ed1.includes('tplAddGroup'), '预设模式下不显示「新增分组」');

  g("tplSetMode('custom')");
  const ed2 = el('tplBody').innerHTML;
  ok(ed2.includes('tplToggleDay'), '自定义模式显示天勾选');
  ok(ed2.includes('tplAddGroup'), '自定义模式显示「新增分组」');
  ok(ed2.includes('tpl-renameGroup') || ed2.includes('tplRenameGroup'), '自定义模式分组名可编辑');
  ok(ed2.includes('tplExplodeToDays'), '自定义模式含「每天独立」快捷按钮');
  ok(ed2.includes('tplRemoveGroup'), '自定义模式含删除分组按钮');
  ok(ed2.includes('星期归属'), '编辑器含星期归属一览');

  section('L17. 一键「每天独立」与「合并为工作日/周末」');
  g('state.tplDraft = makeDefaultTemplate()');
  g('tplExplodeToDays()');
  eq(g("state.tplDraft.mode"), 'custom', '每天独立 → 自定义模式');
  eq(g("getLayout(state.tplDraft).length"), 7, '拆成 7 个分组');
  eq(g("getLayout(state.tplDraft).map(x=>x.days.map(d=>d))"), [[0], [1], [2], [3], [4], [5], [6]], '每天各自一组');
  eq(g("state.tplDraft.groups.day0.map(s=>s.id)"), ['wd0', 'wd1', 'wd2', 'wd3', 'wd4', 'wd5'], '工作日班次带到周一');
  eq(g("state.tplDraft.groups.day5.map(s=>s.id)"), ['we0', 'we1', 'we2', 'we3'], '周末班次带到周六');

  g('tplCollapseToWeekdayWeekend()');
  eq(g("state.tplDraft.mode"), 'weekday', '合并回预设模式');
  eq(g("getLayout(state.tplDraft).map(x=>x.days)"), [[0, 1, 2, 3, 4], [5, 6]], '恢复工作日/周末天数');
  eq(g("state.tplDraft.groups.weekend.map(s=>s.id)"), ['we0', 'we1', 'we2', 'we3'], '周末班次合并且 id 未变');
  eq(g('validateDraft()'), [], '合并后校验通过');

  section('L18. 天数切换不会让班次 id 冲突');
  g('state.tplDraft = makeDefaultTemplate()');
  g('tplExplodeToDays()');
  const allIds = g(`(() => {
    const out = [];
    for (const g of getLayout(state.tplDraft)) for (const s of (state.tplDraft.groups[g.key]||[])) out.push(g.key + ':' + s.id);
    return out;
  })()`);
  ok(allIds.length > 0, '拆分后仍有班次定义');
  // 每个分组内部 id 唯一即可（排班键含天索引，跨组同名不影响解析）
  const dupInGroup = g(`(() => {
    const bad = [];
    for (const g of getLayout(state.tplDraft)) {
      const list = state.tplDraft.groups[g.key] || [];
      const seen = new Set();
      for (const s of list) { if (seen.has(s.id)) bad.push(g.key + ':' + s.id); seen.add(s.id); }
    }
    return bad;
  })()`);
  eq(dupInGroup, [], '每个分组内部班次 id 唯一');

  section('L19. 持久化：自定义分组模板存入 localStorage 后可读回');
  localStorage.clear();
  g(`state.template = normalizeTemplate({ name:'持久自定义', mode:'custom', layout:[
    {key:'a',name:'前半周',days:[0,1,2]},{key:'b',name:'后半周',days:[3,4,5,6]}
  ], groups:{
    a:[{id:'a1',label:'A',start:'10:00',end:'12:00',capacity:1}],
    b:[{id:'b1',label:'B',start:'14:00',end:'16:00',capacity:1}]
  }})`.replace(/\n/g, ''));
  g('persistTemplate()');
  g('state.template = makeDefaultTemplate()');
  g('loadTemplate()');
  eq(g('state.template.name'), '持久自定义', '读回模板名');
  eq(g('state.template.mode'), 'custom', '读回自定义模式');
  eq(g('state.template.layout.map(l=>l.days)'), [[0, 1, 2], [3, 4, 5, 6]], '读回分组天数');
  eq(g('state.template.groups.b[0].id'), 'b1', '读回班次 id');
  localStorage.clear();

  section('L20. 天数徽标不与分组名重复');
  // 预设两组：分组名本身就是天数描述 → 分组头里不再重复一遍
  g('state.tplDraft = makeDefaultTemplate()');
  g('renderTemplateEditor()');
  const edPreset = el('tplBody').innerHTML;
  ok(!edPreset.includes('tpl-group-days'), '预设模式分组头不再显示重复的天数徽标');
  ok(edPreset.includes('周一至周五') && edPreset.includes('周六至周日'), '预设模式仍显示分组名');
  // 自定义且名称与天数不同 → 徽标应出现
  g(`state.tplDraft = normalizeTemplate({ name:'徽标', mode:'custom', layout:[
    {key:'a',name:'前半周',days:[0,1,2]},{key:'b',name:'后半周',days:[3,4,5,6]}
  ], groups:{ a:[], b:[] }})`.replace(/\n/g, ''));
  g('renderTemplateEditor()');
  const edCustom = el('tplBody').innerHTML;
  ok(edCustom.includes('tpl-group-days'), '自定义模式下名称与天数不同时显示天数徽标');
  ok(edCustom.includes('周一至周三') && edCustom.includes('周四至周日'), '徽标内容为压缩后的天数区间');
  // describeTemplate 同样不重复
  eq(g('groupDaysBadge({name:"周一至周五",days:[0,1,2,3,4]})'), '', '名称与天数一致 → 徽标为空');
  eq(g('groupDaysBadge({name:"前半周",days:[0,1,2]})'), '周一至周三', '名称与天数不同 → 徽标为天数区间');
  eq(g('groupDaysText({name:"x",days:[]})'), '不排班', '无天 → 不排班');
  eq(g('groupDaysText({name:"x",days:[0,1,2,3,4,5,6]})'), '每天', '七天 → 每天');
  eq(g('groupDaysText({name:"x",days:[0,2,4]})'), '周一、周三、周五', '不连续的天用顿号分隔');

  section('L21. 新增分组：自动摘走该天，不留下双归属');
  g('state.tplDraft = makeDefaultTemplate()');
  g("tplSetMode('custom')");
  g('tplAddGroup([2])');
  eq(g('getGroupForDay(2, state.tplDraft).key'), 'g3', '周三归入新分组');
  eq(g('getGroupForDay(2, state.tplDraft).days'), [2], '新分组只含周三');
  eq(g('getLayout(state.tplDraft).find(x=>x.key==="weekday").days'), [0, 1, 3, 4], '周三已从「周一至周五」摘除');
  eq(g('ungroupedDays(state.tplDraft)'), [], '7 天仍全部有归属（无重复、无遗漏）');
  // 全量不变式：每天恰好属于一个分组
  eq(g(`(() => {
    const cnt = {};
    for (const g of getLayout(state.tplDraft)) for (const d of g.days) cnt[d] = (cnt[d]||0)+1;
    return Object.keys(cnt).length + ':' + Math.max(...Object.values(cnt));
  })()`), '7:1', '每一天恰好属于一个分组');
  eq(g('validateDraft()'), [], '该状态校验通过（新分组无班次仅作提示）');
  ok(g('templateWarnings()').some(w => w.includes('分组3')), '新分组无班次被提示（不阻止保存）');

  section('L22. 单双周在自定义分组下依然生效');
  g(`state.template = normalizeTemplate({ name:'单双周自定义', mode:'custom', layout:[
    {key:'a',name:'周一二',days:[0,1]},{key:'b',name:'周三到周日',days:[2,3,4,5,6]}
  ], groups:{
    a:[{id:'a1',label:'单周班',start:'10:00',end:'12:00',capacity:1,weeks:'odd'},
       {id:'a2',label:'双周班',start:'14:00',end:'16:00',capacity:1,weeks:'even'}],
    b:[{id:'b1',label:'通用',start:'10:00',end:'12:00',capacity:1,weeks:'all'}]
  }})`.replace(/\n/g, ''));
  g('initAssignments()');
  const oddK = g('Object.keys(state.assignments.odd)');
  const evenK = g('Object.keys(state.assignments.even)');
  ok(oddK.includes('odd_d0_a1'), '自定义分组内单周班在单周生成槽位');
  ok(!oddK.includes('odd_d0_a2'), '自定义分组内双周班不在单周生成槽位');
  ok(evenK.includes('even_d0_a2'), '自定义分组内双周班在双周生成槽位');
  ok(oddK.includes('odd_d2_b1') && evenK.includes('even_d2_b1'), '通用班次在单双周都生成');

  section('L23. 未点「开始排班」也显示当前模板的时段表格');
g('state.template = makeDefaultTemplate();');
g('state.assignments = { odd: {}, even: {} };');   // 全新打开、尚未排班
g("state.students = []; renderStudentList();");
g("state.currentView='duty'; state.currentWeek='odd';");
g('refreshView()');
const preHtml = el('scheduleContainer').innerHTML;
ok(preHtml.includes('周一至周五') && preHtml.includes('周六至周日'), '未排班时仍渲染两个分组');
ok(preHtml.includes('早班') && preHtml.includes('晚班②'), '未排班时仍渲染班次名与时段');
eq((preHtml.match(/class="shift-cell[^"]*" data-key/g) || []).length, 38, '未排班时空槽位格 38 个（全部可用）');
ok(preHtml.includes('>0/2<'), '未排班时人数显示为 0/2');
eq(el('scheduleContainer').style.display, 'block', '值班表容器可见（不再被空状态顶掉）');
ok(el('scheduleNotice').style.display === 'block', '显示「尚未导入学号」提示条');
ok(el('scheduleNotice').textContent.includes('尚未导入学号'), '提示文案指向导入学号');

// 导入学号后（尚未点开始排班）→ 提示变为「尚未排班」，表格照旧
g("state.students = [{sid:'2025210001',name:'甲同学',status:'pending',courses:null}]; renderStudentList();");
g('refreshView()');
ok(el('scheduleNotice').textContent.includes('尚未排班'), '已导入学号但未排班 → 提示「尚未排班」');
eq(el('scheduleContainer').style.display, 'block', '提示条不遮挡表格');

// 拖拽依赖槽位存在：表格里能看到的格子必须能拖进去
eq(g("state.assignments.odd['odd_d0_wd0']"), [], '渲染时已补齐空槽位，拖拽不会报「无效的目标班次」');
eq(g("hasAnyAssignment()"), false, '空槽位不算「已排班」');
g('updateButtons()');
ok(el('btnExportDuty').disabled === true, '尚未排班时「导出值班表」仍禁用');

section('L24. 空课表视图：未获取课表也显示表格骨架');
g("state.currentView='free'; state.assignments = { odd: {}, even: {} };");
g('refreshView()');
eq(el('freeContainer').style.display, 'block', '空课表容器可见');
eq(el('scheduleContainer').style.display, 'none', '值班表容器隐藏');
ok(el('freeContainer').innerHTML.includes('早班'), '空课表也渲染班次时段');
ok(el('scheduleNotice').textContent.includes('尚未获取课表'), '提示「尚未获取课表」');
g("state.students[0].status='ready'; state.students[0].courses=[];");
g('refreshView()');
ok(el('freeContainer').innerHTML.includes('全员空闲'), '获取课表后显示空闲同学');
eq(el('scheduleNotice').style.display, 'none', '有课表数据后提示条自动隐藏');

section('L25. 清空 / 重置后表格仍在');
g("state.currentView='duty';");
g("state.assignments = { odd: {}, even: {} }; state.students = [];");
g('refreshView()');
eq((el('scheduleContainer').innerHTML.match(/class="shift-cell[^"]*" data-key/g) || []).length, 38,
   '重置排班后仍显示 38 个空槽位');
ok(el('scheduleNotice').textContent.includes('尚未导入学号'), '清空后回到「尚未导入学号」提示');

section('L25b. 学号列表入场动画：只有新条目才播，刷新课表不再整列抽搐');

// 静态断言：opacity/animation 不能挂在 .student-item 本身，否则每次整段重写 innerHTML
// 都会让整列重放动画（每收到一个课表就重渲染一次 → 导入 N 个学号就抽搐 N 次）。
const listCss = /\.student-item\s*\{[^}]*\}/.exec(rawHtml())[0];
ok(!/animation\s*:/.test(listCss), '.student-item 自身不再声明 animation');
ok(!/opacity\s*:\s*0/.test(listCss), '.student-item 自身不再置 opacity:0');
ok(/\.student-item\.is-new\s*\{[^}]*animation\s*:/.test(rawHtml()),
   '入场动画改挂在 .student-item.is-new 上');
// 错峰曾写死成 nth-child(1)~(5)，只有前 5 条拿到延迟 → 后 20 条同时起跑，
// 用户看到「只有前五个有缓入动画」。现在改成逐条写 CSS 变量，所有人都参与。
ok(!/\.student-item\.is-new:nth-child\(/.test(rawHtml()),
   '错峰不再写死成 nth-child(1)~(5)（那会让第 6 条起没有延迟）');
ok(/\.student-item\.is-new\s*\{[^}]*animation-delay\s*:\s*var\(--stagger-delay/.test(rawHtml()),
   '错峰改为逐条注入 CSS 变量 --stagger-delay');
ok(/@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(rawHtml()),
   '尊重系统「减少动态效果」设置');

// 行为断言：首次渲染所有人都标 is-new；再渲染（状态变化）则一个都不标
g("state.assignments = { odd: {}, even: {} }; _animatedSids = new Set();");
g(`state.students = [
  {sid:'2025210001',name:'甲',status:'pending',courses:null},
  {sid:'2025210002',name:'乙',status:'pending',courses:null},
  {sid:'2025210003',name:'丙',status:'pending',courses:null}
]`);
g('renderStudentList()');
const firstHtml = el('studentList').innerHTML;
eq((firstHtml.match(/class="student-item is-new"/g) || []).length, 3, '首次渲染 3 项都播入场动画');
eq((firstHtml.match(/class="student-item"/g) || []).length, 0, '首次渲染没有不带 is-new 的项');

// 模拟「刷新课表」：状态逐个变化后重渲染，此时不应再有动画
g("state.students.forEach(s => s.status = 'loading'); renderStudentList();");
eq((el('studentList').innerHTML.match(/is-new/g) || []).length, 0,
   '刷新课表时重渲染不再重放动画（0 项 is-new）');
g("state.students[0].status = 'ready'; renderStudentList();");
eq((el('studentList').innerHTML.match(/is-new/g) || []).length, 0,
   '单个课表返回后重渲染也不重放动画');

// 新增学号时，只有新来的那个播动画
g("state.students.push({sid:'2025210004',name:'丁',status:'pending',courses:null}); renderStudentList();");
const addHtml = el('studentList').innerHTML;
eq((addHtml.match(/is-new/g) || []).length, 1, '新增 1 人时只有这 1 项播动画');
ok(/data-sid="2025210004"[^>]*/.test(addHtml) && /class="student-item is-new"[^>]*data-sid="2025210004"/.test(addHtml),
   '播动画的正是新增的那一项');

// 清空后再导入，应当重新播（否则列表会「没有入场动画」）
g("state.students = []; renderStudentList();");
g("state.students = [{sid:'2025210009',name:'戊',status:'pending',courses:null}]; renderStudentList();");
eq((el('studentList').innerHTML.match(/is-new/g) || []).length, 1, '清空后重新导入会重新播动画');

// 错峰：批量导入时**每一条**都要有自己的延迟，而不是只有前 5 条
// （曾经的 bug：nth-child(1)~(5) 之外一律 0s → 第 6 条起同时起跑，看起来没有缓入）
const many = Array.from({ length: 25 }, (_, i) =>
  `{sid:'202522${String(i + 1).padStart(4, '0')}',name:'同学${i + 1}',status:'pending',courses:null}`);
g(`state.students = [${many.join(',')}]; _animatedSids = new Set(); renderStudentList();`);
const bulkHtml = el('studentList').innerHTML;
const delays = [...bulkHtml.matchAll(/--stagger-delay:(\d+)ms/g)].map(m => Number(m[1]));
eq(delays.length, 25, '25 条批量导入：25 条都注入了错峰延迟（不是只有前 5 条）');
eq(delays[0], 0, '第一条延迟为 0（立即开始）');
ok(delays.every((d, i) => i === 0 || d > delays[i - 1]), '延迟严格递增，逐条错峰');
eq(new Set(delays).size, 25, '25 条延迟互不相同');
ok(delays[delays.length - 1] <= 400,
   '总错峰封顶 400ms（人多时不至于让列表等太久）', delays[delays.length - 1]);
ok(delays[1] > 0 && delays[5] > delays[4], '第 6 条也带延迟（这正是此前漏掉的那一批）');

// 人数很多时压缩间隔：仍封顶，且全员参与
const big = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({
  sid: '20253' + String(i + 1).padStart(5, '0'), name: 'x' + i, status: 'pending', courses: null,
})));
g(`state.students = ${big}; _animatedSids = new Set(); renderStudentList();`);
const bigDelays = [...el('studentList').innerHTML.matchAll(/--stagger-delay:(\d+)ms/g)].map(m => Number(m[1]));
eq(bigDelays.length, 200, '200 条时仍然全员错峰');
ok(bigDelays[bigDelays.length - 1] <= 400, '200 条时总错峰仍封顶 400ms', bigDelays[bigDelays.length - 1]);

// 单独新增 1 人时不该有错峰延迟（只有它自己，step=0）
g("state.students = [{sid:'2025210001',name:'甲',status:'pending',courses:null}]; _animatedSids = new Set(); renderStudentList();");
g("state.students.push({sid:'2025210002',name:'乙',status:'pending',courses:null}); renderStudentList();");
const oneNewHtml = el('studentList').innerHTML;
eq((oneNewHtml.match(/is-new/g) || []).length, 1, '单独新增 1 人时只有它播动画');
ok(!/--stagger-delay/.test(oneNewHtml), '只有 1 个新条目时不写错峰延迟（无需等待）');

// 同一个人删掉后重新导入，也要能再播一次
g("state.students = [{sid:'2025210009',name:'戊',status:'pending',courses:null},{sid:'2025210010',name:'己',status:'pending',courses:null}]; renderStudentList();");
g("state.students = state.students.filter(s => s.sid !== '2025210009'); renderStudentList();");
g("state.students.push({sid:'2025210009',name:'戊',status:'pending',courses:null}); renderStudentList();");
ok(/class="student-item is-new"[^>]*data-sid="2025210009"/.test(el('studentList').innerHTML),
   '被移除的人重新导入后仍会播放入场动画（集合不会无限增长地挡住动画）');

// 就地更新：刷新课表时只改单条，不整列重写（保住滚动位置与 hover）
g("state.students = [{sid:'2025210001',name:'旧名',status:'loading',courses:null}]; renderStudentList();");
g("state.students[0].name = '新名'; state.students[0].status = 'ready';");
eq(g("updateStudentListItem('2025210001')"), true, '就地更新命中已渲染的条目');
const inPlaceHtml = el('studentList').innerHTML;
ok(inPlaceHtml.includes('新名'), '就地更新写入新姓名');
ok(inPlaceHtml.includes('status-ready') && inPlaceHtml.includes('已就绪'), '就地更新写入新状态徽标');
ok(!inPlaceHtml.includes('status-loading'), '旧状态类被替换掉');
eq(g("updateStudentListItem('2025999999')"), false, '条目不在 DOM 中时返回 false，调用方可回退整列重渲染');

section('L26. 分组只配单周 / 只配双周：合法配置，全链路可用');

// 场景：工作日组只在单周排班，周末组照常每周——保存不再被拦截
g(`state.tplDraft = normalizeTemplate({ name:'单周工作日', mode:'custom', layout:[
  {key:'wd',name:'周一至周五',days:[0,1,2,3,4]},
  {key:'we',name:'周六至周日',days:[5,6]}
], groups:{
  wd:[{id:'a',label:'工作日班',start:'10:00',end:'12:00',capacity:2,weeks:'odd'}],
  we:[{id:'b',label:'周末班',start:'10:00',end:'12:00',capacity:2}]
}})`.replace(/\n/g, ''));
eq(g('validateDraft()'), [], '工作日组仅单周 → 校验通过（不再被拦截）');
ok(g('templateWarnings()').some(w => w.includes('周一至周五') && w.includes('仅在单周')),
   '编辑器提示该组仅单周有班次');
eq(g("groupWeekScope(state.tplDraft.groups.wd)"), 'odd', 'workday 组识别为仅单周');
eq(g("groupWeekScope(state.tplDraft.groups.we)"), 'all', 'weekend 组识别为每周');
eq(g("hasShiftsForWeek('odd', state.tplDraft)"), true, '单周有班次');
eq(g("hasShiftsForWeek('even', state.tplDraft)"), true, '双周仍有周末班次 → 不提示整周空表');
ok(!g('templateWarnings()').some(w => w.includes('没有任何生效班次，该周的值班表将为空')),
   '仍有双周班次时不提示整周空表');

// 真正保存 → 槽位只在该组生效的周生成，另一周不生成
g('saveTemplateEditor()');
eq(g("state.template.groups.wd[0].weeks"), 'odd', '保存后单周设置保留');
const oddKeys = g('Object.keys(state.assignments.odd)');
const evenKeys = g('Object.keys(state.assignments.even)');
eq(oddKeys.filter(k => k.startsWith('odd_d0_')).length, 1, '单周：周一生成工作日组槽位');
eq(evenKeys.filter(k => k.startsWith('even_d0_')).length, 0, '双周：周一不生成工作日组槽位（合法）');
eq(evenKeys.filter(k => k.startsWith('even_d5_')).length, 1, '双周：周六照常生成槽位');

// 表格渲染：单周显示工作日组班次，双周该组给出「仅配置了单周」的说明
g("state.students = [{sid:'2025210001',name:'甲同学',status:'ready',courses:[]}];");
g("state.currentView='duty'; state.currentWeek='odd';");
g('refreshView()');
const oddHtml = el('scheduleContainer').innerHTML;
ok(oddHtml.includes('工作日班'), '单周渲染出工作日组班次');
ok(oddHtml.includes('仅单周'), '单周时分组头带「仅单周」徽标');
ok(!oddHtml.includes('没有班次（该组仅配置了'), '单周不会出现「本周无班次」提示');

g("state.currentWeek='even';");
g('refreshView()');
const evenHtml = el('scheduleContainer').innerHTML;
ok(!evenHtml.includes('工作日班'), '双周不渲染工作日组班次');
ok(evenHtml.includes('仅配置了单周'), '双周对该组给出「仅配置了单周」的说明，而非报错');
ok(evenHtml.includes('周末班'), '双周仍渲染周末组班次');
g("state.currentWeek='odd'; refreshView();");

// 导出：两个工作表都存在，双周表不含工作日组班次
writeFiles.length = 0;
g('exportDutySchedule()');
const wbWk = writeFiles[0].wb;
eq(wbWk.SheetNames, ['单周值班表', '双周值班表', '人员表'], '仍然导出单双周两个值班表 + 人员表');
const oddRows = wbWk.Sheets['单周值班表'].rows.map(r => r.join('|'));
const evenRows = wbWk.Sheets['双周值班表'].rows.map(r => r.join('|'));
ok(oddRows.some(r => r.includes('工作日班 10:00-12:00')), '单周表含工作日班');
ok(!evenRows.some(r => r.includes('工作日班 10:00-12:00')), '双周表不含工作日班');
ok(evenRows.some(r => r.includes('周一至周五') && r.includes('本周无班次')),
   '双周表仍保留该分组行并标注「本周无班次」（不丢结构）');
ok(evenRows.some(r => r.includes('周末班')), '双周表含周末班');

section('L27. 整模板仅单周：双周表为空但不报错');
g(`state.template = normalizeTemplate({ name:'全单周', mode:'custom', layout:[
  {key:'a',name:'全都',days:[0,1,2,3,4,5,6]}
], groups:{ a:[{id:'a1',label:'单周班',start:'10:00',end:'12:00',capacity:1,weeks:'odd'}] }})`.replace(/\n/g, ''));
g("state.tplDraft = normalizeTemplate(state.template);");
eq(g('validateDraft()'), [], '整模板仅单周 → 校验通过');
eq(g("hasShiftsForWeek('even', state.tplDraft)"), false, '双周无任何生效班次');
ok(g('templateWarnings()').some(w => w.includes('双周没有任何生效班次')), '提示双周空表');
g('initAssignments()');
eq(g('Object.keys(state.assignments.even)').length, 0, '双周不生成任何槽位');
eq(g('Object.keys(state.assignments.odd)').length, 7, '单周 7 天各 1 个槽位');

summary();
}).catch(e => {
  console.error('\n分组测试异常：', e);
  process.exitCode = 1;
});
