# 重庆邮电大学学生课表 API 文档

本文档基于 `other-project/` 中的两个项目提取：

- **[CQUPT-ics](other-project/CQUPT-ics/)**（Python）— ICS 日历生成工具，封装了三种课表数据源
- **[cqupt-sdk-jwzx](other-project/cqupt-sdk-jwzx/)**（Java）— 教务在线 Java SDK，封装了教务在线各种接口

---

## 一、基础信息

| 项目 | 描述 |
|------|------|
| **教务在线域名（内网）** | `http://jwzx.cqupt.edu.cn` |
| **教务在线域名（外网）** | `http://jwzx.cqu.pt` |

---

## 二、获取学生课表

共有 **3 种数据源** 可获取学生课表：

### 2.1 教务在线直连（爬虫）

> 来源：`CQUPT-ics/providers/jwzxdirect.py`、`cqupt-sdk-jwzx`

| 项目 | 值 |
|------|-----|
| **请求方式** | `GET` |
| **接口地址** | `/kebiao/kb_stu.php` |
| **参数** | `xh` — 学号（字符串） |
| **请求示例** | `GET http://jwzx.cqupt.edu.cn/kebiao/kb_stu.php?xh=2020XXXXXX` |
| **返回格式** | HTML 页面 |
| **需登录** | 否（公网可直接访问） |
| **解析方式** | 解析 HTML 中的 `#kbStuTabs-table` → `.printTable` → `<table>` → `<tr>` 行，每行对应一个时间段，每个 `.kbTd` 元素代表一门课程 |

**返回数据字段（解析后）：**

| 字段 | 说明 |
|------|------|
| `course_id` | 课程编号（如 `A1090032`） |
| `class_id` | 教学班编号（如 `A00221A1090032015`） |
| `name` | 课程名称 |
| `type` | 课程类型（`必修` / `选修`） |
| `teacher` | 授课教师 |
| `stu_point` | 学分 |
| `raw_week` | 原始周次描述（如 `1-17周单周`） |
| `weekday` | 星期几（1-7） |
| `location` | 上课地点（如 `健美操馆01`） |
| `begin_end_time` | 起始节次数组 `[开始节, 结束节]` |
| `weeks` | 上课周次列表（如 `[1,3,5,7,9,11,13,15,17]`） |

**也适用于教师课表：**

| 接口 | 说明 |
|------|------|
| `GET /kebiao/kb_tea.php?teaId={teacher_id}` | 获取教师课表（来源：Java SDK `JwzxCourseTableService`） |

---

### 2.2 红岩网校 API（JSON）

> 来源：`CQUPT-ics/providers/redrock.py`

| 项目 | 值 |
|------|-----|
| **Base URL** | `https://be-prod.redrock.cqupt.edu.cn/magipoke-jwzx` |
| **请求方式** | `POST` |
| **接口地址** | `/kebiao` |
| **请求头** | `User-Agent: zhang shang zhong you/6.1.1 (iPhone; iOS 14.6; Scale/3.00)` |
| **请求体** | `{"stu_num": <学号整数>}`（`application/x-www-form-urlencoded`） |
| **返回格式** | JSON |

**响应示例：**
```json
{
  "data": [
    {
      "course": "课程名称",
      "teacher": "教师姓名",
      "type": "必修/选修",
      "rawWeek": "原始周次描述",
      "classroom": "上课教室",
      "course_num": "课程编号",
      "week": [1, 2, 3, ...],
      "hash_day": 0-6,
      "begin_lesson": 1,
      "period": 2
    }
  ],
  "nowWeek": 当前周次
}
```

**字段说明：**

| 字段 | 说明 |
|------|------|
| `course` | 课程名称 |
| `teacher` | 授课教师 |
| `type` | 课程类型 |
| `rawWeek` | 原始周次描述 |
| `classroom` | 上课地点 |
| `course_num` | 课程编号 |
| `week` | 上课周次数组 |
| `hash_day` | 星期几（0=周一, 6=周日，使用时需 +1） |
| `begin_lesson` | 开始节次 |
| `period` | 持续节数 |
| `nowWeek` | 当前周次 |

> 该接口还提供考试安排：`POST /examSchedule`，请求体 `{"stuNum": <学号整数>}`。

---

### 2.3 We重邮 API（JSON，需 openid）

> 来源：`CQUPT-ics/providers/wecqupt.py`

| 项目 | 值 |
|------|-----|
| **Base URL** | `https://we.cqupt.edu.cn/api` |
| **请求方式** | `POST` |
| **接口地址** | `/get_kebiao.php` |
| **请求头** | `Content-Type: application/json`、`Referer: https://servicewechat.com/wx8227f55dc4490f45/89/page-frame.html` |
| **请求体** | `{"key": base64(JSON.stringify({"openid": "xxx", "id": "学号", "timestamp": 时间戳}))}` |
| **返回格式** | JSON |
| **需登录** | 是（需要有效的 `openid`） |

**请求体构造方式（Python 伪代码）：**
```python
data_raw = {"openid": "用户的openid", "id": "学号", "timestamp": int(time.time())}
data = {"key": base64.b64encode(json.dumps(data_raw))}
```

