# AGENT.md

本文件面向在此仓库中工作的 AI 编码代理，记录**运行方式、架构约束、以及容易踩的坑**。
人类贡献者请先读 `README.md`。

---

## 1. 项目概览

重庆邮电大学勤工助学中心学生打印社的**排班工具**：输入学号 → 抓取教务课表 → 自动排值班表，
并支持拖拽微调、导出值班表 / 空课表 Excel。

- **形态**：单机本地工具，无构建步骤、无打包器、无前端框架
- **技术栈**：Python 3 标准库 `http.server` 作后端 + 单个 HTML 文件作前端（原生 JS）
- **代码量**：`app.py` 约 590 行，`templates/index.html` 约 5840 行（含内联 CSS/JS）
  （行数会漂移，别把具体数字当契约；需要准确值时用 `wc -l` 现查）
- **使用语言**：面向用户的文案、代码注释、提交信息**全部用中文**，请保持一致

---

## 2. 常用命令

```bash
# 启动（Windows）
start.bat
# 启动（跨平台）
python3 app.py                 # 监听 http://localhost:8765

# 装依赖
pip install -r requirements.txt

# 跑自测（项数见 run-all.sh 末行输出，无需浏览器，仅需 node）
bash .selftest/run-all.sh

# 后端语法检查
python3 -m py_compile app.py

# 前端语法检查（JS 内联在 HTML 里，需先抽出来）
python3 -c "
import re, pathlib
h = pathlib.Path('templates/index.html').read_text(encoding='utf-8')
b = re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', h, re.DOTALL)
pathlib.Path('/tmp/_chk.js').write_text(max(b, key=len), encoding='utf-8')
" && node --check /tmp/_chk.js
```

**验证前端改动时不要只看代码**——本项目历史上出现过「代码正确但用户看不到」的缓存事故，
详见 §6.1。改动后请实际启动服务并用浏览器（或 headless Firefox 截图）确认。

---

## 3. 架构

```
app.py                     Python 后端：静态文件服务 + 课表 API 代理
templates/index.html       全部前端：HTML + CSS + JS 内联在一个文件
requirements.txt           Python 依赖（全量 pip freeze，见下方说明）
start.bat                  Windows 启动脚本
api.md                     三个课表数据源的接口文档（红岩 / 教务在线 / We重邮）
task.md                    最初的原始需求
README.md                  面向人类用户的功能说明与快速开始
AGENT.md                   本文件
.selftest/                 Node 自测套件（见 §5）
.gitattributes             换行符规范化规则（见 §6.2）
```

> 未纳入版本控制但存在于工作区：`.venv/`、`.venv-linux/`、`skill.md`、`2025.txt`、
> `重庆邮电大学勤工助学中心第二十七届成员信息表.csv`、`__pycache__/`、`文档暂存/`（示例表格）、
> `值班表空课表制作.code-workspace`、`.gitignore` 自身（见 §6.3）。

**关于 `requirements.txt`**：它是一份完整的 `pip freeze`（26 项），但 `app.py`
实际只用到 **`requests`** 和 **`urllib3`** 两个第三方库，其余（Flask、Flask-CORS、
lxml、beautifulsoup4、openpyxl 等）均未被引用，是历史遗留或曾用于打包（PyInstaller 相关项）。
重新部署时只需 `pip install requests urllib3` 即可运行，**不必**照单全装。
改动依赖请勿盲目 `pip freeze` 覆盖，以免继续累积无用项。

### 3.1 后端职责（`app.py`）

| 部分 | 说明 |
| --- | --- |
| `ProxyHandler` | 继承 `SimpleHTTPRequestHandler`，`directory=TEMPLATE_DIR` |
| `fetch_redrock(sid)` | 主数据源：红岩网校 JSON API |
| `fetch_jwzx(sid)` | 备数据源：教务在线 HTML 爬虫 + `parse_jwzx_html` 解析 |
| `get_kebiao()` | 依次尝试上述两个源，都失败返回 502 |
| `end_headers()` | 统一补发禁缓存响应头，见 §6.1 |
| `generate_demo(sid)` | **死代码**：定义了但无任何调用点，改动时可忽略或删除 |

API 端点：

- `GET /api/kebiao?sid=<10位学号>` — 多源自动降级（前端实际使用）
- `GET /api/student_info?sid=` — 与上者同实现
- `GET /api/kebiao_jwzx?sid=` — 仅走教务在线
- 学号必须匹配 `^\d{10}$`，否则 400

### 3.2 前端结构（`templates/index.html`）

单文件，按此顺序：`<style>` → 顶部菜单栏 → 页面骨架 → 各弹窗 → `<script>`。
关键锚点（行号会随改动漂移，用函数名检索更稳）：

| 函数 / 常量 | 作用 |
| --- | --- |
| `CONFIG` | 节次时间表、`maxPeriods=12`、忽略课程关键词 |
| `LAYOUT_MODES` / `weekdayWeekendLayout()` | 两种分组模式的元信息、预设「工作日/周末」的分组定义 |
| `getLayout()` / `getGroupForDay()` / `getGroupKeyByDay()` / `groupMeta()` | **分组访问器（唯一入口）**，见 §4.6 |
| `getShiftsForDay()` / `getShiftById()` / `ungroupedDays()` | 按天取班次 / 按 id 取班次 / 未归组的天 |
| `groupDaysText()` / `groupDaysBadge()` | 分组天数文案（连续天压成「周一至周五」；与分组名重复时徽标留空） |
| `state` | 全局状态（学生、模板、单双周排班、忽略课程……） |
| `deriveConflictPeriods()` | 由班次起止时间推导冲突节次 |
| `makeDefaultTemplate()` | 内置默认模板（与原硬编码配置逐项一致） |
| `normalizeLayout()` / `normalizeTemplate()` | 分组定义规范化 / 模板规范化（补字段、丢非法项、兼容旧格式） |
| `generateShiftKey()` / `parseShiftKey()` / `resolveShift()` | 排班键的生成与解析 |
| `pruneInvalidAssignments()` | 模板变更后清理失效排班、补齐新槽位 |
| `initAssignments()` / `runSchedule()` | 初始化槽位 / 自动排班**唯一入口（无参数）**，三轮：贪心 → 均衡 → 连续偏好；上限只看 `state.maxShiftsEnabled` 开关，见 §4.8 / §4.10 |
| `collectShiftsForWeek()` / `fillWeekGreedy()` | 收集本周班次（难度+同日交错排序）/ 贪心填充 |
| `optimizeBalance()` / `balanceCost()` / `makeLoadTracker()` | 均衡局部搜索 / 代价函数 / 负载缓存，见 §4.8 |
| `getMaxShiftsPerWeek()` / `maxShiftsLimit()` / `loadMaxShifts()` / `setMaxShiftsPerWeek()` / `setMaxShiftsEnabled()` / `syncMaxShiftsInput()` | 每人每周上限的读取、开关与界面同步（**不持久化**，见 §7.3）。**开关 `state.maxShiftsEnabled` 决定上限是否生效**（未勾选 = `Infinity`），数值 `0`/负数/非法回落默认值，见 §4.8 |
| `openSidImport()` / `closeSidImport()` | 学号录入弹窗 `#sidImportModal` 的开关（入口是「文件」菜单 → 导入学号…）；`loadStudents()` 只读弹窗里的 `#sidInput` |
| `renderStudentList()` / `updateStudentListItem()` / `_animatedSids` | 左侧学号列表的整列渲染 / **单条就地更新**，后者供刷新课表的逐条进度使用；`_animatedSids` 记录已播过入场动画的人，配合 `STAGGER_STEP_MS` / `STAGGER_MAX_MS` 逐条写 `--stagger-delay`，见 §4.13 第 4、5 条 |
| `isContinuousScheduling()` / `setContinuousScheduling()` / `loadContinuousScheduling()` | 「连续排班」开关的读写（**不持久化**，见 §7.3），见 §4.10 |
| `makeContinuityContext()` / `continuityScoreOf()` / `continuityGainOf()` / `totalContinuityScore()` | 连续 / 分散判分（同一天连班 + 相邻天），见 §4.10 |
| `optimizeContinuity()` | 保负载的「换人」局部搜索：勾选则尽量连续，不勾选则尽量分散，见 §4.10 |
| `isLocked()` / `lockedSidsOf()` / `toggleLock()` | 排班锁定的判断与切换（锁「该同学+该班次」的位置），见 §4.9 |
| `normalizeLocks()` / `pruneLocks()` / `dropLocksOfStudent()` / `loadLocks()` / `persistLocks()` | 锁定数据的规范化、剪枝与清理（`load/persist` 已退化为默认值 / 空实现，见 §7.3） |
| `remapLockKeys()` | 随 `remapAssignmentIds()` 迁移锁定键（导入被清洗过的 id 时必需） |
| `weeklyLoadOf()` / `totalLoadOf()` / `loadStats()` / `countEmptySlots()` | 负载统计工具 |
| `canTakeShift()` | 课程冲突判断的唯一入口（显式传参，便于干跑推演） |
| `ensureAssignmentSlots()` | 按当前模板补齐空槽位（不覆盖已有排班），见 §4.7 |
| `hasAnyAssignment()` | 是否真的有排班（有键 ≠ 有排班，见 §4.7） |
| `scheduleNoticeText()` / `applyScheduleView()` | 未排班 / 未获取课表时的提示条文案（**已指向顶部「文件」菜单**，改菜单别忘同步）/ 统一切换两个视图的显示 |
| `buildGridSkeleton()` | 值班表与空课表共用的网格骨架 |
| `renderSchedule()` / `renderFreeSchedule()` | 值班表 / 空课表渲染 |
| `renderTemplateEditor()` / `renderShiftCard()` | 模板编辑器 UI |
| `tplSetMode()` / `tplAddGroup()` / `tplToggleDay()` / `tplExplodeToDays()` | 分组模式与结构编辑 |
| `validateDraft()` / `templateWarnings()` / `saveTemplateEditor()` | 保存前校验（阻断）/ 提示（不阻断）/ 应用模板 |
| `exportDutySchedule()` / `exportFreeSchedule()` / `exportData()` | 导出 |
| `buildPersonSheet()` | 「人员表」工作表（按人聚合班次，随值班表导出），见 §4.11 |
| `handleImportFile()` / `handleTemplateFileImport()` | 导入 |
| `MENU_IDS` / `openMenuId` / `setMenuOpen()` / `toggleMenu()` / `menuRun()` | 顶部菜单栏的一级菜单清单、展开状态与开合逻辑，见 §4.12 |
| `refreshThemeMenuUi()` | 把当前主题同步到「个性化」菜单的对勾（**故意不叫 `syncThemeMenu()`**，理由见 §4.12） |
| `openAbout()` / `closeAbout()` / `APP_VERSION` / `APP_BUILD_DATE` | 「关于 → 软件信息」弹窗，见 §4.12 |

