# feishu-pi-bridge

飞书长连接 ↔ Pi Agent RPC 桥接守护进程。基于第 15 课《飞书长连接接入》扩展为
可日常使用的常驻服务，额外支持：进程启停（start/stop/restart）、状态查询
（status）、日志跟随（logs）、多 chat session 隔离、错误恢复、idle 自动清理。

## 前置教学

`lessons/` 目录包含 15 课 HTML 教程，从零开始介绍 Pi Agent 及其扩展开发，是本项目的前置知识：

| 文件 | 课题 |
|---|---|
| `lessons/0001-what-is-pi.html` | 第 1 课 · Pi 是什么 |
| `lessons/0002-install-and-start.html` | 第 2 课 · 安装与启动 Pi |
| `lessons/0003-session-lifecycle.html` | 第 3 课 · Pi 的会话生命周期 |
| `lessons/0004-agent-loop.html` | 第 4 课 · Agent Loop 详解 |
| `lessons/0005-builtin-tools.html` | 第 5 课 · 四个内置工具详解 |
| `lessons/0006-slash-and-context.html` | 第 6 课 · Slash 命令与 Context Files |
| `lessons/0007-session-management.html` | 第 7 课 · Session 管理与分支 |
| `lessons/0008-extension-concepts-modes.html` | 第 8 课 · Extension 概念与四种运行模式 |
| `lessons/0009-first-extension.html` | 第 9 课 · 你的第一个 Extension |
| `lessons/0010-commands-and-events.html` | 第 10 课 · 注册命令与事件钩子 |
| `lessons/0011-extension-state-and-ui.html` | 第 11 课 · Session 持久化与交互 UI |
| `lessons/0012-custom-provider.html` | 第 12 课 · 自定义 LLM Provider |
| `lessons/0013-skills-and-prompts.html` | 第 13 课 · Skills 与 Prompt Templates |
| `lessons/0014-pi-package.html` | 第 14 课 · Pi Package 与扩展加载机制 |
| `lessons/0015-feishu-extension.html` | 第 15 课 · 飞书长连接接入：不需要公网 IP |

建议按顺序阅读，第 15 课直接与本项目相关。

## 工作原理

```
飞书长连接 (WSClient)              Pi RPC 子进程池
       │                                  │
       │  im.message.receive_v1           │
       ├─────────────► message-handler ───┤
       │                │                 │
       │                ▼                 ▼
       │  replyCard   spawn pi --mode rpc --session-id feishu-<chat>
       │  "Pi 思考中" 每个 chat_id 一个常驻 RPC 进程
       │                                  │
       │  ◄──── patchCard 最终回复 ───────┘
       ▼
   飞书群消息
```

每个 chat_id（私聊或群聊）对应一个独立的 Pi RPC 子进程，使用
`--session-id feishu-<chat_id>` 绑定独立会话文件（持久化在
`~/.pi/agent/sessions/`）。所有 Pi 扩展（包括 `~/.pi/agent/extensions/` 与
`package.json` 中声明的）都会自动加载。

## 安装

```bash
cd ~/code/projects/feishu-pi-bridge
pnpm install
pnpm run build
pnpm link --global        # 让 feishu-pi-bridge 全局可用
```

## 配置

项目根目录 `.env.example` 列出了所有配置项及说明。复制并填入实际值：

```bash
cp .env.example .env
```

必填项：

| 变量 | 说明 |
|---|---|
| `FEISHU_APP_ID` | 飞书应用 App ID |
| `FEISHU_APP_SECRET` | 飞书应用 App Secret |

可选项：

| 变量 | 说明 |
|---|---|
| `PI_PROVIDER` | 默认 provider（留空则用 Pi settings.json 的 defaultProvider） |
| `PI_MODEL` | 默认 model（留空则用 Pi settings.json 的 defaultModel） |
| `FEISHU_MODEL_MAP` | `/model <编号>` 快捷切换映射，格式 `1=provider/model,2=model` |
| `FEISHU_DAILY_REPORT_CHAT_ID` | 日报推送目标群 chat_id（使用日报功能必填） |
| `FEISHU_BRIDGE_ENV_FILE` | 显式指定 .env 路径（默认从 cwd 或项目根目录查找） |
| `FEISHU_BRIDGE_NO_ENV_OVERRIDE` | 设为 `1` 时 .env 不覆盖已存在的系统环境变量 |

