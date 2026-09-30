const { g, ok, eq, section, summary, localStorage } = require('./harness.js');

section('1. 默认模板与旧配置等价（向后兼容性）');
const defTpl = g('makeDefaultTemplate()');
eq(defTpl.groups.weekday.length, 6, '工作日默认 6 个班次');
eq(defTpl.groups.weekend.length, 4, '周末默认 4 个班次');
eq(defTpl.groups.weekday.map(s => `${s.label} ${s.start}-${s.end} ${s.capacity}`),
   ['早班 10:00-12:05 2', '午班① 12:05-13:45 3', '午班② 13:45-15:50 2',
    '下午班 15:50-18:00 2', '晚班① 18:00-19:45 2', '晚班② 19:45-21:35 1'],
   '工作日班次与原硬编码配置逐项一致（名称/时间/人数）');
eq(defTpl.groups.weekend.map(s => `${s.label} ${s.start}-${s.end} ${s.capacity}`),
   ['早班 10:00-12:00 2', '午班① 12:00-14:00 2', '午班② 14:00-16:00 2', '下午班 16:00-18:00 1'],
   '周末班次与原硬编码配置逐项一致');

section('2. 冲突节次自动推导');
eq(g("deriveConflictPeriods('10:00','12:05')"), [3, 4], '工作日早班 10:00-12:05 → [3,4]（与原配置一致）');
eq(g("deriveConflictPeriods('12:05','13:45')"), [], '午休班 12:05-13:45 → 无冲突（与原配置一致）');
eq(g("deriveConflictPeriods('13:45','15:50')"), [5, 6], '午班② 13:45-15:50 → [5,6]（一致）');
eq(g("deriveConflictPeriods('15:50','18:00')"), [7, 8], '下午班 15:50-18:00 → [7,8]（一致）');
eq(g("deriveConflictPeriods('18:00','19:45')"), [9], '晚班① 18:00-19:45 → [9]（一致）');
eq(g("deriveConflictPeriods('19:45','21:35')"), [10, 11], '晚班② 修正原配置漏掉的第11节(20:50-21:35)');
eq(g("deriveConflictPeriods('8:00','8:45')"), [1], '第1节时段 → [1]');
eq(g("deriveConflictPeriods('10:00','12:00')"), [3, 4], '周末早班 10:00-12:00 → [3,4]（与原配置一致）');
eq(g("deriveConflictPeriods('12:00','14:00')"), [], '周末午班① 12:00-14:00 → []（第5节14:00起，首尾相接不算，与原配置一致）');
eq(g("deriveConflictPeriods('9:40','10:15')"), [], '课间缝隙 9:40-10:15 → 无冲突（首尾相接不算）');
eq(g("deriveConflictPeriods('22:00','23:00')"), [12], '22:00-23:00 与第12节(21:45-22:30)重叠 → [12]');
eq(g("deriveConflictPeriods('22:30','23:30')"), [], '22:30 起（第12节已结束）→ 无冲突');
eq(g("deriveConflictPeriods('21:00','21:45')"), [11], '21:00-21:45 → [11]（第12节 21:45 起，首尾相接不算）');
eq(g("deriveConflictPeriods('20:45','22:00')"), [11, 12], '20:45-22:00 跨第11、12节 → [11,12]');
eq(g("deriveConflictPeriods('bad','data')"), [], '非法输入 → 空数组');
eq(g("deriveConflictPeriods('12:00','11:00')"), [], '结束早于开始 → 空数组');
eq(g("deriveConflictPeriods('00:00','23:59')"), [1,2,3,4,5,6,7,8,9,10,11,12], '全天班 → 全部节次');

section('3. 时间工具');
ok(g("isValidTime('8:00')") === true, "isValidTime 接受 '8:00'（单数字小时）");
ok(g("isValidTime('08:00')") === true, "isValidTime 接受 '08:00'");
ok(g("isValidTime('24:00')") === false, "isValidTime 拒绝 '24:00'");
ok(g("isValidTime('8:60')") === false, "isValidTime 拒绝 '8:60'");
ok(g("isValidTime('abc')") === false, 'isValidTime 拒绝非时间字符串');
ok(g("isValidTime('')") === false, 'isValidTime 拒绝空串');
eq(g("minutesToTime(600)"), '10:00', 'minutesToTime(600) → 10:00');
eq(g("minutesToTime(1305)"), '21:45', 'minutesToTime(1305) → 21:45');
eq(g("timeToMinutes('21:45')"), 1305, "timeToMinutes('21:45') → 1305");

