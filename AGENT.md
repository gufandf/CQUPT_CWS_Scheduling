# AGENT.md

本文件面向在此仓库中工作的 AI 编码代理，记录**运行方式、架构约束、以及容易踩的坑**。
人类贡献者请先读 `README.md`。

---

## 1. 项目概览

重庆邮电大学勤工助学中心学生打印社的**排班工具**：输入学号 → 抓取教务课表 → 自动排值班表，
并支持拖拽微调、导出值班表 / 空课表 Excel。

- **形态**：单机本地工具，无构建步骤、无打包器、无前端框架
- **技术栈**：Python 3 标准库 `http.server` 作后端 + 单个 HTML 文件作前端（原生 JS）
- **代码量**：`app.py` 约 590 行，`templates/index.html` 约 3450 行（含内联 CSS/JS）
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

# 跑自测（218 项，无需浏览器，仅需 node）
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
> `重庆邮电大学勤工助学中心第二十七届成员信息表.csv`、`__pycache__/`。

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

单文件，按此顺序：`<style>` → 页面骨架 → 各弹窗 → `<script>`。
关键锚点（行号会随改动漂移，用函数名检索更稳）：

| 函数 / 常量 | 作用 |
| --- | --- |
| `CONFIG` | 节次时间表、`maxPeriods=12`、`maxWeeklyShifts=3`、忽略课程关键词 |
| `DAY_GROUPS` | 两个分组：`weekday`(周一~五) / `weekend`(周六日) |
| `state` | 全局状态（学生、模板、单双周排班、忽略课程……） |
| `deriveConflictPeriods()` | 由班次起止时间推导冲突节次 |
| `makeDefaultTemplate()` | 内置默认模板（与原硬编码配置逐项一致） |
| `normalizeTemplate()` | 模板规范化：补字段、丢非法项、按时间排序、兼容旧格式 |
| `generateShiftKey()` / `parseShiftKey()` / `resolveShift()` | 排班键的生成与解析 |
| `pruneInvalidAssignments()` | 模板变更后清理失效排班、补齐新槽位 |
| `initAssignments()` / `runSchedule()` | 初始化槽位 / 自动排班主循环 |
| `buildGridSkeleton()` | 值班表与空课表共用的网格骨架 |
| `renderSchedule()` / `renderFreeSchedule()` | 值班表 / 空课表渲染 |
| `renderTemplateEditor()` / `renderShiftCard()` | 模板编辑器 UI |
| `validateDraft()` / `saveTemplateEditor()` | 保存前校验 / 应用模板 |
| `exportDutySchedule()` / `exportFreeSchedule()` / `exportData()` | 导出 |
| `handleImportFile()` / `handleTemplateFileImport()` | 导入 |

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

任何来自外部的模板（localStorage、导入的 JSON、模板文件）**都必须经过它**。
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

---

## 5. 测试

`.selftest/` 是一个**不依赖浏览器**的 Node 自测套件：

```
harness.js              最小 DOM / localStorage / XLSX 桩
test-model.js           81 项：模板模型、键解析、冲突推导、持久化
test-integration.js    137 项：排班、剪枝、渲染、导出、导入往返
run-all.sh              入口
```

原理：`harness.js` 用正则从 `templates/index.html` 中**抽取最长的内联 `<script>`**，
在 `vm` 沙箱里直接运行页面真实代码。所以**测试对象永远是最新代码，不需要构建或导出**。

用法：

```js
const { g, ok, eq, section, summary, el } = require('./harness.js');
g("state.template = makeDefaultTemplate()");   // 在页面作用域内求值
eq(g("deriveConflictPeriods('10:00','12:05')"), [3, 4], '早班冲突节次');
```

改前端逻辑后**请先跑 `bash .selftest/run-all.sh`**，它能挡住绝大多数回归。
若新增功能，请同步补测试——尤其涉及 §4 的不变式时。

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

### 6.2 换行符跨文件不一致

工作区里 `templates/index.html`、`README.md` 是 **LF**，而 `app.py`、
`requirements.txt` 是 **CRLF**（历史原因）。仓库根有 `.gitattributes`（`* text=auto`）
做规范化，因此**改动时保持各文件原有风格即可，不要整文件转换**，
否则会产生数千行的「伪 diff」，把真实改动淹没。

用 `write` / `edit` 工具整文件重写时要注意：它们可能顺带丢掉 UTF-8 BOM、或统一换行符。
`templates/index.html` **原本带 BOM**，改动后请确认（应输出 `BOM=True` 且孤立 LF 为 0）：

```bash
python3 -c "
import pathlib
for f in ['templates/index.html','README.md','app.py','requirements.txt']:
    d = pathlib.Path(f).read_bytes()
    crlf = d.count(b'\r\n'); lf = d.count(b'\n') - crlf
    print(f'{f:24s} CRLF={crlf:5d} LF={lf:5d} BOM={d[:3] == b\"\xef\xbb\xbf\"}')
"
```

### 6.3 `.gitignore` 忽略了自己，且与 `.selftest` 状态矛盾

`.gitignore` 第 2 行是 `.gitignore`（即它忽略自身），所以**它本身未被 git 跟踪，
对它的修改不会出现在 `git status` 里**，容易被忽略掉。

同时第 8 行的 `.selftest` 是**误导性的**：`.selftest/` 下 4 个文件已被 git 跟踪，
而**已被跟踪的文件不受 `.gitignore` 影响**。所以该行目前不起作用；
若想让自测套件真正被忽略，需要先 `git rm --cached`。

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
  }
}
```

**兼容性**：`version: 2` 的旧文件（无 `template` 字段）仍可导入，沿用当前模板。
`handleImportFile()` 会用 `remapAssignmentIds(_idRemap)` 迁移被清洗过的班次 id，
避免排班被误判失效而清除。

### 7.2 值班模板结构

```jsonc
{
  "version": 1,
  "name": "默认模板",
  "groups": {
    "weekday": [ /* 班次数组 */ ],
    "weekend": [ /* 班次数组 */ ]
  }
}
```

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

### 7.3 localStorage 键

| 键 | 内容 |
| --- | --- |
| `shift_duty_template_v1` | 当前值班模板（`TEMPLATE_STORAGE_KEY`） |
| `shift_ignored_courses` | 各学生被忽略的课程 ID |
| `theme` | `auto` / `light` / `dark` |

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