飞书开放平台要求：
- 应用类型：企业自建应用
- 开启机器人能力
- 事件订阅选择**长连接模式**（不是请求网址）
- 添加事件 `im.message.receive_v1`
- 发布应用并拉进群

## Pi 扩展包安装

> https://pi.dev/package

### 安装命令

```bash
pi install npm:@gotgenes/pi-subagents
pi install npm:@gotgenes/pi-permission-system
pi install npm:@juicesharp/rpiv-todo
pi install npm:pi-tool-display
pi install npm:@ff-labs/pi-fff
pi install npm:@plannotator/pi-extension
```

或批量写入 `~/.pi/agent/settings.json` 的 `packages` 字段后重启 Pi，首次启动会自动安装。

### 扩展包列表

| 包名 | 用途 |
|---|---|
| `@gotgenes/pi-subagents` | 子代理功能 |
| `@gotgenes/pi-permission-system` | 权限管理 |
| `@juicesharp/rpiv-todo` | Todo 功能 |
| `pi-tool-display` | 工具调用结果的简洁显示 |
| `@ff-labs/pi-fff` | 查询增强（注册 fffind / ffgrep 工具，索引后查询极快） |
| `@plannotator/pi-extension` | 计划模式（Ctrl+Alt+P 切换） |

## Pi Agent 扩展

项目 `pi/` 目录包含 Pi Agent 的扩展配置，初次部署需拷贝到 `~/.pi/agent/`：

```bash
cp -r pi/agent/* ~/.pi/agent/
```

拷贝后在 `~/.pi/agent/prompts/` 下执行 `pnpm install` 安装日报 prompt 依赖。

`pi/` 目录内容：

| 路径 | 用途 |
|---|---|
| `pi/agent/claude-commands.ts` | 自定义斜杠命令扩展 |
| `pi/agent/provider-tencent.ts` | Tencent provider 扩展 |
| `pi/agent/statusline.ts` | 状态栏扩展 |
| `pi/agent/prompts/daily-report.md` | 日报 prompt 模板 |
| `pi/agent/skills/aihot/` | AI 热榜 skill |
| `pi/agent/skills/tavily-search/` | Tavily 搜索 skill |
| `pi/agent/skills/github-trending/` | GitHub Trending skill |
| `pi/agent/skills/edge-tts/` | Edge TTS skill |
| `pi/agent/skills/frontend-design/` | 前端设计 skill |
| `pi/agent/skills/hyperframes/` | Hyperframes skill |
| `pi/agent/skills/teach/` | 教学 skill |

## 使用

```bash
feishu-pi-bridge start              # 启动守护进程
feishu-pi-bridge status             # 查看运行状态
feishu-pi-bridge logs -f            # 实时跟随日志
feishu-pi-bridge logs -n 100        # 查看最近 100 行日志
feishu-pi-bridge stop               # 停止
feishu-pi-bridge restart            # 重启
feishu-pi-bridge daily-report       # 手动触发日报推送（新会话）
feishu-pi-bridge daily-report --keep-session  # 手动触发日报推送（复用历史 session）
```

`start` 必须在含 `.env` 的目录下执行（或用 `FEISHU_BRIDGE_ENV_FILE` 指定路径）。

启动后在飞书群里 @机器人 发消息测试，应看到 "Pi 思考中…" 的占位卡片，随后被
patch 为 Pi 的实际回复。

## 飞书命令

发消息以 `/` 开头即识别为命令（不传给 Pi）：