页面骨架的三处结构变化（别按旧记忆找按钮）：**左侧面板已无 `.panel-header`**、
**表头已无 `.header-actions`**（原来的「值班模板 / 重置排班」两个按钮随整块删除）、
**菜单栏右侧的主题快捷按钮 `#themeToggle` 与 `.theme-btn` 样式也已删除**。
前两者的功能入口现在都在顶部「文件」菜单，切换主题则只剩「个性化」菜单，见 §4.12。

---

## 4. 核心不变式（改代码前务必理解）

### 4.1 排班键必须绑定稳定班次 ID，绝不能用数组下标

排班数据的键格式为 **`{weekType}_d{dayIdx}_{shiftId}`**，例如 `odd_d0_wd0`。

历史上这里用班次在数组中的**下标**生成键。一旦允许用户增删班次，插入一个班次就会让
后续所有班次的下标位移，导致**已有排班整体错位到错误的班次上，且不报任何错**。
现已改为绑定 `shift.id`。

> 因此：**任何新增的班次操作都必须保留 `id`**（复制班次要生成新 id，
> 清洗外部 id 要走 `sanitizeShiftId()` 因为下划线是键分隔符）。

### 4.2 冲突节次是「自动推导 + 手工覆盖」双模式

`deriveConflictPeriods()` 按「班次时段与上课时间区间重叠」推导，用**半开区间**比较
（首尾相接不算冲突，例如班次 12:00-14:00 与第 5 节 14:00-14:45 不冲突）。

但**不能改成纯自动计算**：自动推导无法表达「某班次特意不看某节课」的业务意图。
每个班次带 `autoConflict` 标记：`true` 时随值班时间自动重算，用户点任意节次即转为
`false` 并保留其手工选择。

### 4.3 `normalizeTemplate()` 是唯一可信的模板入口

任何来自外部的模板（导入的 JSON、模板文件）**都必须经过它**。
（浏览器存储已彻底不用，见 §7.3；`normalizeTemplate()` 仍是唯一入口，因为导入路径仍在。）
它会丢弃非法项并补齐缺省字段。注意它在导入阶段就会丢弃 `start >= end` 的班次，
而编辑器中时间是被直接改到草稿上的，由 `validateDraft()` 负责拦截——两条路径职责不同。

### 4.4 `hasConflict()` 的语义

返回 `true` 表示**有冲突、不能排班**（注意不是「可以排」）。
班次若 `conflictPeriods` 为空数组（如午休班），则永不冲突。
`isFullDay`（连上 ≥8 节）的课程与所有时段冲突。

### 4.5 排班数据的清理时机

模板变更后必须调用 `pruneInvalidAssignments()`：删掉模板中已不存在的键、
补齐新增班次的空槽位，并按其 `weeks`（单/双周）过滤。
在 `saveTemplateEditor()` 和 `handleImportFile()` 中都已接入。

### 4.6 排班日分组是数据（`layout`），不是常量——严禁再写死两组

模板持有 `mode` + `layout`，分组数量随用户配置变化：

```jsonc
"mode": "weekday" | "custom",
"layout": [ { "key": "weekday", "name": "周一至周五", "days": [0,1,2,3,4] }, ... ]
```

- **`mode: 'weekday'`**（预设，也是所有旧模板/旧文件的默认解读）：天数固定为
  `weekday=[0..4]`、`weekend=[5,6]`，保证历史上以 `wd*`/`we*` 为 id 的排班键全部对得上。
- **`mode: 'custom'`**（一周 7 天自由组合）：`layout` 完全来自用户；组健在自定义模式下
  新增分组用 `g1`、`g2` ……（组健会进入班次 id，**不可含下划线**）。

三条不变式，改代码前务必守住：

1. **同一天最多属于一个 `layout` 分组**。`normalizeLayout()` 按「先到先得」丢弃重复的天，
   `tplToggleDay()` / `tplAddGroup()` 在加天前会调用 `detachDay()` 把该天从其它组摘掉。
   未被任何组选中的天**当天不排班**（`getShiftsForDay()` 返回空数组），这是合法状态。
2. **所有「按天找班次」的代码一律走 `getGroupForDay()` / `getShiftsForDay()` / `getShiftById()`**，
   不要再出现 `dayIdx >= 5 ? 'weekend' : 'weekday'` 这类判断（保存/渲染/导出/剪枝/排班共用这套访问器）。
3. **班次 id 只需在所属分组内唯一，跨分组可以重名**——因为排班键是
   `{weekType}_d{dayIdx}_{shiftId}`，天索引已参与区分。`tplExplodeToDays()` 正是依赖
   这一点：把同一批班次定义复制给多天，从而**让已有排班一条都不丢**。切勿「为了唯一」去重编号，
   那会让 `_idRemap` 触发迁移、静默丢排班。

> 校验分两层：`validateDraft()` 只放**阻断性错误**（空模板名、时间倒置/越界、整组停用、
> 组数 >7）；「某天未分组」「某组无班次」「某组只覆盖单周/双周」属于**提示**，由
> `templateWarnings()` 渲染成黄色提示条，不阻止保存——否则用户挪动分组的中间态会被卡死。

#### 4.6.1 分组允许只排单周或只排双周

**一个分组只配单周班次（或只配双周班次）是合法且受支持的配置**，绝不能当错误拦截：

- 历史上 `validateDraft()` 有一条「某一单双周下无任何生效班次」的**阻断性**校验，会把
  「工作日组只排单周」判为错误、卡住保存。用户明确要求放开，该条已删除，改为
  `templateWarnings()` 里的非阻断提示。**不要把它加回 `validateDraft()`。**
- 判断口径统一走 `groupWeekScope(list)`（`'all'` / `'odd'` / `'even'` / `null`）与
  `hasShiftsForWeek(weekType, tpl)`，不要在别处重写一遍覆盖判断。
- 表现层：分组头显示「仅单周 / 仅双周」徽标（值班表 `.grp-week-scope`、编辑器
  `.tpl-week-scope`）；渲染遇到该组在本周无班次时，说明是「该组仅配置了另一周」而非报错。
- 导出仍固定产出单周/双周两个工作表，某周无班次的分组保留分组行并标注「（本周无班次）」，
  结构不丢。

### 4.7 右侧表格「永远渲染」，未排班时只是空槽位

**不点「开始排班」也要能看到当前模板的时段表**（这是用户明确要求的行为，别改回去）：

- `renderSchedule()` / `renderFreeSchedule()` 都**不再提前 return**，一律渲染网格骨架。
  任何「没有排班/没有课表就显示整屏空状态」的写法都会让用户看不到表格，属于回归。
  `DOMContentLoaded`、`loadStudents()`、`clearAll()`、`resetSchedule()`、`saveTemplateEditor()`、
  `handleImportFile()` 都会调用 `refreshView()` 补渲染。
- 提示信息改由 `.schedule-notice`（`#scheduleNotice`）单行提示条承担，文案由
  `scheduleNoticeText()` 统一给出；`#emptyState` 已随之删除。
