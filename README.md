# 勤工助学中心学生打印社排班工具

为解决学校勤工助学中心学社打印社部门排班问题所制作的排班工具

## 快速开始

1. 安装`requirements.txt`中的库
2. 运行`app.py`
3. 浏览器打开`http://localhost:8765`进入工具

## 功能

1. 输入学号自动从教务系统获取当前学期课表（需要连接校园网或使用VPN）
2. 设置忽略课程（自动识别“实训”“实践”等关键字进行忽略）
3. 鼠标拖动进行排班，拖动时显示空闲班次
4. 导出导入json文件
5. 导出值班表和空课表

## Json文件

包含课程信息和排班信息，可在工具内导入导出。

## 参考

- **[CQUPT-ics](other-project/CQUPT-ics/)**（Python）— ICS 日历生成工具，封装了三种课表数据源
- **[cqupt-sdk-jwzx](other-project/cqupt-sdk-jwzx/)**（Java）— 教务在线 Java SDK，封装了教务在线各种接口