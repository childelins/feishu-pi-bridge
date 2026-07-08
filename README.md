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
```

`start` 必须在含 `.env` 的目录下执行（或用 `FEISHU_BRIDGE_ENV_FILE` 指定路径）。

启动后在飞书群里 @机器人 发消息测试，应看到 "收到，正在处理…" 后跟 Pi 的
实际回复。

## 文件布局

| 路径 | 用途 |
|---|---|
| `~/.pi/agent/feishu-pi-bridge.pid` | daemon PID 锁 |
| `~/.pi/agent/feishu-pi-bridge.log` | 全量日志（10MB 自动轮转） |
| `~/.pi/agent/feishu-pi-bridge.sock` | status 查询 IPC |
| `~/.pi/agent/sessions/feishu-*.jsonl` | Pi 自动持久化的会话历史 |

## 关键行为

- **3 秒超时**：消息进来立即回 "收到，正在处理…"，Pi 处理完后发最终回复
- **群聊多人**：每条消息前缀 `[来自 <sender>]:`，Pi 能区分发言人
- **RPC idle 清理**：30 分钟无消息的 RPC 进程自动 kill，下次消息重建
- **prompt 超时**：单条消息处理 30 秒无响应则杀进程、回复"处理超时"
- **进程 crash**：RPC 子进程意外退出时从池移除，下次消息自动重建
- **日志轮转**：log 文件超 10MB 自动 rename 为 `.log.1`

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
| `message-handler.ts` | 消息编排：解析 → ack → prompt → 回复 |
| `ipc.ts` | Unix Socket 状态查询 |
| `daemon.ts` | daemon 主循环、信号处理、优雅退出 |
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