- **「有键」≠「有排班」**：`renderSchedule()` 开头会调用 `ensureAssignmentSlots()`
  按模板补齐空槽位（拖拽依赖 `state.assignments[week]` 里存在该键，否则会报
  「无效的目标班次」）。因此任何判断「是否已排班」的地方都必须用 `hasAnyAssignment()`
  （真正看数组长度），绝不能用 `Object.keys(...).length > 0`——后者会因为预生成的空槽位
  永远为真，使「导出值班表」按钮在空表时也能点。`updateButtons()`、`tplRemoveShift()`、
  `tplRemoveGroup()` 已按此口径审查过。
- `onDrop()` 对目标槽位改为**按需补齐**而不是直接报错，与上一条配套。

### 4.8 单一排班入口 `runSchedule()` + 「限制每人每周班次」开关

**用户已要求删掉单独的「均衡排班」按钮，现在只有一个「开始排班」。** `runSchedule()` **没有模式参数**，
`'normal'` / `'balanced'` 这类历史调用点**传了也会被忽略**——传与不传行为完全一致，
上限是否生效**只看开关**，别再加回按参数分支的写法。

上限由两个状态共同表达：

| 状态 | 持久化 | 含义 |
| --- | --- | --- |
| `state.maxShiftsEnabled` | **无**（只在内存，见 §7.3） | 左侧「限制每人每周班次」开关；**默认 `false`（不勾选）** |
| `state.maxShiftsPerWeek` | **无**（只在内存，见 §7.3） | 上限数值，默认 `MAX_SHIFTS_DEFAULT = 3` |

- `maxShiftsLimit()` 是**唯一**的上限口径：开关未勾选 → `Infinity`；勾选 → `getMaxShiftsPerWeek()`
  （该值若为 `0` 同样映射成 `Infinity`）。直接比较时不必再判 `null`。
- **开关默认关**是为了兼容旧行为：老用户升级后不会因为凭空多出一个开关而被静默限制班次。
- 数值框 `#maxShiftsInput` 在未勾选时被 `syncMaxShiftsInput()` 置灰（`disabled`），
  且 `setMaxShiftsPerWeek()` 把 `0` / 负数 / 非法值一律**回落为 `MAX_SHIFTS_DEFAULT`**，
  避免用户删空数字框后留下一个 `0` 让上限莫名失效。勾选状态、数值、说明文案三者的同步
  统一由 `syncMaxShiftsInput()` 负责（`setMaxShiftsEnabled()` / `setMaxShiftsPerWeek()` 都调用它）。
- 口径是**每周**：单周、双周各自单独计数，不是合计。
- **不要在别处重新实现上限判断**（例如再写一个 `CONFIG.maxWeeklyShifts`）；
  旧的 `CONFIG.maxWeeklyShifts` 常量已删除，改成这项配置。

**这是用户明确确认的不变式，别弄丢**：**无论开关是否勾选，都必须保证每人班次数相差不大**
（用户原话：「两种模式均需保证每个同学班次相差不大」，去掉按钮后这条仍然成立）——
不勾选只是「不套用上限」，**不是**「放弃均衡」。

算法分三步（`runSchedule` 内）：
1. **贪心填充**（`fillWeekGreedy`）：按难度降序处理班次，每格挑负载最低的空闲同学。
2. **局部搜索均衡**（`optimizeBalance`）：做「一换一」单点替换，反复降低 `balanceCost()`。
   勾选开关时替换额外受每人每周上限约束，未勾选时上限为 `Infinity`（约束自然失效）。
3. **连续 / 分散偏好**（`optimizeContinuity`）：只做「两槽位互换成员」，班次数不变，见 §4.10。

三个必须理解的坑：

1. **代价函数用「偏差平方和」，不能用「极差」。**
   极差有平台期：把 10 班的人换成 9 班、把 8 班的人换成 9 班，极差仍是 2，
   严格下降的搜索迈不出这一步，会卡在极差 2 的局部最优（实测踩过）。
   平方和是全序的，上述替换能让它真正下降。三个维度（单周/双周/合计）必须一起算，
   否则会出现「每周都均匀，但某人单周 0 班、双周 3 班」这种合计不均。

2. **`optimizeBalance` 的增量必须是 O(1) 闭式解。**
   120 人规模下用「推演后重算整个代价函数」要跑 30 秒（实测），改成闭式解后 27ms。
   推导：一次替换不改变该周与合计的总和 ⇒ 平均值不变 ⇒ `ΔΣv² = 2(新−旧)`；
   于是 `delta = 4 − 2·gain`，`gain = (h−l) + (H−L)`（h/l 为该周班次数，H/L 为合计数），
   改进条件是 `delta < 0`。候选按 `该周负载 + 合计负载` 升序，`delta ≥ 0` 即可 `break`。
   **代价函数与增量公式必须同步改**：`.selftest/test-integration.js` §38 用真实
   `balanceCost()` 交叉验证 400 组随机场景，改错会立刻红。

3. **同难度内必须按「组内第几个班次 → 星期几」交错排序，不能先排完周一再排周二。**
   名额紧张时（如 12 人 × 上限 2 = 24 个名额，单周需求 74），顺序填充会把名额被
   周一~周五吃光，**周末一个都排不到**（实测：工作日 24 人、周末 0 人）。
   交错后名额摊到整周（工作日 20 / 周末 4）。见 `collectShiftsForWeek()` 与测试 §40。

`optimizeBalance` 只做一换一，因此天然不会破坏三类硬约束：
班次容量不变、换入前用 `canTakeShift()` 查课程冲突、勾选上限时换入者不得突破上限。
上限相关的测试见 `.selftest/test-integration.js` 里 §32~§40 一组（参数语义、上限生效、
上限为 0 / 未勾选时的不限制、均衡性与规模可用性）；算法改动后必须复核。

### 4.10 连续 / 分散排班偏好（勾选式软偏好，绝不反噬均衡）

左侧「连续排班」开关（`state.continuousShifts`，**只在内存，不持久化**，见 §7.3）：
**勾选 = 尽量让同一人的班次连成片，不勾选（默认）= 尽量分散**。这是用户明确确认的口径。

判分口径（「连续分」，越高越连续），全部落在 `continuityScoreOf(occ, ctx)`：

| 情形 | 计分 |
| --- | --- |
| 同一天内**首尾相接**的两个班次（连班，前一班的 `end` 到后一班的 `start` 空档 ≤ 30 分钟） | +2 / 对 |
| **相邻两天**都值班 | +1 / 天对 |

- 「连续」= 最大化全表连续分（`totalContinuityScore()`），「分散」= 最小化它。
- 空档容差 `CONTINUITY_GAP_TOLERANCE = 30` 分钟：默认模板的班次都是无缝相接（12:05 接 12:05），
  留一点容差是为了「12:05 结束、12:35 开始」这种同一次到岗也能算连班。
- 只有**一周 ≥2 个班**的人才有连续分可谈：一个人一周只排 1 个班时，无论排哪天分数都是 0，
  交换对这类人没有任何收益（这不是 bug，是口径的必然结果）。

**实现分两处，都必须遵守「不改变每个人的班次数」这条底线**：

1. `fillWeekGreedy` 里只在**同一批最低负载候选人内部**按连续分调序（先 `shuffle` 再稳定排序，
   保证同分候选仍然随机）。负载是池子的第一关键字，所以调序不会破坏均衡。
2. `optimizeContinuity` 做的是「**两个槽位互换成员**」（a↔b），不是 `optimizeBalance` 那种单点替换。

> **为什么必须是交换而不是单点替换**：单点替换必然让一个人 +1、另一个人 −1，
> 于是 `balanceCost()` 立刻变差 —— 用户要求「**无论开关如何都要均衡**」（原来的说法是
> 「两种模式都要均衡」，按钮删掉后这条不变），连续只是锦上添花，
> 不能拿均衡去换。互换则让每个人的单双周班次数**一个都不变**，`balanceCost()` 分毫不动
> （测试 §43 用 `balanceCost` 前后相等来锁死这条）。
> 另一条推论：**均衡与连续本质上会冲突**（把两个班并给同一个人，就必然要从别人那里拿走），
> 所以只能「尽量」，绝不能为了连续去改人数。

`optimizeContinuity` 的硬约束（改代码时别漏）：

- 锁定位置（该同学 + 该班次）**进出都拦**：`isLocked(a, A.key) || isLocked(a, B.key)` 才放行；
- 换入的两个人必须都对该班次无课程冲突（预筛成 `eligible` 集合，热循环里 O(1) 查表）；
- 容量天然安全（互换不改变任何槽位的人数）；
- 槽位内不得出现重复的人（`A.slot.includes(b)` 时跳过）。

它按「一次挑全局最优的一对」迭代，每轮严格改进所以必然收敛；`maxRounds` 默认 12，
100 人规模实测 < 50ms（见测试 §39 的耗时断言）。第三轮在 `runSchedule` 里紧跟在
`optimizeBalance` 之后调用，**顺序不能颠倒**（先均衡、后偏好）。

