# 自动签到服务

基于 Node.js 和 Playwright 的一次性自动签到脚本。程序启动后会登录目标站点，按配置执行个人打卡或小组长打卡流程，并把运行日志和失败截图保存到 `runtime/` 目录。

> 请只在你有权限操作的账号和系统中使用，并确保签到内容符合实际情况。

## 功能概览

- 启动时自动读取 `.env` 配置。
- 支持先做预检查：如果今天已经完成签到，直接记录日志并退出。
- 支持多步骤打卡：`personal`、`leader` 可单独或组合执行。
- 支持普通点击、多按钮顺序点击、精确文本点击、滑块拖动等提交动作。
- 支持失败重试，最多 3 次，并按区间随机退避。
- 失败时自动截图，便于排查页面结构或选择器变化。
- 程序本身不常驻，不负责定时；推荐交给 `systemd timer`、计划任务或其他调度器。

## 环境要求

- Node.js 20 或更高版本
- Playwright Chromium

安装依赖：

```bash
npm install
npx playwright install chromium
```

## 快速开始

1. 复制环境变量模板：

```bash
cp .env.example .env
```

2. 编辑 `.env`，至少填写：

```env
TARGET_URL=https://your-checkin-domain.example.com
CHECKIN_USERNAME=your_username
CHECKIN_PASSWORD=your_password
```

3. 按页面实际结构调整站点配置：

```text
config/site-config.json
config/site-config.student.json
```

4. 手动执行一次：

```bash
npm run start
```

## 常用命令

```bash
npm run start        # 执行完整签到流程
npm run fill-login   # 仅填充登录信息，便于调试输入
npm run login-only   # 填充登录信息并点击登录
npm test             # 运行单元测试
```

## 配置说明

### 环境变量

必填项：

| 变量 | 说明 |
| --- | --- |
| `TARGET_URL` | 目标站点根地址，例如 `https://example.com` |
| `CHECKIN_USERNAME` | 登录账号，通常是学号或工号 |
| `CHECKIN_PASSWORD` | 登录密码或姓名，取决于目标系统登录表单 |

常用可选项：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TIMEZONE` | `Asia/Shanghai` | 日期判断使用的时区 |
| `SITE_CONFIG_PATH` | `./config/site-config.json` | 站点选择器配置文件 |
| `CHECKIN_STEPS` | `personal,leader` | 执行步骤，支持 `personal`、`leader`，用逗号分隔 |
| `CHECKIN_PRECHECK` | `true` | 是否先检查今天是否已完成 |
| `SCREENSHOT_DIR` | `./runtime/screenshots` | 失败截图目录 |
| `LOG_PATH` | `./runtime/app.log` | 日志文件路径 |
| `MAX_ATTEMPTS` | `3` | 最大尝试次数，代码内最多限制为 3 次 |
| `BACKOFF_MIN_MS` | `30000` | 重试最小等待时间 |
| `BACKOFF_MAX_MS` | `90000` | 重试最大等待时间 |
| `HEADLESS` | `true` | 是否使用无头浏览器 |
| `BROWSER_CHANNEL` | 空 | 指定浏览器通道，例如 `msedge` |
| `BROWSER_TIMEOUT_MS` | `20000` | 页面操作超时时间 |
| `BROWSER_SLOW_MO_MS` | `0` | 浏览器操作慢放时间，调试时可加大 |
| `CHECKIN_ACTION_BUFFER_MS` | `1500` | 每个提交动作前后的缓冲等待 |

登录输入相关：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LOGIN_INPUT_MODE` | `ime` | 输入模式，支持 `ime`、`native-ime`、`paste-twice`、`type` |
| `LOGIN_TYPE_DELAY_MS` | `180` | 模拟输入间隔 |
| `LOGIN_FIELD_SETTLE_MS` | `2000` | 填完字段后的等待时间 |
| `LOGIN_NAME_READY_SETTLE_MS` | `1500` | 姓名输入框出现后的等待时间 |
| `LOGIN_PASTE_SETTLE_MS` | `1200` | `paste-twice` 模式两次粘贴之间的等待 |
| `LOGIN_IME_TEXT` | 空 | `native-ime` 模式下发送给系统输入法的文本，例如拼音 |
| `LOGIN_IME_COMMIT_KEY` | `SPACE` | `native-ime` 模式下提交候选词的按键 |
| `LOGIN_WINDOW_TITLE` | 学生日常打卡系统 | `native-ime` 模式下用于激活浏览器窗口 |

普通用户通常可以这样配置：

```env
SITE_CONFIG_PATH=./config/site-config.student.json
CHECKIN_STEPS=personal
```

小组长账号通常保留默认值：

```env
SITE_CONFIG_PATH=./config/site-config.json
CHECKIN_STEPS=personal,leader
```

### 站点配置

站点配置是 JSON 文件，用来描述登录页、个人打卡页和小组长打卡页的地址与选择器。