| 命令 | 行为 |
|---|---|
| `/new` | 新开会话——删当前 chat 的 session 历史 + kill RPC，下次消息从空白开始 |
| `/model` | 查看当前模型、默认模型和可用编号 |
| `/model <编号>` | 按编号快速切换（`0`=恢复默认，`1/2/3...`=映射表中配置的模型） |
| `/model <pattern>` | 按字符串切换，下条消息生效。pattern 支持：`glm-4.6` / `anthropic/claude-sonnet-4` / `claude-sonnet-4:high`（Pi 标准 `--model` 语法） |
| `/model reset` | 恢复默认模型（env 配的 `PI_MODEL` 或 Pi settings.json 的 defaultModel） |
| `/help` | 显示命令列表 |

此外，发 `日报` / `daily` / `/daily` / `daily report` 会即时触发日报推送到配置的
目标群。

**模型持久化**：`/model` 设置的覆盖只在当前 daemon 进程生命周期内有效，daemon
重启后丢失。要长期固定，在 `.env` 里配置 `PI_PROVIDER` / `PI_MODEL`。

## 模型配置

### 默认模型

`.env` 里写：

```
PI_PROVIDER=NewAPI
PI_MODEL=glm-4.6
```

spawn 出来的 `pi --mode rpc` 会带 `--provider NewAPI --model glm-4.6`，覆盖所有
chat 的默认模型。env 留空时用 Pi settings.json 里的 `defaultProvider` /
`defaultModel`。

### 编号快捷切换

`.env` 里配 `FEISHU_MODEL_MAP` 即可在飞书里用 `/model <编号>` 快速切换，避免手敲
完整模型 ID：

```
FEISHU_MODEL_MAP="1=NewAPI/glm-5.2,2=Tencent/deepseek-v4-flash-202605,3=Tencent/deepseek-v4-pro-202606"
```

- 格式：逗号分隔的 `编号=模型ID`，编号必须是 ≥ 1 的整数
- `0` 保留给"恢复默认"，等价于 `/model reset`
- **跨 provider 必须用 `provider/modelId` 形式**（与 Pi 标准 `--model provider/id` 一致），否则会被自动套上 `PI_PROVIDER`，落到错误的 provider 下
- 同 provider 下的模型可省略前缀，自动套用 `PI_PROVIDER`
- 未配置时 `/model <编号>` 会提示无映射，`/model <pattern>` 文本匹配仍可用
- 改映射只需改 `.env` 并 `feishu-pi-bridge restart`，无需重新编译

## 每日聚合日报

聚合 Pi 三个 skill（`aihot` / `tavily-search` / `github-trending`）输出一份
"今日 AI × 科技日报"，作为 indigo 飞书卡片推送到指定群。三种触发方式：

| 触发方式 | 说明 |
|---|---|
| 系统 crontab | `0 8,20 * * * ~/code/projects/feishu-pi-bridge/scripts/daily-report.sh >> /tmp/feishu-daily-report.log 2>&1` |
| 飞书关键词 | 群里发 `日报` / `daily` / `/daily` / `daily report`，daemon 即时触发推送 |
| Pi slash command | Pi TUI 里输入 `/daily-report` 直接看 markdown（不推飞书） |

### 工作原理

`/daily-report` 是 Pi 原生 **prompt template**，定义在
`~/.pi/agent/prompts/daily-report.md`。Pi 收到 `/daily-report` 后展开成完整
prompt，由 LLM 自然调度三个 skill：

1. `aihot` ← 「看看今天的 AI 日报」
2. `tavily-search` ← 「看看今天的热门新闻」
3. `github-trending` ← 「看看今天的热门仓库」

整合后输出 H1 标题 + 三章节 markdown。bridge 用虚拟 chatId
`daily-report-bot` 通过 RPC 调用 Pi（不污染任何用户 session），拿到
markdown 后拆出第一行 H1 做卡片标题，正文走 indigo 模板推送。

### 定时脚本

cron 环境不 source 任何 shell 配置，缺两样东西会让日报失败：nvm 的 node 路径、
外网代理（Pi 调 aihot/tavily/github 国内必须走代理）。仓库自带
`scripts/daily-report.sh` 封装了这两点（代理硬编码 `127.0.0.1:17890`，换端口
改脚本），飞书凭证仍由 bridge 的 `loadEnvFile` 从 `.env` 读。

### 前置依赖