测试见 `.selftest/test-integration.js` §43：判分口径与容差边界、开关读写、
连续/分散两个方向的确定性用例、`balanceCost` 不变、课程冲突与锁定拦截、以及
`runSchedule` 端到端（连续分 0 → 117、极差仍为 0）。
另有 **§43b**：用「朴素参考实现」交叉验证 `continuityScoreOf` 的缓存语义
（600 组随机占用集合 + 无效键），已用注入 bug 的方式确认该断言真的会红。
性能相关的两条约束（打分提到外层、槽位信息缓存进 `ctx._meta`）见 §5.1 —— 改动打分逻辑后
必须同时保证 §43b 全绿、且多场景排班结果**逐位不变**。

### 4.9 排班锁定：锁的是「位置」（该同学 + 该班次），不是「人」

`student-tag` 上的锁按钮给用户一个「这块别动」的表达方式。**粒度是位置**（用户明确确认）：

- 锁定后，**任何一次重新排班**（`runSchedule()`）都**不会**改变这个位置 —— 不换人、也不换班次；
- 但**该同学在其它班次仍可被正常安排**，其它同学也照样能进这个班次。
  因此**所有判断都必须同时看 `sid` 与 `key`**，绝不能简化成「这个人被锁了」。
- 数据存在 `state.locks = { odd: { [shiftKey]: [sid, ...] }, even: {...} }`，
  **只在内存（不持久化，见 §7.3）**，但随 `exportData()` / `handleImportFile()` 往返（version 仍为 3，
  旧文件无 `locks` 字段 → 视为全部未锁定）。

三个必须守住的点（否则锁定会被**静默破坏**，用户不会收到任何报错）：

1. **`fillWeekGreedy` 不能抹掉锁定成员。** 旧写法 `assignments[wt][key] = []` / `= selected`
   会把该槽位整体覆盖，锁定随之丢失。现在改为：先取出 `lockedSidsOf(key, wt)`，
   剩余名额 `capacity - kept.length` 才交给算法，最后 `[...kept, ...selected]` 合并；
   且锁定成员**先计入负载**（否则会被当成没排班、反复加派到别处）。
2. **`optimizeBalance` 不能把锁定成员当 heavy 换出。** 循环里对每个 candidate 先 `isLocked(...)` 跳过。
3. **`initAssignments` 重建槽位时必须回填锁定位置**（它会把 `state.assignments` 整个换掉）。

配套的**手工操作防护**（拖走 / × 移除同样会改变锁定位置，必须拦下并提示，不能静默放行）：
`onDragStart` 对 `data-locked="1"` 的 tag 调 `preventDefault()`；`removeFromShift` 直接 return。

清理时机（**别漏，否则会留下指向不存在槽位/人员的脏锁定**）：
`pruneLocks()` 在 `pruneInvalidAssignments()` 末尾自动调用（班次被删 / 单双周不生效 / 人已不在槽位时丢弃）；
`dropLocksOfStudent()` 在 `removeStudent()` 里调用；`clearAll()` / `resetSchedule()` 整体清空；
`remapLockKeys()` 随 `remapAssignmentIds()` 一起迁移被清洗过的班次 id（**漏了这条，重新导入时锁定会被当失效数据丢弃**）。

> 另注意 `pruneLocks()` 的判人逻辑：**学生列表为空时不做「人是否还在」的判断**，
> 否则刚打开页面（还没导入学号）就会把存档里的锁定全部清掉。

测试见 `.selftest/test-integration.js` §41（含反复重排后锁定位置不变、
均衡搜索跳过锁定、拖拽/移除被拦截、导入导出往返、剪枝与清理）。

### 4.11 导出值班表附带「人员表」工作表（只在值班表里，空课表不加）

用户要求「方便表中值班人员快速查看自己在何时有几班」，所以 `exportDutySchedule()` 在
单周 / 双周两个表之后追加第三个工作表 **`人员表`**（`buildPersonSheet()`）。
`exportFreeSchedule()` **故意不加**——空课表是「谁有空」的清单，没有班次归属。

表内两段（同一工作表）：

| 段 | 表头 | 说明 |
| --- | --- | --- |
| 概览 | 姓名 / 学号 / 单周班次 / 双周班次 / 合计 | 每人一行，**含 0 班的人**；按合计降序、同学号升序 |
| 明细 | 姓名 / 学号 / 周别 / 星期 / 班次名称 / 时间段 / 分组 | 按「所在周（单周→双周）→ 星期 → 班次开始时间」排序 |

口径与实现约束（改代码时守住）：

1. **按人聚合，不按模板**：遍历 `state.assignments[wt]`，用 `parseShiftKey` / `generateShiftKey`
   与 `getShiftsForDay()`（**必须走 §4.6 的访问器**，分组是动态的）把键还原成班次；
   模板里已不存在的**陈旧键直接跳过**，绝不能让 `shift` 为 `undefined` 时读字段报错。
2. **概览的班次数直接数明细行**（`p.detail.filter(e => e.weekType === wt).length`），
   保证两段永远对得上。注意这与侧栏的 `weeklyLoadOf()` **在陈旧键上会有差异**：
   后者数的是 `assignments` 里的键，前者只数模板里真实存在的班次。正常数据（经过
   `pruneInvalidAssignments()`）两者一致，测试 §44 对两种口径都做了断言。
3. **单周与双周各自独立排班，每一个都单独计数**——这是 `assignments` 自身的形状决定的：
   `initAssignments()` / `ensureAssignmentSlots()` 会为 `weeks:'all'` 的班次在**单周、双周各建一个槽位**
   （`odd_d0_wd0` 与 `even_d0_wd0` 并存，实测默认模板单双周各 38 个槽位），
   `fillWeekGreedy` 也分别对两周各排一遍。所以
   「乙只排了每周班」可能只排进了单周 → 单周 1 + 双周 0 = 合计 1。**这是合法结果，不是数据缺失**；
   反过来两周都排上就是合计 2。**不要为了「看起来对称」把某周的人数镜像到另一周**，
   那会和侧栏的负载口径、冲突判断打架。明细行的「周别」列写的是**班次自身**的 `weeks`
   （每周 / 仅单周 / 仅双周），不是它被排进的那一周。
   > ⚠️ 本条曾写错：旧版本称「`weeks:'all'` 的班次只在单周花名册里存人，双周并不复制一份」，
   > 与 `initAssignments()` / `fillWeekGreedy()` 的实际行为**不符**（两者都按周独立建槽与填充）。
   > 测试 §44 的「乙 → 合计 1」只是**手工只往单周槽位放了乙**，推不出「双周不存人」。
   > 判分口径一律以 `weeklyLoadOf()` / `totalLoadOf()` 为准。
4. 未在 `state.students` 名单里、却被排进槽位的人也要出现（`名称` 用 `getStudentName()` 兜底）；
   名单里没有被排班的人保留 0 班行，避免「查不到自己」。
5. 合并单元格（`!merges`）只用在两段的标题行与空表提示行上，**不要**影响 `buildSheetRows()`
   产出的单双周表结构（那两张表的结构是既有约定，见 §4.6.1）。

测试见 `.selftest/test-integration.js` §44：三工作表顺序、概览计数与 `weeklyLoadOf` /
`totalLoadOf` 对照、陈旧键按 0 班计、明细排序与字段完整性、清空排班后名单仍在、
无数据时的提示行、以及空课表不加人员表。

### 4.12 顶部菜单栏：导入 / 导出 / 主题 / 指南的**唯一可见入口**

`<body>` 的第一个子元素是 `.top-menubar`，三个一级菜单 `#menuFile` / `#menuPersonal` / `#menuAbout`，
二级菜单项放在各自的 `.menu-panel` 里。**用户要求把原来散落在左侧面板与表头的按钮全部收进这里**
（原位置按钮已删除，不要「顺手」加回去）：

| 一级菜单 | 二级菜单项（顺序即 DOM 顺序） |
| --- | --- |
| **文件** | 导入学号…（`menuRun(openSidImport)`）、导入数据…、导入模板…、导出值班表、导出空课表、导出数据、导出值班模板、**编辑值班模板…**（`menuRun(openTemplateEditor)`）、**重置排班…**（`menuRun(resetSchedule)`）、清空学号与排班… |
| **个性化** | 深夜模式 / 日间模式 / 跟随系统（当前项打勾） |
| **关于** | 使用指南 / 软件信息 |

**「导入学号…」接的是 `openSidImport`（打开弹窗），不是 `loadStudents`**：学号录入框已从左侧面板
搬进 `#sidImportModal`，`loadStudents()` 只负责读该弹窗里的 `#sidInput` 并抓课表，
真正触发它的是弹窗底部的「导入」按钮。**别再把它接回 `loadStudents`**，那样会读一个已经不在
左侧面板的 textarea。

