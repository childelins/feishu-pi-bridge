# feishu-pi-bridge

飞书长连接 ↔ Pi Agent RPC 桥接守护进程。基于第 15 课《飞书长连接接入》扩展为
可日常使用的常驻服务，额外支持：进程启停（start/stop/restart）、状态查询
（status）、日志跟随（logs）、多 chat session 隔离、错误恢复、idle 自动清理。

## 工作原理

```
飞书长连接 (WSClient)              Pi RPC 子进程池
       │                                  │
       │  im.message.receive_v1           │
       ├─────────────► message-handler ───┤
       │                │                 │
       │                ▼                 ▼
       │  replyText  spawn pi --mode rpc --session-id feishu-<chat>
       │  "收到…"    每个 chat_id 一个常驻 RPC 进程
       │                                  │
       │  ◄──── 最终回复 ─────────────────┘
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
npm install
npm run build
npm link                  # 让 feishu-pi-bridge 全局可用
```

## 配置

在项目根目录创建 `.env`（参考 `.env.example`）：

```
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

或通过系统环境变量导出。获取方式见第 15 课。

飞书开放平台要求：
- 应用类型：企业自建应用
- 开启机器人能力
- 事件订阅选择**长连接模式**（不是请求网址）
- 添加事件 `im.message.receive_v1`
- 发布应用并拉进群

## 使用

```bash
feishu-pi-bridge start              # 启动守护进程
feishu-pi-bridge status             # 查看运行状态
feishu-pi-bridge logs -f            # 实时跟随日志
feishu-pi-bridge stop               # 停止
feishu-pi-bridge restart            # 重启
feishu-pi-bridge daily-report       # 手动触发一次日报推送
```

`start` 必须在含 `.env` 的目录下执行（或用 `FEISHU_BRIDGE_ENV_FILE` 指定路径）。

启动后在飞书群里 @机器人 发消息测试，应看到 "收到，正在处理…" 后跟 Pi 的
实际回复。

## 每日聚合日报（daily-report）

聚合 Pi 三个 skill（`aihot` / `tavily-search` / `github-trending`）输出一份
"今日 AI × 科技日报"，作为 indigo 飞书卡片推送到指定群。三种触发方式：

| 触发方式 | 说明 |
|---|---|
| 系统 crontab | `0 8,20 * * * ~/code/projects/feishu-pi-bridge/scripts/daily-report.sh >> /tmp/feishu-daily-report.log 2>&1`（见下「定时脚本」） |
| 飞书关键词 | 群里发 `日报` / `daily` / `/daily` / `daily report`，daemon 即时触发推送 |
| Pi slash command | Pi TUI 里输入 `/daily-report` 直接看 markdown（不推飞书） |

### 工作原理

`/daily-report` 是 Pi 原生 **prompt template**，定义在
`~/.pi/agent/prompts/daily-report.md`。Pi 收到 `/daily-report` 后展开成完整
prompt，由 LLM 自然调度三个 skill：

1. `aihot` ← 「看看今天的ai日报」
2. `tavily-search` ← 「看看今天的热门新闻」
3. `github-trending` ← 「看看今天的热门仓库」

整合后输出 H1 标题 + 三章节 markdown。bridge 用虚拟 chatId
`daily-report-bot` 通过 RPC 调用 Pi（不污染任何用户 session），拿到
markdown 后拆出第一行 H1 做卡片标题，正文走 indigo 模板推送。

### 配置

`.env` 增加：

```
FEISHU_DAILY_REPORT_CHAT_ID=oc_xxxxxxxxxxxxxxxx
```

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
- 单卡片超 28KB 由 `truncateMarkdown` 截断
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

- **卡片流式回复**：消息进来先发一张灰色「Pi 思考中」卡片，Pi 处理完后用 patch 接口把同一张卡片编辑成绿色「Pi 回复」（支持 markdown 渲染）；错误/超时变红色卡片
- **群聊多人**：每条消息前缀 `[来自 <sender>]:`，Pi 能区分发言人
- **RPC idle 清理**：30 分钟无消息的 RPC 进程自动 kill，下次消息重建
- **prompt 超时**：单条消息处理 30 秒无响应则杀进程、回复"处理超时"
- **进程 crash**：RPC 子进程意外退出时从池移除，下次消息自动重建
- **日志轮转**：log 文件超 10MB 自动 rename 为 `.log.1`

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

**模型持久化**：`/model` 设置的覆盖只在当前 daemon 进程生命周期内有效，daemon 重启后丢失。要长期固定，写 `.env` 里的 `PI_PROVIDER` / `PI_MODEL`。

## 配置模型

`.env` 里写：

```
PI_PROVIDER=NewAPI
PI_MODEL=glm-4.6
```

spawn 出来的 `pi --mode rpc` 会带 `--provider NewAPI --model glm-4.6`，覆盖所有 chat 的默认模型。env 留空时用 Pi settings.json 里的 `defaultProvider` / `defaultModel`。

### 编号快捷切换（可选）

`.env` 里配 `FEISHU_MODEL_MAP` 即可在飞书里用 `/model <编号>` 快速切换，避免手敲完整模型 ID：

```
FEISHU_MODEL_MAP="1=NewAPI/glm-5.2,2=Tencent/deepseek-v4-flash-202605,3=Tencent/deepseek-v4-pro-202606"
```

- 格式：逗号分隔的 `编号=模型ID`，编号必须是 ≥ 1 的整数
- `0` 保留给"恢复默认"，等价于 `/model reset`
- **跨 provider 必须用 `provider/modelId` 形式**（与 Pi 标准 `--model provider/id` 一致），否则会被自动套上 `PI_PROVIDER`，落到错误的 provider 下
- 同 provider 下的模型可省略前缀，会自动套用 `PI_PROVIDER`
- 未配置时 `/model <编号>` 会提示无映射，`/model <pattern>` 文本匹配仍可用
- 改映射只需改 `.env` 并 `feishu-pi-bridge restart`，无需重新编译

## 开发

```bash
npm run dev              # tsc --watch
npm run build            # 编译到 dist/
node dist/index.js help  # 直接运行（不经 npm link）
```

源码组织（`src/`）：

| 文件 | 职责 |
|---|---|
| `config.ts` | env 加载与校验，常量 |
| `logger.ts` | 零依赖文件日志 |
| `feishu-client.ts` | Lark SDK 封装（WSClient + REST） |
| `pi-rpc-process.ts` | 单 RPC 子进程封装与协议解析 |
| `pi-rpc-pool.ts` | chat_id → RPC 进程映射，idle 清理 |
| `message-handler.ts` | 消息编排：解析 → 占位卡 → prompt → patch 卡片 |
| `feishu-card.ts` | 飞书 v1 卡片 JSON 构建（green/red/grey header + markdown 正文） |
| `ipc.ts` | Unix Socket 状态查询 |
| `daemon.ts` | daemon 主循环、信号处理、优雅退出 |
| `daily-report.ts` | 调 Pi `/daily-report` + 拆标题 + 推 indigo 卡片 |
| `cli.ts` / `index.ts` | 子命令入口与分发 |

## 排查

- 启动失败先看 `~/.pi/agent/feishu-pi-bridge.log`
- `status` 显示 not running 但 pid 文件存在：手动删 pid 文件
- 飞书收不到消息：确认长连接模式已启用、机器人已拉群
- Pi 回复慢或超时：调高 `config.ts` 里的 `rpcPromptMs`
- 验证扩展复用：发 `@机器人 /review`（依赖 `claude-commands.ts`），让 Pi 切到 tencent provider（依赖 `provider-tencent.ts`）

## YAGNI 边界（明确不做）

- 飞书富消息（卡片、图片、文件）—— 仅支持纯文本
- 流式输出 —— 等 `agent_end` 一次性回复
- 多租户 / 鉴权 / Web UI —— 个人用不需要