section('4. 班次键：稳定 ID（模板改动不错位 —— 本次重构的核心）');
eq(g("generateShiftKey('odd',0,'wd0')"), 'odd_d0_wd0', '键格式 weekType_dayIdx_shiftId');
eq(g("parseShiftKey('odd_d0_wd0')"), { weekType: 'odd', dayIdx: 0, shiftId: 'wd0' }, '解析单周工作日班次');
eq(g("parseShiftKey('even_d5_we3')"), { weekType: 'even', dayIdx: 5, shiftId: 'we3' }, '解析双周周末班次');
eq(g("sanitizeShiftId('wdCustom_123','wd')"), 'wdCustom123', '导入的 id 被清洗掉下划线（下划线是键分隔符）');
eq(g("parseShiftKey('odd_d0_wdCustom123')"), { weekType: 'odd', dayIdx: 0, shiftId: 'wdCustom123' },
   '清洗后的自定义 id 可正确解析');
eq(g("sanitizeShiftId('',  'wd').startsWith('wd')"), true, '空 id 自动生成');
eq(g("sanitizeShiftId(null,'we').startsWith('we')"), true, 'null id 自动生成');
ok(g("sanitizeShiftId('wd 0!@#','wd')") === 'wd0', '非法字符被剔除');
eq(g("parseShiftKey('bad')"), null, '非法键 → null');
eq(g("parseShiftKey('xxx_d0_wd0')"), null, '非法周类型 → null');
eq(g("parseShiftKey('odd_d9_wd0')"), null, '越界 dayIdx → null');
eq(g("parseShiftKey('odd_d0_')"), null, '空 shiftId → null');
eq(g("parseShiftKey(null)"), null, 'null → null');

section('5. 单双周生效判定');
ok(g("shiftAppliesToWeek({weeks:'all'},'odd')") === true, '每周班次在单周生效');
ok(g("shiftAppliesToWeek({weeks:'all'},'even')") === true, '每周班次在双周生效');
ok(g("shiftAppliesToWeek({weeks:'odd'},'odd')") === true, '单周班次在单周生效');
ok(g("shiftAppliesToWeek({weeks:'odd'},'even')") === false, '单周班次在双周不生效');
ok(g("shiftAppliesToWeek({weeks:'even'},'odd')") === false, '双周班次在单周不生效');
ok(g("shiftAppliesToWeek({weeks:'even'},'even')") === true, '双周班次在双周生效');

section('6. 模板规范化（脏数据 / 边界 / 历史格式）');
const norm = (obj) => g(`normalizeTemplate(${JSON.stringify(obj)})`);

const t1 = norm({
  name: 'T', groups: {
    weekday: [
      { id: 'a', label: 'A', start: '09:00', end: '10:00', capacity: 2 },
      { id: 'a', label: '重复ID', start: '10:00', end: '11:00', capacity: 'x' },
      { id: 'c', label: 'C', start: 'bad', end: '11:00', capacity: 1 },
      { id: 'd', label: 'D', start: '20:00', end: '19:00', capacity: 1 },
      null, 'garbage', 42,
    ], weekend: []
  }
});
eq(t1.groups.weekday.length, 2, '丢弃非法/脏项后仅保留合法班次');
ok(t1.groups.weekday[0].id !== t1.groups.weekday[1].id, '重复 id 被自动重编号');
eq(t1.groups.weekday[0].capacity, 2, '合法容量保留');
eq(t1.groups.weekday[1].capacity, 1, '非法容量回退为 1');
eq(t1.groups.weekday[0].autoConflict, true, '缺省即自动推导模式');
eq(t1.groups.weekday[0].conflictPeriods, [2], "09:00-10:00 与第2节(8:55-9:40)重叠 → [2]");
eq(t1.groups.weekend, [], '空分组予以保留（不强行塞默认班次）');

const t2 = norm({ weekday: [{ id: 'x', label: '历史', time: '10:00-12:05', capacity: 2, conflictPeriods: [3, 4] }] });
eq(t2.groups.weekday.length, 1, '兼容历史 time:"10:00-12:05" 字符串格式');
eq([t2.groups.weekday[0].start, t2.groups.weekday[0].end], ['10:00', '12:05'], '历史 time 拆分为 start/end');

eq(norm(null).groups.weekday.length, 6, 'null → 回退默认模板');
eq(norm({}).groups.weekday.length, 6, '空对象 → 回退默认模板（保持向后兼容）');
eq(norm('not an object').name, '默认模板', '非对象 → 回退默认模板');