左侧面板只保留：学号列表、进度条、「限制每人每周班次」开关、连续排班开关、
开始排班 / 刷新课表两个按钮（以及一组 `display:none` 的兼容控件）。
**左侧已无 `.panel-header`**（排班标题由菜单栏的 `.menu-brand` 承担），
**表头 `.header-actions` 整块已删除**（原来在表头右侧的「值班模板 / 重置排班」按钮随之消失）——
表头现在只剩视图切换与单双周切换，右上角和左下角都**没有**「重置排班」。
**导入 / 导出 / 编辑模板 / 重置排班**类入口一律只在「文件」菜单里，原位置按钮均已移除。

五条必须守住的点：

1. **`menuRun(fn)` 必须先收起菜单再执行动作。** 顺序颠倒会让下拉面板浮在即将打开的弹窗之上
   （`.menu-panel` 的 z-index 高于 `.modal-overlay`），表现是「点了菜单项，弹窗被菜单挡住」。
2. **`.top-menubar` 的 `z-index` 必须高于 `.left-panel`(10) 与 `.right-header`(5)。**
   下拉面板向下展开会压在这两块区域上，同层或更低就会被盖住、点不到 —— 与 §6.7 是同一类层叠陷阱，
   而且**同属 node 自测查不出来的问题**（`.selftest/test-integration.js` §45 只能做静态断言，
   真正的可点击性必须用 §6.7 的 `document.elementFromPoint` 手法在浏览器里验证）。
3. **菜单项与面板按钮的启用状态必须同步。** `updateButtons()` 里既设 `btnExportDuty` / `btnExportFree`，
   也设 `menuExportDuty` / `menuExportFree` 的 `disabled`。新增禁用逻辑时两处都要跟，否则会出现
   「菜单项灰着、隐藏兼容按钮却可点」的不一致。
4. **切换主题只有「个性化」菜单一个入口**（深夜模式 / 日间模式 / 跟随系统，三选一、当前项打勾）。
   历史上菜单栏右侧曾有一个循环切换的 `#themeToggle` 快捷按钮，**已按用户要求删除**，
   连带 `.theme-btn` 样式与 `toggleTheme()` / `updateThemeIcon()` 一起删掉了 ——
   不要再把它们加回来。菜单对勾由 `refreshThemeMenuUi()` 统一维护，**由 `applyTheme()` 直接调用**；
   因此改了主题就一定要走 `applyTheme()`，否则对勾不会更新（跟随系统时系统深浅色变化也走它）。
5. **值班模板弹窗 `#templateModal` 故意不监听「点击外部关闭」**（用户要求防误触，见 §6.7）。
   模板里的每次改动都只写在草稿 `state.tplDraft` 上（深拷贝自 `state.template`），
   `closeTemplateEditor()` 会把草稿丢掉；
   如果点一下遮罩就关窗，用户刚改的整套模板会**无声作废**。
   关闭入口**只有三个**：右上角 ×、底部「取消」、Esc。
   `index.html` 文件末尾因此**刻意没有** `document.getElementById('templateModal').addEventListener('click', ...)`
   这类代码（其它弹窗如 `#sidImportModal`、`#courseModal`、`#guideModal`、`#confirmModal`、`#aboutModal`、`#exportModal` 都有）。
   **不要为了「统一」把 click-outside 加回来**，也不要再在注释里写「关闭弹窗点击外部」把它带出来。

> **隐藏兼容控件**：`#btnExportDuty`、`#btnExportFree`、`#btnMenuImportStudents`、
> `#btnMenuExportData`、`#btnMenuImportData`、`#btnMenuExportTemplate` 是 `display:none` 的按钮，
> 只为保留既有 id、让老脚本与测试（如 `.selftest/test-layout.js` §L23 读 `btnExportDuty.disabled`）
> 仍能触发同一动作。**别删**，也别把它们显示出来。
> 另外 `#importFileInput` / `#tplFileInput` 这两个隐藏 `<input type=file>` 仍然必须留在 DOM 里，
> 菜单项正是通过 `.click()` 触发它们的。

> **别再把它改名成 `syncThemeMenu()`**：这个仓库已有的「连续排班」同步函数叫
> `syncContinuousInput()`，两个名字只差一个词，极易在批量替换或阅读时混淆，
> 因此菜单版本刻意叫 `refreshThemeMenuUi()`。

「关于 → 软件信息」(`#aboutModal`) 的内容全部在 HTML 里写死，只有版本号 / 构建时间 / 本地地址
三个字段由 `openAbout()` 动态填充（`APP_VERSION`、`APP_BUILD_DATE`、`window.location.origin`）。
**发版时记得同时改 `APP_VERSION` 与 `APP_BUILD_DATE`。**

测试见 `.selftest/test-integration.js` §45：三个一级菜单与各项接线、导出项的禁用同步、
主题三态与对勾位置、`menuRun` 先收菜单再执行、`←`/`→`/`Esc` 键盘导航、菜单栏与左侧面板的
z-index 大小关系、`#aboutModal` 不破坏 §6.7 的 DOM 顺序前提、以及提示条指向「文件」菜单。

### 4.13 界面动效是「纯 CSS 装饰层」，不得承载任何逻辑

`#guideContent` 之外的界面观感（动效、渐变、阴影）集中在 `<style>` 顶部的设计变量与
一组 `@keyframes` 里，**改文案 / 改逻辑时不要顺手动它们**，反之改动效时也别碰 JS：

- **设计变量**（`:root`）：`--transition-smooth` / `--transition-fast` / `--transition-bounce`
  与缓动曲线 `--ease-out-expo` / `--ease-out-back`。新写过渡请复用这些变量，别再散落魔法值。
- **动效清单**：`pageIn`（页面淡入）、`slideInFromLeft`（学号列表项入场，**逐条错峰**，见下）、
  `progressShimmer`（进度条流光）、`cellPulse`（拖拽经过的脉冲）、`dropAvailable`（可放置呼吸）、
  `shake`（冲突抖动）、`dragPulse`（拖拽中的标签）、`toastBounce`、`overlayIn`（遮罩模糊）、
  `modalIn`（弹窗回弹）。

> **唯一的例外：`slideInFromLeft` 需要 JS 配合**（见下面第 4、5 条）。它挂在
> `.student-item.is-new` 而非 `.student-item` 上，`is-new` 由 `renderStudentList()`
> 通过 `_animatedSids` 记账后标出，逐条错峰量也由它写进 `--stagger-delay`。
> 这是「列表每次都整段重写 innerHTML」逼出来的：
> 纯 CSS 无法区分「这一条是刚冒出来的」还是「这一条一直都在、只是被重画了」。
> 其余动效仍应保持纯 CSS，别拿这个例外当先例去给别的动画加 JS 开关。

五条已踩过的坑（前三条详见 commit `30ab539` 的提交信息）：

1. **`.student-tag` 的高亮规则不能写死 `border-radius`。** 它和 `.student-item` 共用
   `.highlight-linked`，其中原有一句 `border-radius: 4px`，会把胶囊（`999px`）在 hover 时
   压成方角。现已从共享规则移除，只给本身无圆角的 `.student-item` 单独保留。
2. **`.schedule-grid .shift-cell:hover` 不能加 `transform: scale()`。** 格子属于网格，
   放大后与相邻格子/边框互相压叠，观感上是「浮起来」的抖动；hover 只保留描边与底色。
   （`.drag-over` / `.drop-available` / `.drop-conflict` 的动画**属于拖拽落点反馈，要保留**。）
3. **占位格 `.shift-cell.void:hover` 必须精确抵消。** `.void` 是「该天未归入本分组」的
   不可放置占位格，跟着 `:hover` 一起亮起会被误认为「这一格能排班」。现单独写一条优先级更高的
   规则把它压掉。**刻意不用 `:hover:not(.void)`**：那会把权重从 `[0,3,0]` 抬到 `[0,4,0]`，
   超过下方的 `.grp-N` 底色规则，顺带改变正常格子的观感。
4. **入场动画不能挂在 `.student-item` 基类上，否则「刷新课表」会让整列抽搐。**
   基线是 `opacity: 0; animation: slideInFromLeft ... forwards;` 直接写在 `.student-item` 上，
   而 `renderStudentList()` 每次都整段重写 `container.innerHTML`（节点全是新建的）——
   于是**每次调用都让整列重放一遍滑入动画**。`fetchAllSchedules()` 又恰恰是
   「每收到一个课表就重渲染一次」（其 `.finally()`），实测导入 `2025.txt` 的 25 个学号后
   点「刷新课表」＝整列重写 **27 次**、25 个条目反复回到 `opacity: 0` 再滑回来，
   观感就是用户报的「左边学号列表抽搐多次」。
   现在动画只在 `.student-item.is-new` 上，`renderStudentList()` 用模块级
   `_animatedSids` 记住「谁播过了」，只有**首次出现的人**播一次（清空 / 移除后重新导入会重新播）。
   `fetchAllSchedules()` 的逐条进度改走 `updateStudentListItem(sid)` **就地更新**
   该条的姓名与状态，不再整列重写 —— 这同时保住了列表滚动位置与 hover 状态
   （整列重写会把 `scrollTop` 顶回顶部）。实测：刷新期间动画重放 0 次、整列重写 2 次
   （仅「标记 loading」与「结束时最终刷新」，都是必要的），且 25 条全部 `opacity: 1`。
   另外补了 `@media (prefers-reduced-motion: reduce)`：勾了系统「减少动态效果」就完全不播
   （已在真实浏览器里用 `ui.prefersReducedMotion=1` 验证：`animationName` 全为 `none`、`opacity` 全为 1）。