- `tvly` CLI（tavily-search skill 需要）：`curl -fsSL https://cli.tavily.com/install.sh | bash && tvly login`
- aihot / github-trending skill：Pi 自动加载，无需额外配置

### 已知特性

- Pi 串行调三个 skill 耗时 1-3 分钟，bridge 内部 RPC 超时给到 10 分钟
  （`config.dailyReport.promptTimeoutMs`）
- 任一 skill 失败时 prompt 要求 LLM 在对应章节写降级提示，其他章节照常
- 单卡片超 28KB 由 `chunkMarkdown` 按章节边界分片，多卡片续发
- 飞书关键词触发的 chatId 与推送目标 chatId 解耦：在 A 群发"日报"也能推到
  配置里的目标 B 群，并在 A 群回复确认

## 文件布局

| 路径 | 用途 |
|---|---|
| `~/.pi/agent/feishu-pi-bridge.pid` | daemon PID 锁 |
| `~/.pi/agent/feishu-pi-bridge.log` | 全量日志（10MB 自动轮转） |
| `~/.pi/agent/feishu-pi-bridge.sock` | status 查询 IPC |
| `~/.pi/agent/sessions/feishu-*.jsonl` | Pi 自动持久化的会话历史 |

## 关键行为

- **卡片流式回复**：消息进来先发一张蓝色「Pi 思考中」占位卡片，Pi 处理完后用
  patch 接口把同一张卡片编辑成绿色「Pi 回复」（支持 markdown 渲染）；
  错误/超时变红色卡片
- **群聊多人**：每条消息前缀 `[来自 <sender>]:`，Pi 能区分发言人
- **RPC idle 清理**：30 分钟无消息的 RPC 进程自动 kill，下次消息重建
- **prompt 超时**：单条消息处理 30 秒无响应则杀进程、回复"处理超时"
- **进程 crash**：RPC 子进程意外退出时从池移除，下次消息自动重建
- **日志轮转**：log 文件超 10MB 自动 rename 为 `.log.1`
- **发送重试**：飞书 API 调用最多重试 3 次，指数退避

## 开发

```bash
pnpm run dev             # tsc --watch
pnpm run build           # 编译到 dist/
node dist/index.js help  # 直接运行（不经全局 link）
```

源码组织（`src/`）：

| 文件 | 职责 |
|---|---|
| `config.ts` | env 加载与校验，常量 |
| `logger.ts` | 零依赖文件日志 |
| `feishu-client.ts` | Lark SDK 封装（WSClient + REST） |
| `pi-rpc-process.ts` | 单 RPC 子进程封装与协议解析 |
| `pi-rpc-pool.ts` | chat_id → RPC 进程映射，idle 清理，模型覆盖 |
| `message-handler.ts` | 消息编排：解析 → 占位卡 → prompt → patch 卡片，命令分发 |
| `feishu-card.ts` | 飞书 v1 卡片 JSON 构建（多种颜色 header + markdown 正文 + 分片） |
| `ipc.ts` | Unix Socket 状态查询 |
| `daemon.ts` | daemon 主循环、信号处理、优雅退出 |
| `daily-report.ts` | 调 Pi `/daily-report` + 拆标题 + 推 indigo 卡片 |
| `session-cleanup.ts` | 清理指定 chat 的 Pi session 文件 |
| `cli.ts` / `index.ts` | 子命令入口与分发 |

## 排查

- 启动失败先看 `~/.pi/agent/feishu-pi-bridge.log`
- `status` 显示 not running 但 pid 文件存在：手动删 pid 文件
- 飞书收不到消息：确认长连接模式已启用、机器人已拉群
- Pi 回复慢或超时：调高 `config.ts` 里的 `rpcPromptMs`
- 验证扩展复用：发 `@机器人 /review`（依赖 `claude-commands.ts`），让 Pi 切到
  tencent provider（依赖 `provider-tencent.ts`）

## YAGNI 边界（明确不做）

- 飞书富消息（图片、文件）—— 仅支持文本
- 流式输出（token-by-token）—— 等 `agent_end` 一次性回复
- 多租户 / 鉴权 / Web UI —— 个人用不需要
