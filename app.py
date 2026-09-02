"""
学生打印社值班表系统 - 服务器
功能：1. 提供静态文件服务  2. 代理API请求到多个数据源
"""
import http.server
import urllib.parse
import json
import os
import sys
import re
import errno
import hashlib
import random
import requests
import urllib3

urllib3.disable_warnings()

PORT = 8765
TEMPLATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'templates')


# ================================================================
#  数据获取函数
# ================================================================

def fetch_redrock(sid):
    """红岩网校 API"""
    try:
        r = requests.post(
            'https://be-prod.redrock.cqupt.edu.cn/magipoke-jwzx/kebiao',
            data={'stu_num': int(sid)},
            headers={
                'User-Agent': 'zhang shang zhong you/6.1.1 (iPhone; iOS 14.6; Scale/3.00)',
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json, text/plain, */*',
            },
            timeout=8,
            verify=False
        )
        data = r.json()
        if data.get('status') == 20002:
            return None, '红岩网校API验证失败(20002)'
        if 'data' not in data:
            return None, '红岩网校返回格式异常'
        courses = []
        for item in data['data']:
            courses.append({
                'course': item.get('course', '未知课程'),
                'teacher': item.get('teacher', ''),
                'type': item.get('type', ''),
                'rawWeek': item.get('rawWeek', ''),
                'classroom': item.get('classroom', ''),
                'course_num': item.get('course_num', ''),
                'week': item.get('week', []),
                'hash_day': item.get('hash_day', 0),
                'begin_lesson': item.get('begin_lesson', 1),
                'period': item.get('period', 2)
            })
        return {
            'sid': sid,
            'name': f'同学{sid[-4:]}',
            'nowWeek': data.get('nowWeek', 0),
            'courses': courses,
            'source': 'redrock'
        }, None
    except requests.Timeout:
        return None, '红岩网校API超时'
    except requests.ConnectionError:
        return None, '红岩网校API连接失败'
    except Exception as e:
        return None, f'红岩网校错误: {str(e)[:100]}'


def fetch_jwzx(sid):
    """教务在线直连 - HTML解析"""
    session = requests.Session()
    session.headers.update({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
    })

    try:
        # 先访问首页获取cookie
        try:
            session.get('http://jwzx.cqupt.edu.cn/', timeout=5)
        except Exception:
            pass

        # 获取课表页面
        r = session.get(
            'http://jwzx.cqupt.edu.cn/kebiao/kb_stu.php',
            params={'xh': sid},
            timeout=10
        )
        html = r.text

        # 检查是否同时有反爬且无课程数据
        has_antibot = '$_ts' in html[:2000]
        has_course_table = 'kbStuTabs-table' in html or 'kbTd' in html
        if has_antibot and not has_course_table:
            return None, '教务在线有反爬保护'

        return parse_jwzx_html(html, sid)

    except requests.Timeout:
        return None, '教务在线请求超时'
    except requests.ConnectionError:
        return None, '教务在线连接失败(可能需要校园网)'
    except Exception as e:
        return None, f'教务在线错误: {str(e)[:100]}'


def extract_student_name(html, sid):
    """从课表页面提取学生姓名（学号后面紧跟的汉字）"""
    # 格式: 2025220039张三 或 2025220039 张三
    m = re.search(re.escape(sid) + r'\s*([\u4e00-\u9fff]{2,4})', html)
    if m:
        return m.group(1)
    return f'同学{sid[-4:]}'


def parse_jwzx_html(html, sid):
    """解析教务在线 HTML 课表页面"""
    courses = []
    now_week = 0
    student_name = extract_student_name(html, sid)

    # 当前周次
    m = re.search(r'第\s*(\d+)\s*周', html)
    if m:
        now_week = int(m.group(1))

    # 找到 kbStuTabs-table 区域并提取表格
    idx = html.find('id="kbStuTabs-table"')
    if idx < 0:
        idx = html.find("id='kbStuTabs-table'")
    if idx < 0:
        return {
            'sid': sid, 'name': student_name,
            'nowWeek': now_week, 'courses': [],
            'source': 'jwzx', 'error': '未找到课表区域'
        }, None

    chunk = html[idx:]
    tm = re.search(r'<table[^>]*>(.*?)</table>', chunk, re.DOTALL)
    if not tm:
        return {
            'sid': sid, 'name': student_name,
            'nowWeek': now_week, 'courses': [],
            'source': 'jwzx', 'error': '未找到课表表格'
        }, None

    table_html = tm.group(1)
    rows = re.findall(r'<tr[^>]*>(.*?)</tr>', table_html, re.DOTALL)

    # class_seq: 仅对包含课程数据的行计数
    # 课表行顺序: header -> per1-2 -> per3-4 -> 间歇 -> per5-6 -> per7-8 -> (break) -> per9-10 -> (break)
    class_seq = 0
    for row in rows:
        # 跳过间歇行
        if '间歇' in row:
            continue

        # 找该行所有 kbTd div
        kb_divs = re.findall(
            r'<div[^>]*kbTd[^>]*>(.*?)</div>',
            row, re.DOTALL
        )

        # 没有课程内容的行跳过（header、空行等）
        if not kb_divs:
            continue

        class_seq += 1

        # 解析该行各列（找出每个 kbTd 所在的列，确定 weekday）
        tds = re.findall(r'<td[^>]*>(.*?)</td>', row, re.DOTALL)
        if len(tds) < 2:
            continue

        weekday = 0
        for td in tds:
            if weekday == 0:
                weekday += 1
                continue
            if weekday > 7:
                break

            td_kb_divs = re.findall(
                r'<div[^>]*kbTd[^>]*>(.*?)</div>',
                td, re.DOTALL
            )
            for div_html in td_kb_divs:
                course = parse_kb_div(div_html, class_seq, weekday)
                if course:
                    courses.append(course)
            weekday += 1

    return {
        'sid': sid,
        'name': student_name,
        'nowWeek': now_week,
        'courses': courses,
        'source': 'jwzx'
    }, None


def parse_kb_div(div_html, class_seq, weekday):
    """解析单个课程 div（使用 <br> 分隔的格式）"""
    try:
        # 按 <br> 分割，清理HTML标签
        parts = re.split(r'<br\s*/?>', div_html, flags=re.IGNORECASE)
        # 清理每个部分的HTML标签
        cleaned = []
        for p in parts:
            # 移除HTML标签
            text = re.sub(r'<[^>]+>', '', p).strip()
            if text:
                cleaned.append(text)

        if len(cleaned) < 3:
            return None

        # cleaned[0]: 教学班ID (如 A04252A2130830002)
        # cleaned[1]: 课程编号-课程名称 (如 A2130830-Linux程序开发)
        # cleaned[2]: 地点 (如 地点：2408)
        # cleaned[3] or later: 周次信息 + 教师类型

        class_id = cleaned[0]

        # 解析课程编号和名称
        course_id_name = cleaned[1]
        if '-' in course_id_name:
            course_id, course_name = course_id_name.split('-', 1)
        else:
            course_id = course_id_name
            course_name = course_id_name

        # 查找地点
        location = ''
        for p in cleaned:
            if '地点' in p:
                location = re.sub(r'^地点[：:]\s*', '', p).strip()
                break

        # 查找周次
        raw_week = ''
        for p in cleaned:
            if '周' in p and re.search(r'\d', p):
                # 优先找包含周描述的（如 1-8周, 1-16周）
                raw_week = p.strip()
                break

        # 查找教师和类型（通常在后续部分）
        teacher = ''
        course_type = ''
        for p in cleaned[3:]:
            if '学分' in p and re.search(r'\d', p):
                # 格式：吴挺 选修 3.0学分 或 范春婷 必修 3.0学分
                type_match = re.search(r'[必选]修', p)
                if type_match:
                    course_type = type_match.group(0)
                credit_match = re.search(r'(\d+\.?\d*)学分', p)
                teacher = p
                if course_type:
                    teacher = teacher.replace(course_type, '')
                teacher = re.sub(r'\d+\.?\d*学分', '', teacher)
                teacher = teacher.strip()
                break

        # 如果没找到教师，尝试在最后几个元素中查找
        if not teacher:
            for p in reversed(cleaned):
                if any(kw in p for kw in ['修', '学分']):
                    type_match = re.search(r'[必选]修', p)
                    if type_match:
                        course_type = type_match.group(0)
                    teacher = re.sub(r'[必选]修|\d+\.?\d*学分', '', p).strip()
                    break

        # 周次列表
        weeks = parse_weeks(raw_week)

        # 节次计算
        duration = 2
        # 在raw_week中查找"节连上"
        for p in cleaned:
            dur_match = re.search(r'(\d+)节连上', p)
            if dur_match:
                duration = int(dur_match.group(1))
                break
        # 也在原始HTML中查找（font标签中可能有）
        dur_match2 = re.search(r'(\d+)节连上', div_html)
        if dur_match2:
            duration = int(dur_match2.group(1))

        begin = class_seq * 2 - 1

        return {
            'course': course_name,
            'teacher': teacher,
            'type': course_type,
            'rawWeek': raw_week,
            'classroom': location,
            'course_num': course_id,
            'week': weeks,
            'hash_day': weekday - 1,
            'begin_lesson': begin,
            'period': duration,
            'class_id': class_id
        }
    except Exception:
        return None


def parse_weeks(raw_week):
    """从周次描述解析周次列表，支持 1-16周 / 1-6周,8-12周 / 1周,3-8周 / 20周4节连上 等格式"""
    weeks = []
    try:
        rw = raw_week.strip()
        # 先去掉 "X节连上" 等非周次后缀
        rw = re.sub(r'\d+节连上', '', rw).strip()

        # 处理逗号分隔的多个段：1-6周,8-12周 或 1周,3-8周
        segments = rw.split(',')

        for seg in segments:
            seg = seg.strip()
            if not seg:
                continue

            # 范围模式：1-8周 或 1-16周单周
            range_match = re.search(r'(\d+)\s*[-–]\s*(\d+)\s*周', seg)
            if range_match:
                start = int(range_match.group(1))
                end = int(range_match.group(2))
                if '单周' in seg:
                    weeks.extend(w for w in range(start, end + 1) if w % 2 == 1)
                elif '双周' in seg:
                    weeks.extend(w for w in range(start, end + 1) if w % 2 == 0)
                else:
                    weeks.extend(range(start, end + 1))
                continue

            # 单周模式：20周 或 19周（去除后缀后）
            single_match = re.search(r'(\d+)\s*周', seg)
            if single_match:
                weeks.append(int(single_match.group(1)))
                continue

            # 裸露数字（逗号分隔如 "19,20周" 中的 "19"）
            if re.match(r'^\d+$', seg):
                weeks.append(int(seg))

    except Exception:
        pass

    return sorted(set(weeks)) if weeks else []


def generate_demo(sid):
    """生成演示数据（基于学号哈希，确保同号同数据）"""
    hv = int(hashlib.md5(sid.encode()).hexdigest()[:8], 16)
    rng = random.Random(hv)

    course_pool = [
        ('高等数学A(上)', '必修'), ('大学英语3', '必修'),
        ('线性代数', '必修'), ('数据结构', '必修'),
        ('计算机组成原理', '必修'), ('操作系统', '必修'),
        ('数据库原理', '必修'), ('计算机网络', '必修'),
        ('软件工程', '必修'), ('大学物理B', '必修'),
        ('概率论与数理统计', '必修'), ('马克思主义基本原理', '必修'),
        ('中国近现代史纲要', '必修'), ('思想道德与法治', '必修'),
        ('体育-篮球初级', '必修'), ('Python程序设计', '选修'),
        ('Java程序设计', '选修'), ('Web前端开发技术', '选修'),
        ('人工智能导论', '选修'), ('数字图像处理', '选修'),
    ]
    teachers = ['张三', '李四', '王五', '赵六', '陈七', '刘明', '黄伟',
                 '周静', '吴芳', '郑强', '孙涛', '杨华']
    locations = ['2101', '2203', '2305', '3106', '3208', '3302',
                  '4101', '4204', '4306', '5109', '5203', '5307',
                  '综合实验楼A301', '信息科技大厦503', '健美操馆01']

    num = rng.randint(5, 8)
    selected = rng.sample(course_pool, min(num, len(course_pool)))
    courses = []
    used = set()

    for name, ctype in selected:
        course_num = f'A{rng.randint(1000000, 1999999)}'
        # 分配不冲突的时间
        for _ in range(50):
            wd = rng.randint(1, 5)
            bl = rng.choice([1, 3, 5, 7, 9])
            pd = 2 if rng.random() < 0.7 else rng.choice([3, 4])
            if bl + pd - 1 > 12:
                continue
            if not any((wd, p) in used for p in range(bl, bl + pd)):
                for p in range(bl, bl + pd):
                    used.add((wd, p))
                break
        else:
            continue

        pat = rng.choice(['all', 'odd', 'even'])
        if pat == 'all':
            weeks = list(range(1, 17))
            rw = '1-16周'
        elif pat == 'odd':
            weeks = [w for w in range(1, 17) if w % 2 == 1]
            rw = '1-16周单周'
        else:
            weeks = [w for w in range(1, 17) if w % 2 == 0]
            rw = '1-16周双周'

        courses.append({
            'course': name,
            'teacher': rng.choice(teachers),
            'type': ctype,
            'rawWeek': rw,
            'classroom': rng.choice(locations),
            'course_num': course_num,
            'week': weeks,
            'hash_day': wd - 1,
            'begin_lesson': bl,
            'period': pd
        })

    return {
        'sid': sid,
        'name': f'同学{sid[-4:]}',
        'nowWeek': 8,
        'courses': courses,
        'source': 'demo'
    }


# ================================================================
#  HTTP 请求处理器
# ================================================================

class ProxyHandler(http.server.SimpleHTTPRequestHandler):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=TEMPLATE_DIR, **kwargs)

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass

    def log_message(self, format, *args):
        try:
            msg = args[0] if args else str(format)
            if '/api/' in str(msg):
                sys.stdout.write(f"[{self.log_date_time_string()}] {msg}\n")
                sys.stdout.flush()
        except Exception:
            pass

    def send_cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_cors_headers()
        self.end_headers()

    def do_GET(self):
        try:
            parsed = urllib.parse.urlparse(self.path)

            if parsed.path.startswith('/api/'):
                self.handle_api(parsed)
                return

            if parsed.path in ('/', ''):
                self.path = '/index.html'

            super().do_GET()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith('/api/'):
            self.handle_api(parsed)
            return
        self.send_error(404)

    def handle_api(self, parsed):
        params = dict(urllib.parse.parse_qsl(parsed.query))
        sid = params.get('sid', '').strip()

        if not sid or not re.match(r'^\d{10}$', sid):
            self.send_json_error(400, '无效的学号（需要10位数字）')
            return

        if parsed.path in ('/api/kebiao', '/api/student_info'):
            self.get_kebiao(sid)
        elif parsed.path == '/api/kebiao_jwzx':
            self.get_jwzx_only(sid)
        else:
            self.send_json_error(404, f'未知API: {parsed.path}')

    def get_kebiao(self, sid):
        """多数据源依次尝试"""
        # 1. 红岩网校
        result, error = fetch_redrock(sid)
        if result and result.get('courses'):
            result['_tried'] = 'redrock'
            self.send_json_response(200, result)
            return

        # 2. 教务在线
        result, error = fetch_jwzx(sid)
        if result and result.get('courses'):
            result['_tried'] = 'jwzx'
            self.send_json_response(200, result)
            return

        # 3. 无可用的课表数据源
        self.send_json_error(502, '课表获取失败，请检查校园网络连接。')

    def get_jwzx_only(self, sid):
        """仅通过教务在线获取"""
        result, error = fetch_jwzx(sid)
        if result and result.get('courses'):
            self.send_json_response(200, result)
        else:
            self.send_json_error(502, error or '教务在线获取失败')

    def send_json_response(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', len(body))
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def send_json_error(self, status, message):
        self.send_json_response(status, {'error': message, 'courses': []})


def main():
    try:
        server = http.server.ThreadingHTTPServer(('0.0.0.0', PORT), ProxyHandler)
        server.daemon_threads = True
    except OSError as e:
        if e.errno == errno.EADDRINUSE or 'Address already in use' in str(e) or e.errno == 10048:
            print(f'端口 {PORT} 已被占用')
            sys.exit(1)
        else:
            print(f'启动失败: {e}')
            sys.exit(1)

    print(f'Server started: http://localhost:{PORT}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nServer stopped')
        server.shutdown()


if __name__ == '__main__':
    main()