5. **错峰量必须逐条写，写死成 `:nth-child(1)~(5)` 只有前 5 条有缓入动画。**
   第 4 条的修复落地后，用户立刻发现新症状：**批量导入时「只有前五个有缓入动画」**。
   根因不是动画丢了（实测 25 条**全部**带 `is-new`、`animationName` 全是 `slideInFromLeft`），
   而是错峰只覆盖 `nth-child(1)~(5)`：第 6 条起 `animation-delay` 一律 `0s`，
   20 条同时起跑；`--ease-out-expo` 前段极陡（300ms 的动画约 60ms 就走完大半），
   于是它们几乎「啪」地一起出现，只剩前 5 条还把延迟拖到 ~430ms —— 肉眼即「只有前五条在缓入」。
   实测时间线（毫秒:仍透明条数）修复前是 `…155:25 179:5 204:5…`（25 直坠 5 的跳变），
   修复后是 `…168:25 189:24 209:23 229:22 249:20…571:1 592:0`（逐条平滑递减）。
   现在延迟由 `renderStudentList()` 逐条写进 CSS 变量 `--stagger-delay`
   （CSS 只保留 `animation-delay: var(--stagger-delay, 0s)`）：
   `STAGGER_STEP_MS = 30` 为相邻间隔，`STAGGER_MAX_MS = 400` 给最后一条封顶，
   人多时用 `Math.min(30, 400/(n-1))` 自动压缩间隔（实测 25 条 → 25 个互不相同的延迟，
   最后一条正好 400ms；200 条仍全员错峰且封顶 400ms）。只有 1 个新条目时不写延迟。
   > 注意 CSS 里 `animation` 简写会重置 `animation-delay`，**长写必须排在简写之后**，
   > 否则延迟被悄悄清成 0 —— 改这两条规则时留意顺序。

> 前三条**都是 node 自测查不出来的**（harness 没有 CSS 引擎），与 §6.7 同属
> 「必须在真实浏览器里用 `getComputedStyle` / CSSOM 验证」的一类。改 hover 或层叠相关样式后，
> 请照 §6.7 的手法实测，别只看代码。
> 第 4、5 条则是**一半可测**：`.selftest/test-layout.js` §L25b 用静态断言锁住
> 「`.student-item` 基类里不许再出现 `animation` / `opacity`」「错峰不许再写死成 `:nth-child`」
> 「延迟必须走 `var(--stagger-delay)`」，并用行为断言锁住
> 「首次渲染 N 条都带 `is-new`、重渲染 0 条带、新增 1 人只 1 条带」
> 与「25 / 200 条批量导入时逐条延迟递增且封顶 400ms」。
> 但「动画到底有没有真的在播、错峰肉眼看得出吗」仍只能在浏览器里用
> `getComputedStyle(el).animationName` / `animationDelay` 并按时间采样确认 ——
> 第 5 条那个 bug 正是**只数了 `is-new` 类而没量 `animationDelay`** 才漏掉的。

### 4.14 使用指南弹窗是「面向用户的文档」，改功能时要同步

`#guideModal` 的正文（`#guideContent`，在 `templates/index.html` 里）是给最终用户看的图文说明，
**与根目录 `README.md` 内容重叠、需要一起维护**。历史上它曾漏掉「人员表」「空课表视图」，
也说过「不会破坏上面两种模式的均衡性」——而「均衡排班」按钮早已删除、**没有两种模式**了。

因此：**任何面向用户的改动（新增功能、改菜单、改开关语义、改导出结构）落地时，
都要顺手检查这三处的说法是否还成立**：

1. `#guideContent`（程序内「关于 → 使用指南」）
2. `README.md`
3. 左侧面板两个开关下的 `#maxShiftsHint` / `#continuousHint` 文案（由
   `refreshMaxShiftsHint()` / `syncContinuousInput()` 动态写入）

> 提醒用户「**数据不会自动保留、排完班要自己导出 JSON**」的那段提示必须留在使用指南里
> （§7.3 说明了为什么彻底不用浏览器存储）——这是最容易让用户白干一下午的坑。
> 同理，抓课表需校园网/VPN、必须经 `app.py` 打开、离线时导出 Excel 失效，这三条也在指南里。
>
> **但只写在「数据保存」那一段就够了，别到处复述。** 用户明确要求过
> 「不需要文档的每个地方都强调不会保存」：使用指南与 README 里各**只保留一处**完整说明
> （指南的「数据保存」段、README 的「注意事项」第 1 条），其它地方（模板小节、两个开关的说明、
> 「关于」弹窗的数据存储行）只用一句「不自动保留（见注意事项/见上文）」带过即可。
> 反复用「⚠ 重要」「一切归零」这类重语气会让人以为程序有缺陷，反而稀释了真正该注意的那条。

---

## 5. 测试

`.selftest/` 是一个**不依赖浏览器**的 Node 自测套件（各文件项数以 `bash .selftest/run-all.sh` 末行输出为准，这里不写死具体数字）：

```
harness.js              最小 DOM / localStorage 桩（localStorage 仍保留以断言「页面不用它」）/ XLSX 桩
test-model.js           模板模型、键解析、冲突推导、不持久化（§7.3）
test-integration.js     排班、剪枝、渲染、导出、导入往返、每人每周上限与均衡性、
                                排班锁定（§41，锁「位置」而非「人」）、弹窗层叠断言（§42，见 §6.7）、
                                连续 / 分散排班偏好（§43，见 §4.10）、
                                连续分缓存与朴素实现等价（§43b，见 §4.10 / §5.1）、
                                人员表（§44，见 §4.11）、顶部菜单栏（§45，见 §4.12）
test-layout.js          排班日分组（预设/自定义、模式往返、动态渲染与导出、未排班时的表格、
                                分组只排单周/双周）、学号列表入场动画（只播一次 + 逐条错峰 + 就地更新，
                                §L25b，见 §4.13）
run-all.sh              入口
```

原理：`harness.js` 用正则从 `templates/index.html` 中**抽取最长的内联 `<script>`**，
在 `vm` 沙箱里直接运行页面真实代码。所以**测试对象永远是最新代码，不需要构建或导出**。

**`harness.js` 的 DOM 桩带一个极简 HTML 解析器**（`parseFragment` / `nodeMatches` /
`mkNodeStub`）：元素 `innerHTML` 是普通字符串，但 `querySelector` / `querySelectorAll` /
`textContent` / `className` / `getAttribute` / `setAttribute` 都能真正工作 ——
页面里「重写 innerHTML 再 querySelector 就地改其中某个元素」的写法（如
`renderStudentList()` + `updateStudentListItem()`）因此可测。此前桩一律返回 `null`，
这类「不整列重渲染」的代码路径完全测不到。支持的选择器只有 `.class`、`tag`、
`[attr="v"]` 及其组合（**不支持**后代 / 子代组合器、`>`、`:nth-child` 等），
够页面用即可。解析结果按 innerHTML 字符串缓存（`fragmentCache`）：**不缓存时
解析要吃掉整套自测约 45% 的 CPU，会把 §5.1 守着的「约 1 秒跑完」拖慢到 2.3 秒**，
改动这里请照 §5.1 复测耗时。

用法：

```js
const { g, ok, eq, section, summary, el } = require('./harness.js');
g("state.template = makeDefaultTemplate()");   // 在页面作用域内求值
eq(g("deriveConflictPeriods('10:00','12:05')"), [3, 4], '早班冲突节次');
```

改前端逻辑后**请先跑 `bash .selftest/run-all.sh`**，它能挡住绝大多数回归。
若新增功能，请同步补测试——尤其涉及 §4 的不变式时。

### 5.1 跑得快是有原因的：两个「白白等 / 白算」的坑

整套自测现在约 **1 秒**跑完（此前约 8.3 秒）。这两处都不是靠调小工作量换来的，
**删掉任何一处都会立刻变慢**，改动测试基础设施时请留意：

1. **定时器桩必须 `unref()`**（`harness.js`）。
   页面里唯一的 `setTimeout` 是 `showToast()` 用来 3 秒后隐藏提示条的。
   若直接把真实 `setTimeout` 注进沙箱，Node 会为了等这个定时器而**拖着进程不退出**：
   `test-layout` 曾实测「墙钟 3.08s、CPU 只 0.083s」——那 3 秒纯属干等。
   现在 `stubSetTimeout` / `stubSetInterval` 一律 `unref()`，`summary()` 里再清一次残留。
   没有任何断言依赖该回调真的触发，所以不影响正确性。