**响应示例：**
```json
{
  "status": 200,
  "message": "success",
  "data": {
    "week": 当前周次,
    "lessons": [
      [ // day 0 (周一)
        [ // order 0 (第1-2节)
          { "name": "课程名", "teacher": "教师", "type": "必修/选修",
            "all_week": "周次描述", "place": "地点", "c_id": "课程编号",
            "weeks": [1,2,...], "number": 持续节数 }
        ],
        [ // order 1 (第3-4节)
          ...
        ],
        ... // order 2-5
      ],
      ... // day 1-6
    ]
  }
}
```

**字段说明：**

| 字段 | 说明 |
|------|------|
| `name` | 课程名称 |
| `teacher` | 授课教师 |
| `type` | 课程类型 |
| `all_week` | 周次描述 |
| `place` | 上课地点 |
| `c_id` | 课程编号 |
| `weeks` | 上课周次数组 |
| `number` | 持续节数 |
| `week`（外层） | 当前周次 |

> 该接口还提供考试安排：`POST /get_ks.php`，请求体格式相同。

---

## 三、考试安排查询

| 数据源 | 接口 | 方式 | 参数 |
|--------|------|------|------|
| 教务在线直连 | `/ksap/showKsap.php` | `GET` | `type=stu&id={学号}` |
| 红岩网校 | `/examSchedule` | `POST` | `{"stuNum": <学号>}` |
| We重邮 | `/get_ks.php` | `POST` | `{"key": <base64密文>}` |

---

## 四、Java SDK 课表相关接口

> 来源：`cqupt-sdk-jwzx`

### JwzxCourseTableService

| 方法 | 说明 |
|------|------|
| `getStudentCourseTable(String studentId)` | 获取学生课表，返回 `List<JwzxCourseTable>` |
| `getTeacherCourseTable(String teacherId)` | 获取教师课表，返回 `List<JwzxCourseTable>` |

### JwzxCourseTable（课表数据 Bean）

| 字段 | 类型 | 说明 |
|------|------|------|
| `classId` | `String` | 教学班 ID |
| `courseId` | `String` | 课程 ID |
| `courseName` | `String` | 课程名称 |
| `place` | `String` | 上课地点 |
| `weekView` | `String` | 上课周次（显示文本） |
| `weekBin` | `String` | 上课周次（二进制掩码，如 `11111111111111110000`） |
| `duration` | `Integer` | 几节连上（默认 2） |
| `teacherName` | `String` | 教师姓名 |
| `type` | `String` | 课程类型（必修/选修） |
| `credits` | `String` | 学分 |
| `courseStartNo` | `Integer` | 课程起始节次编号（1、3、5、7、9、11） |
| `courseWeek` | `Integer` | 星期几（1-7） |

---

## 五、上课时间对应表

| 节次 | 时间 |
|------|------|
| 第 1 节 | 08:00 - 08:45 |
| 第 2 节 | 08:55 - 09:40 |
| 第 3 节 | 10:15 - 11:00 |
| 第 4 节 | 11:10 - 11:55 |
| 第 5 节 | 14:00 - 14:45 |
| 第 6 节 | 14:55 - 15:40 |
| 第 7 节 | 16:15 - 17:00 |
| 第 8 节 | 17:10 - 17:55 |
| 第 9 节 | 19:00 - 19:45 |
| 第 10 节 | 19:55 - 20:40 |
| 第 11 节 | 20:50 - 21:35 |
| 第 12 节 | 21:45 - 22:30 |

---

## 六、附：教务在线其他 API（Java SDK）

| 服务 | 接口 | 说明 |
|------|------|------|
| `JwzxService` | `POST /checkLogin.php` | 登录（参数：`name`、`password`、`vCode`） |
| `JwzxService` | `GET /createValidationCode.php` | 获取登录验证码图片 |
| `JwzxStudentInfoService` | `GET /data/json_StudentSearch.php?searchKey={keyword}` | 搜索学生基本信息 |
| `JwzxStudentInfoService` | `GET /user.php` | 获取学生扩展信息（需登录） |
| `JwzxStudentInfoService` | `GET /kebiao/kb_stuList.php?jxb={classId}` | 获取教学班学生列表 |
| `JwzxStudentInfoService` | `GET /showstupic.php?xh={studentId}` | 获取学生照片 |
| `JwzxClassroomInfoService` | `GET /kebiao/index.php` | 获取教室列表 |
| `JwzxClassroomInfoService` | `GET /jssq/jssqEmptyRoom.php` | 查询空闲教室（参数：`zc`=周次, `xq`=星期, `sd`=时段） |
| `JwzxGradeService` | `GET /student/chengjiPm.php` | 成绩总表（需登录） |
| `JwzxGradeService` | `GET /student/chengji.php` | 当前学期平时成绩（需登录） |
| `JwzxGradeService` | `GET /student/chengjiQm.php` | 期末成绩（需登录） |
| `JwzxGradeService` | `GET /student/chengjiBk.php` | 补考成绩（需登录） |
| `JwzxCourseBookService` | `GET /student/jiaocai.php` | 教材信息（需登录） |
| `JwzxTeacherInfoService` | `GET /data/json_teacherSearch.php?searchKey={keyword}` | 搜索教师信息 |
| `JwzxCollegeInfoService` | `GET /kebiao/index.php` | 获取学院信息 |
| `JwzxNewsService` | `GET /data/json_files.php` | 获取新闻列表（参数：`pageNo`, `pageSize`, `searchKey`） |
| `JwzxNewsService` | `GET /fileShowContent.php` | 获取新闻详情（参数：`id`） |