`url` 可以写相对路径，例如 `/login`、`/group/today`。程序会自动和 `.env` 中的 `TARGET_URL` 拼成完整地址。

基础结构：

```json
{
  "login": {
    "url": "/login",
    "usernameSelector": "input[name=\"username\"]",
    "passwordSelector": "input[name=\"password\"]",
    "submitSelector": "role=button[name=/登录/]"
  },
  "personal": {
    "url": "/student/home",
    "alreadyDoneSelector": "text=/今日.*(已打卡|已签到|打卡成功|签到成功)/",
    "submitSequence": [],
    "successSelector": "text=/打卡成功|签到成功|提交成功/"
  },
  "leader": {
    "url": "/group/today",
    "alreadyDoneSelector": "text=今日打卡已提交",
    "submitSelector": "role=button[name=/提交/]",
    "confirmSelector": "role=button[name=/确认/]",
    "successSelector": "text=提交成功"
  },
  "auth": {
    "loggedInSelector": "text=/今日打卡|退出/",
    "loginFailedPattern": "信息有误|账号不存在|invalid|incorrect"
  }
}
```

`personal` 和 `leader` 支持两种提交方式，二选一：

- `submitSelector`：只有一个提交按钮时使用。
- `submitSequence`：需要多个动作按顺序执行时使用。

`submitSequence` 动作字段：

| 字段 | 说明 |
| --- | --- |
| `type` | 动作类型，默认 `click` |
| `selector` | Playwright 选择器，必填 |
| `text` | 文本类动作需要匹配的文本 |
| `confirmSelector` | 动作后如果出现确认按钮，则点击它 |
| `waitForSelector` | 动作后等待某个元素出现 |
| `waitMs` | 动作后固定等待毫秒数 |
| `distance` | 拖动距离，滑块动作必填 |
| `steps` | 拖动步数 |
| `offsetX` / `offsetY` | 文本点击动作的坐标偏移 |

支持的动作类型：

| 类型 | 说明 |
| --- | --- |
| `click` | 点击 `selector` 匹配到的元素 |
| `clickExactTextCard` | 根据精确文本定位卡片并点击 |
| `clickExactTextOffset` | 根据精确文本定位，再按偏移点击 |
| `drag` | 拖动 `selector` 匹配到的滑块元素 |
| `dragTrackByText` | 根据轨道文本定位滑块轨道并拖动 |

滑块示例：

```json
{
  "selector": "text=向右拖动滑块",
  "type": "dragTrackByText",
  "text": "向右拖动滑块",
  "distance": 430,
  "steps": 45,
  "waitMs": 1200
}
```

`distance` 是水平拖动像素，需要根据实际页面宽度微调。

## 运行产物

- `runtime/app.log`：结构化运行日志。
- `runtime/screenshots/`：失败截图。

日志中常见状态：

| 状态 | 含义 |
| --- | --- |
| `already_done` | 检测到今天已经完成 |
| `not_done` | 预检查发现尚未完成 |
| `submitted` | 本次提交成功 |
| `run_failed` | 重试后仍失败 |
| `precheck_failed_continue` | 预检查失败，但继续执行正式流程 |

## 调试建议

- 页面选择器失效时，先把 `HEADLESS=false` 打开，观察浏览器实际停在哪一步。
- 页面动作太快时，适当调大 `BROWSER_SLOW_MO_MS` 或 `CHECKIN_ACTION_BUFFER_MS`。
- 登录字段是中文姓名时，优先尝试 `LOGIN_INPUT_MODE=ime`；如果目标页面依赖系统输入法，可尝试 `native-ime`。
- 滑块失败时，优先调整 `distance` 和 `steps`，并查看失败截图确认轨道位置。
- 如果失败截图显示仍在登录页，重点检查账号密码、登录选择器和 `auth.loggedInSelector`。

## systemd 定时示例

仓库中提供了两个示例文件：

- `deployment/daily-checkin.service`
- `deployment/daily-checkin.timer`

部署示例：

```bash
sudo cp deployment/daily-checkin.service /etc/systemd/system/
sudo cp deployment/daily-checkin.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now daily-checkin.timer
sudo systemctl status daily-checkin.timer
```

修改定时时间请编辑 `deployment/daily-checkin.timer` 中的 `OnCalendar`。

## 项目结构

```text
src/
  automation/       # Playwright 自动化流程与提交动作
  core/             # 重试执行器
  domain/           # 日期与时间窗口逻辑
  utils/            # 通用工具
  config.js         # 环境变量和站点配置读取
  index.js          # 程序入口
  logger.js         # 日志写入
  service.js        # 一次性服务编排
config/             # 站点选择器配置
deployment/         # systemd 示例
scripts/            # 调试脚本
test/               # 单元测试
runtime/            # 日志和截图输出目录
```

## 注意事项

- `.env` 包含账号密码，不要提交到版本库。
- 目标站点页面结构变化后，通常只需要更新 `config/*.json` 中的选择器。
- 程序按一次性任务设计，执行完成后退出；定时执行请交给外部调度器。