2. **`optimizeContinuity` 的打分必须提到双层循环之外**（见 §4.10）。
   `scoreA` 只取决于 `a` 与「A.cell → B.cell」，与 `b` 是谁无关；`scoreB` 同理。
   原实现把两次打分写在 `(a,b)` 配对内部，等于对每个 `b` 都把同一个 `a` 重算一遍。
   另外 `continuityScoreOf` 把「槽位属于哪天 / 下一个班次是否首尾相接」按槽位缓存进
   `ctx._meta`（同一个 ctx 会被调用上万次）。
   CPU profile 显示这两处曾占**全部 CPU 的 78%**（`continuityScoreOf` 57% + `optimizeContinuity` 21%）。

> **改这两处性能代码时的规矩**：结果必须**逐位一致**，不能只满足「测试还是绿的」——
> 连续分是软偏好，打分的细微偏移不会让任何断言变红，却会让排班结果悄悄变化。
> 验证手法：固定 `Math.random` 种子，对多种人数 / 开关组合跑排班，
> 把 `state.assignments` + `totalContinuityScore()` + `loadStats()` 序列化后逐字节对比。
> 优化时已用 14 个场景（8~90 人 × 连续/分散 × 上限 1~5）确认完全一致。
> `.selftest/test-integration.js` §43b 用一份「朴素参考实现」做交叉验证（600 组随机占用集合 +
> 无效键），专门锁住 `continuityScoreOf` 的缓存语义；§39 则把 100 人排班的耗时上限从 5000ms
> 收紧到 1500ms（实测约 90~160ms），用来挡住复杂度被改回去。

---

## 6. 已知陷阱

### 6.1 浏览器缓存（曾导致真实事故）

`SimpleHTTPRequestHandler` 默认只发 `Last-Modified`。浏览器此时按 RFC 7234
**启发式规则**（文件年龄的 10%）自行决定免验证缓存时长。本仓库的
`index.html` 曾数月未改，缓存窗口因此长达约 10 天——这期间浏览器**连条件请求都不发**，
表现为「代码已更新但页面依旧、新加的按钮看不到」。

已通过覆写 `end_headers()` 补发 `Cache-Control: no-cache, must-revalidate` 修复。
**改动 `app.py` 的响应头逻辑时不要回退这一点。**

> 与之无关但同样易混：排查「页面没更新」时，先确认服务端实际返回的内容
> （`curl -s localhost:8765/ | grep 关键字`）以及浏览器是否回源，
> 不要直接假设是前端代码问题。

### 6.2 换行符与 BOM

`.gitattributes` 是 `* text=auto`，**索引里所有文本文件都是 LF**，所以「哪种文件该是什么风格」
只看工作区实际字节即可，别按记忆写死。截至最近一次核对，工作区实况是：

| 文件 | 工作区 | BOM |
| --- | --- | --- |
| `templates/index.html` | LF | **有 BOM** |
| `README.md`、`AGENT.md`、`app.py`、`requirements.txt`、`.selftest/*` | LF | 无 |
| `api.md`、`task.md` | **CRLF** | 无 |

> 历史上 `app.py` / `requirements.txt` 曾是 CRLF，现已是 LF（`start.bat` 甚至只有一个
> 无换行的单行命令）。**改文档前请现跑一次下面的探针**，不要照抄旧结论。

仓库根有 `.gitattributes`（`* text=auto`）做规范化，因此**改动时保持各文件原有风格即可，
不要整文件转换**，否则会产生数千行的「伪 diff」，把真实改动淹没。

用 `write` / `edit` 工具整文件重写时要注意：它们可能顺带丢掉 UTF-8 BOM、或统一换行符。
`templates/index.html` **原本带 BOM**（应输出 `BOM=True`），`README.md` / `AGENT.md` **本来就没有 BOM**
（应输出 `BOM=False`、`CRLF=0`），改动后请确认：
```bash
python3 -c "
import pathlib
for f in ['templates/index.html','README.md','AGENT.md','app.py','requirements.txt','api.md','task.md']:
    d = pathlib.Path(f).read_bytes()
    crlf = d.count(b'\r\n'); lf = d.count(b'\n') - crlf
    print(f'{f:24s} CRLF={crlf:5d} LF={lf:5d} BOM={d[:3] == b\"\xef\xbb\xbf\"}')
"
```

> **实测经验**：本仓库的 `edit` 工具**每次改完都会把 BOM 吃掉**（不是「可能」）。
> 因此**只要动过 `templates/index.html`，收尾前必须重新补 BOM**，否则会产生一个
> 「删除又加回 BOM」的伪 diff。补回方式：
>
> ```bash
> python3 -c "
> import pathlib
> p = pathlib.Path('templates/index.html'); d = p.read_bytes()
> if not d.startswith(b'\xef\xbb\xbf'): p.write_bytes(b'\xef\xbb\xbf' + d)
> "
> ```
>
> 注意补 BOM 后要**再跑一次前端语法检查**：抽取脚本读文件时应用 `encoding='utf-8-sig'`，
> 否则 BOM 会被当成脚本第一个字符，`node --check` 可能报奇怪的语法错误。

### 6.3 `.gitignore` 忽略了自己

`.gitignore` 第 2 行是 `.gitignore`（即它忽略自身），所以**它本身未被 git 跟踪，
对它的修改不会出现在 `git status` 里**（实测 `git ls-files .gitignore` 为空，`git status --ignored`
才把它列出来），容易被忽略掉。

**曾经**第 8 行是 `.selftest`，与「`.selftest/` 下文件已被跟踪」的事实矛盾（已被跟踪的文件
不受 `.gitignore` 影响，所以那行当时并不起作用）。**该行现已删除**，当前第 8 行是 `文档暂存`，
`.gitignore` 里**已无任何 `.selftest` 规则**，`git check-ignore .selftest/xxx` 不再命中：

```bash
git check-ignore -v .selftest/test-new.js   # 无输出 = 不会被忽略
```

> 新增测试文件时仍建议顺手 `git ls-files .selftest/` 复核一下确实进了版本库
> （.gitignore 本身不进版本库，改错了不会体现在 diff 里，容易反复踩）。

### 6.4 前端依赖一个 CDN

`index.html` 第 7 行从 cdnjs 加载 `xlsx.full.min.js`（用于导出 Excel）。
**离线环境下导出功能会失效**，且这是本项目唯一的外部依赖。若需完全离线，
把该文件下载到 `templates/` 下改为本地引用。

### 6.5 课表数据源依赖校园网

红岩网校 API 走公网，教务在线需要校内网络或 VPN。两者都失败时后端返回 502，
前端把该学生标记为 `error` 状态。**不要在无网络环境调试抓取逻辑**，
用 §5 的测试套件验证解析与排班逻辑。

### 6.6 节次时间是硬编码的

`CONFIG.courseTimes` 写死了第 1–12 节的起止时间（来自 `api.md`）。
第 11、12 节曾缺失，导致课表弹窗那两行时间显示为空，现已补齐。
若学校作息调整，改这里即可——`deriveConflictPeriods()` 会自动跟随。

### 6.7 弹窗层叠：确认框必须被单独抬高（曾导致班次删不掉）

`index.html` 里 **7 个** `.modal-overlay`
（DOM 顺序：`exportModal` → `courseModal` → `confirmModal` → **`sidImportModal`** → `guideModal`
→ `aboutModal` → `templateModal`）
**都是 `<body>` 的直接子元素**，其中除 `#confirmModal` 外的 6 个共用同一条规则 `z-index: 9998`
（`#confirmModal` 被单独抬到 9999，见下）。
此时层叠顺序**由 DOM 顺序决定**：后出现的元素盖住先出现的。

> 新增的 `#sidImportModal`（「文件」菜单 → 导入学号…，见 §4.12）排在 `#confirmModal` 之后、
> `#guideModal` 之前；它不弹确认框，因此放在哪一段都不会踩下面那条前提，
> 但**保持它在 `#confirmModal` 之后、`#templateModal` 之前**即可（现状如此，别随意搬动）。
> 新增的 `#aboutModal`（「关于 → 软件信息」，见 §4.12）同样**必须排在 `#confirmModal` 之后**，
> 这样它既不会插进确认框与模板窗之间，也不影响下面这条「确认框 DOM 在前」的前提。
> §45 有一条静态断言锁住 `#aboutModal` 的相对顺序。

**前提仍然成立（已核对当前 DOM 顺序：`confirmModal` 排在 `templateModal` 之前）**：于是
「在值班模板里点删除班次」弹出的确认框会被模板窗口整个盖住 —— 表现是**用户点了删除没反应、
班次删不掉**，且因为遮罩之下看不见，很容易被误判成「前端逻辑没跑」。
同理受影响的还有 **删除分组**（`tplRemoveGroup`）与 **恢复默认模板**（`resetTemplateToDefault`），
它们同样在模板窗内弹确认框。**改动弹窗顺序时务必保持这一点**，否则 §42 的静态断言会红。