const t3 = norm({
  groups: {
    weekday: [
      { id: 'b', label: 'B', start: '14:00', end: '15:00', capacity: 1 },
      { id: 'a', label: 'A', start: '09:00', end: '10:00', capacity: 1 },
      { id: 'c', label: 'C', start: '11:00', end: '12:00', capacity: 1 },
    ]
  }
});
eq(t3.groups.weekday.map(s => s.label), ['A', 'C', 'B'],
   '班次按开始时间排序（09:00 → 11:00 → 14:00）');

const t4 = norm({ groups: { weekday: [{ id: 'z', label: '手工', start: '10:00', end: '12:05', capacity: 1, autoConflict: false, conflictPeriods: [3] }] } });
eq(t4.groups.weekday[0].conflictPeriods, [3], '手工指定模式保留用户自定义节次');
eq(t4.groups.weekday[0].autoConflict, false, '手工模式标记保留');

const t5 = norm({ groups: { weekday: [{ id: 'z', label: '去重', start: '10:00', end: '12:05', capacity: 1, autoConflict: false, conflictPeriods: [3, 3, 4, 99, 0, -1] }] } });
eq(t5.groups.weekday[0].conflictPeriods, [3, 4], '手工节次去重 + 过滤越界值');

const t6 = norm({ groups: { weekday: [{ id: 'z', label: '大容量', start: '10:00', end: '11:00', capacity: 9999 }] } });
eq(t6.groups.weekday[0].capacity, 99, '超大容量被钳制到 99');

const t7 = norm({ groups: { weekday: [{ id: 'z', label: '停用', start: '10:00', end: '11:00', capacity: 1, enabled: false }] } });
eq(t7.groups.weekday[0].enabled, false, '停用标记保留');

const t8 = norm({ groups: { weekday: [{ id: 'z', label: '周次', start: '10:00', end: '11:00', capacity: 1, weeks: 'weird' }] } });
eq(t8.groups.weekday[0].weeks, 'all', '非法 weeks 回退为 all');
const t9 = norm({ groups: { weekday: [{ id: 'z', label: '周次', start: '10:00', end: '11:00', capacity: 1, weeks: 'even' }] } });
eq(t9.groups.weekday[0].weeks, 'even', '合法 weeks=even 保留');

const t10 = norm({ name: '   ', groups: {} });
eq(t10.name, '自定义模板', '空白模板名回退为默认名');

section('7. 模板持久化（localStorage）');
localStorage.clear();
g("state.template = normalizeTemplate({ name:'持久化测试', groups:{ weekday:[{id:'p1',label:'P',start:'09:00',end:'10:00',capacity:5}] } })");
g('persistTemplate()');
const raw = localStorage.getItem('shift_duty_template_v1');
ok(!!raw, 'persistTemplate 写入了 localStorage');
g('state.template = makeDefaultTemplate()');  // 打乱内存
g('loadTemplate()');
eq(g('state.template.name'), '持久化测试', 'loadTemplate 恢复模板名');
eq(g('state.template.groups.weekday[0].capacity'), 5, 'loadTemplate 恢复班次容量');
eq(g('state.template.groups.weekday[0].label'), 'P', 'loadTemplate 恢复班次名称');

localStorage.clear();
g('state.template = makeDefaultTemplate()');
g('loadTemplate()');
eq(g('state.template.groups.weekday.length'), 6, '无本地数据时回退默认模板');

localStorage._set('shift_duty_template_v1', '{ 这不是合法 JSON');
g('state.template = makeDefaultTemplate()');
let threw = false;
try { g('loadTemplate()'); } catch (e) { threw = true; }
ok(!threw, '损坏的 localStorage 数据不抛异常');
eq(g('state.template.groups.weekday.length'), 6, '损坏数据 → 回退默认模板');
localStorage.clear();

section('8. 模板描述');
g("state.template = makeDefaultTemplate()");
const desc = g('describeTemplate()');
ok(desc.includes('周一至周五') && desc.includes('周六至周日'), '描述包含两个分组');
ok(desc.includes('6 个班次') && desc.includes('4 个班次'), '描述包含各组班次数');
ok(desc.includes('每日 12 人次'), '描述含工作日每日人次 2+3+2+2+2+1=12');
ok(desc.includes('每日 7 人次'), '描述含周末每日人次 2+2+2+1=7');

summary();