修复：给确认框单独抬高一层（**唯一的不同层级**，其余弹窗保持 9998）：

```css
#confirmModal { z-index: 9999; }
```

> **不要删掉这条规则。** 它看起来「多余」（都 9998 也差不多），但删掉就会立刻复发。
> `.selftest/test-integration.js` §42 会对这条 CSS 做静态断言，删了会红。

配套还有一处**键盘顺序**问题：Escape 处理原先先判断 `templateModal`、后判断 `confirmModal`，
于是在确认框打开时按 Esc 会**先关掉底下的模板窗口**（用户会以为「删了班次还整窗消失」）。
现已把 `confirmModal` 提到最前，保证 **Esc 永远先关最上层的确认框**。

> **排查提示**：这类「代码正确但按钮点不到」的层叠问题，`node` 自测套件**查不出来**
> （harness 没有 CSS 引擎，只能做 §42 那种静态字符串断言）。必须用真实浏览器验证，
> 可靠手法是在控制台对目标按钮做命中测试：
>
> ```js
> const b = document.getElementById('confirmOkBtn');
> const r = b.getBoundingClientRect();
> document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
> // 返回的必须是该按钮（或确认框内元素）；返回 null 或模板窗口里的元素 = 被盖住了
> ```

---

## 7. 数据格式

### 7.1 排班数据 JSON（`exportData()` 导出，version 3）

```jsonc
{
  "version": 3,
  "date": "2026-09-30T...",
  "template": { /* state.template 完整结构，见下 */ },
  "students": [
    { "sid": "2025210001", "name": "张三",
      "rawCourses": [ /* 原始课表，用于离线重算 */ ],
      "ignoredCourses": ["课程ID", ...] }
  ],
  "assignments": {
    "odd":  { "odd_d0_wd0": ["2025210001", ...] },
    "even": { "even_d0_wd0": [...] }
  },
  "locks": {                      // 已锁定的排班位置（version 3 起；旧文件无此字段=全部未锁定）
    "odd":  { "odd_d0_wd0": ["2025210001"] },
    "even": {}
  }
}
```

**兼容性**：`version: 2` 的旧文件（无 `template` 字段）仍可导入，沿用当前模板；
无 `locks` 字段的旧文件按「全部未锁定」处理（`normalizeLocks(undefined)`）。
`handleImportFile()` 会用 `remapAssignmentIds(_idRemap)` 迁移被清洗过的班次 id，
避免排班被误判失效而清除；**`remapLockKeys()` 会同步迁移锁定键**，否则锁定会被当失效数据丢弃。

### 7.2 值班模板结构

```jsonc
{
  "version": 2,
  "name": "默认模板",
  "mode": "weekday",        // weekday=预设工作日/周末 | custom=一周7天自由组合
  "layout": [               // 分组定义（有序）；决定「哪天用哪套班次」
    { "key": "weekday", "name": "周一至周五", "days": [0, 1, 2, 3, 4] },
    { "key": "weekend", "name": "周六至周日", "days": [5, 6] }
  ],
  "groups": {               // 键必须与 layout 的 key 一一对应
    "weekday": [ /* 班次数组 */ ],
    "weekend": [ /* 班次数组 */ ]
  }
}
```

> **兼容性**：`version: 1`（无 `mode`/`layout`）的旧模板与旧导出文件仍可导入——
> `normalizeTemplate()` 一律按预设「工作日/周末」解读，班次 id 原样保留，排班不错位。
> `layout` 的天索引为 `0=周一 … 6=周日`；自定义模式的分组键可自定义（不含下划线）。

单个班次：

```jsonc
{
  "id": "wd0",              // 稳定 ID，排班键依赖它；不含下划线
  "label": "早班",
  "start": "10:00",         // HH:MM
  "end": "12:05",
  "capacity": 2,            // 值班人数上限（1~99）
  "weeks": "all",           // all=每周 | odd=仅单周 | even=仅双周
  "conflictPeriods": [3, 4],// 冲突的课程节次
  "autoConflict": true,     // true=随值班时间自动重算
  "enabled": true           // false=临时停用
}
```

### 7.3 浏览器存储：**一个都不用**（用户要求）

**本页面不向 `localStorage` / `sessionStorage` / `cookie` / `IndexedDB` 写入任何数据，
启动时也不从它们读取任何数据。** 刷新或重开页面即回到内置默认状态。

历史上有过 7 个 localStorage 键（模板、忽略课程、上限数值 / 开关、连续排班、锁定、主题），
现已全部移除；下表保留仅作对照，**不要在实现里重新引入**：

| 曾经的键 | 现在 |
| --- | --- |
| `shift_duty_template_v1` | `persistTemplate()` 空实现；`loadTemplate()` 一律 `makeDefaultTemplate()` |
| `shift_ignored_courses` | `saveIgnoredCourses()` 空实现；`loadIgnoredCourses()` 置空表 |
| `shift_max_per_week` / `shift_max_enabled` | `persistMaxShifts()` 空实现；`loadMaxShifts()` 回落 `3` / `false` |
| `shift_continuous` | `persistContinuousScheduling()` 空实现；`loadContinuousScheduling()` 回落 `false` |
| `shift_locks` | `persistLocks()` 空实现；`loadLocks()` 置空锁定 |
| `theme` | `applyTheme()` 只改内存变量 `currentTheme`；`getTheme()` 读该变量 |

四条约束（改代码前务必理解）：

1. **`load*/persist*` 这些函数名刻意保留**，只是退化成「读默认值」/「空实现」。
   策略集中在这几处，调用点不必散落改动，将来若要恢复持久化也只改这几处。
   但**绝不能在它们内部重新加 `setItem` / `getItem`**。
2. **「不持久化」≠「不记忆」。** 主题必须记在内存变量 `currentTheme` 里，
   不能让 `getTheme()` 直接 `return 'auto'`：`refreshThemeMenuUi()` 靠它决定「个性化」菜单
   哪个项打勾，恒返回 `'auto'` 会让用户刚点「深夜模式」对勾就跳回「跟随系统」。
   同理两个排班开关在本次会话内照常生效，只是刷新后回默认。
3. **局部缓存的 `persist*` 调用点不必删除**（它们现在是空操作）。排班数据本来就不进浏览器存储。
4. **HTTP 缓存头是另一回事**，见 §6.1：`app.py` 的 `end_headers()` 仍发
   `Cache-Control: no-cache, must-revalidate`。**不要以为「浏览器不保存任何信息」就等于
   可以把那些响应头删掉** —— 那是防「代码更新了但页面没变」的，与 localStorage 无关。

> 留存的唯一途径是**显式导出文件**：「文件」菜单 →「导出数据」（JSON，含模板 / 排班 / 锁定）、
> 「导出值班模板…」（模板 JSON）、「导出值班表 / 空课表」（Excel）。
> 因此 `state.template` 每次打开都是默认模板，`state.locks` 每次都是空 —— 与导入导出往返逻辑无关
> （`handleImportFile()` 仍会正常读入文件里的 template / locks）。

> 测试守卫：`.selftest/test-integration.js` §46 会**扫描整份源码**，出现
> `localStorage.setItem` / `getItem`、`document.cookie =`、`indexedDB.open` 等即判失败
> （先剥掉注释再扫，所以注释里提到这些词是允许的），并逐项调用所有 `persist*/load*`
> 断言 localStorage 始终为空、状态一律回默认。**已用注入 bug 的方式确认该断言真的会红。**

---

## 8. 默认值班时段

改模板默认值或写测试期望值时请以此为准（`makeDefaultTemplate()`）：

| 分组 | 班次 |
| --- | --- |
| 周一至周五 | 早班 10:00-12:05 (2人)、午班① 12:05-13:45 (3人)、午班② 13:45-15:50 (2人)、下午班 15:50-18:00 (2人)、晚班① 18:00-19:45 (2人)、晚班② 19:45-21:35 (1人) |
| 周六至周日 | 早班 10:00-12:00 (2人)、午班① 12:00-14:00 (2人)、午班② 14:00-16:00 (2人)、下午班 16:00-18:00 (1人) |

> 注：默认模板的「晚班②」冲突节次为 `[10, 11]`。早期的硬编码版本只写了 `[10]`，
> 漏掉了第 11 节（20:50-21:35 与 19:45-21:35 确实重叠），属原配置疏漏，已纠正。
> 若测试用例断言旧值 `[10]`，那是测试过期而非代码错误。

---

## 9. 提交约定

- 提交信息用**中文**，首行 `type: 简述`，type 取 `feat` / `fix` / `chore` / `docs` / `refactor`
- 正文写清**问题现象 → 定位过程 → 修复方式**，重要结论给出验证证据
- 分支：`main` 为稳定线，功能分支形如 `feat-xxx`
- 提交前请确认 `bash .selftest/run-all.sh` 全绿
