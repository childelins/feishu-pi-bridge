import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const PI_AGENT_DIR = join(homedir(), '.pi/agent');

function resolveWorkdir(): string | undefined {
  const raw = process.env.FEISHU_BRIDGE_WORKDIR?.trim();
  if (!raw) return undefined;
  // 相对路径基于 bridge 进程 cwd 解析，确保 spawn 时拿到绝对路径
  const dir = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  if (!existsSync(dir)) {
    console.warn(`[feishu-pi-bridge] FEISHU_BRIDGE_WORKDIR 不存在：${raw}（解析为 ${dir}），将忽略并继承 bridge 进程 cwd`);
    return undefined;
  }
  return dir;
}

function resolveEnvPath(): string | null {
  const explicit = process.env.FEISHU_BRIDGE_ENV_FILE;
  if (explicit) return explicit;

  const cwdPath = join(process.cwd(), '.env');
  if (existsSync(cwdPath)) return cwdPath;

  try {
    const projectRoot = fileURLToPath(new URL('../', import.meta.url));
    const projectPath = join(projectRoot, '.env');
    if (existsSync(projectPath)) return projectPath;
  } catch {
    // import.meta.url unavailable — skip
  }
  return null;
}

function loadEnvFile() {
  const envPath = resolveEnvPath();
  if (!envPath) return;
  const content = readFileSync(envPath, 'utf-8');
  const noOverride = process.env.FEISHU_BRIDGE_NO_ENV_OVERRIDE === '1';
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (noOverride && key in process.env) continue;
    process.env[key] = value;
  }
}

loadEnvFile();

function required(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`[feishu-pi-bridge] Missing required env var: ${key}`);
    console.error('Set it in .env or via system env, then retry.');
    process.exit(1);
  }
  return v;
}

export function assertFeishuConfig(): void {
  required('FEISHU_APP_ID');
  required('FEISHU_APP_SECRET');
}

export function sanitizeChatId(chatId: string): string {
  return chatId.replace(/[^A-Za-z0-9_-]/g, '_');
}

export function sessionIdFor(chatId: string): string {
  return `feishu-${sanitizeChatId(chatId)}`;
}

function parseModelMap(raw: string | undefined): Record<number, string> {
  const out: Record<number, string> = {};
  if (!raw) return out;
  for (const part of raw.split(',')) {
    const item = part.trim();
    if (!item) continue;
    const eq = item.indexOf('=');
    if (eq === -1) {
      console.warn(`[feishu-pi-bridge] FEISHU_MODEL_MAP: skip invalid item "${item}" (expected n=modelId)`);
      continue;
    }
    const n = Number(item.slice(0, eq).trim());
    const id = item.slice(eq + 1).trim();
    if (!Number.isInteger(n) || n < 1) {
      console.warn(`[feishu-pi-bridge] FEISHU_MODEL_MAP: skip invalid index "${item}" (n must be integer >= 1; 0 is reserved for default)`);
      continue;
    }
    if (!id) {
      console.warn(`[feishu-pi-bridge] FEISHU_MODEL_MAP: skip empty model id for index ${n}`);
      continue;
    }
    out[n] = id;
  }
  return out;
}

function parseRpcPromptMs(): number {
  const raw = process.env.FEISHU_BRIDGE_RPC_TIMEOUT_MS?.trim();
  if (!raw) return 300_000; // 默认 5 分钟
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1_000) {
    console.warn(
      `[feishu-pi-bridge] FEISHU_BRIDGE_RPC_TIMEOUT_MS 无效：${raw}（须为 >= 1000 的毫秒数），将回退默认 300000ms`,
    );
    return 300_000;
  }
  return Math.round(n);
}

export type ModelArgResult =
  | { kind: 'default' }
  | { kind: 'model'; model: string }
  | { kind: 'error'; message: string };

/**
 * 解析 /model 与 daily-report --model 的参数，保证两者语义一致。
 *  - "0"/"reset"/"default" → 用默认 PI_MODEL
 *  - 纯数字 → 按 modelMap 查表，无效编号返回 error
 *  - 其它字符串 → 原样作为 model（含 "/" 时由 resolveModel 走 provider/id 解析）
 */
export function resolveModelArg(
  arg: string,
  modelMap: Record<number, string>,
): ModelArgResult {
  if (arg === 'reset' || arg === 'default' || arg === '0') {
    return { kind: 'default' };
  }
  if (/^\d+$/.test(arg)) {
    const n = Number(arg);
    const modelId = modelMap[n];
    if (!modelId) {
      const nums = Object.keys(modelMap).map(Number).sort((a, b) => a - b);
      const hint = nums.length > 0
        ? `可用编号：0(默认),${nums.join(',')}`
        : '未配置 FEISHU_MODEL_MAP（请在 .env 设置，如 "1=glm-5.2,2=deepseek-v4-flash-202605"）';
      return { kind: 'error', message: `无效编号 ${n}。${hint}` };
    }
    return { kind: 'model', model: modelId };
  }
  return { kind: 'model', model: arg };
}

export const config = {
  feishu: {
    appId: process.env.FEISHU_APP_ID ?? '',
    appSecret: process.env.FEISHU_APP_SECRET ?? '',
  },
  pi: {
    provider: process.env.PI_PROVIDER ?? '',
    model: process.env.PI_MODEL ?? '',
    modelMap: parseModelMap(process.env.FEISHU_MODEL_MAP),
  },
  paths: {
    agentDir: PI_AGENT_DIR,
    workdir: resolveWorkdir(),
    pidFile: join(PI_AGENT_DIR, 'feishu-pi-bridge.pid'),
    logFile: join(PI_AGENT_DIR, 'feishu-pi-bridge.log'),
    sockFile: join(PI_AGENT_DIR, 'feishu-pi-bridge.sock'),
    sessionsDir: join(PI_AGENT_DIR, 'sessions'),
  },
  timeouts: {
    rpcPromptMs: parseRpcPromptMs(),
    rpcKillGraceMs: 5_000,
  },
  reply: {
    ackText: 'Pi 思考中…',
    timeoutText: '处理超时，请稍后重试',
    crashText: '处理失败，请稍后重试',
    emptyText: '（Pi 未返回内容）',
    thinkingTitle: 'Pi 思考中',
    replyTitle: 'Pi 回复',
    systemTitle: '系统',
    timeoutTitle: '处理超时',
    crashTitle: '处理失败',
  },
  idle: {
    sweepIntervalMs: 5 * 60_000,
    rpcIdleThresholdMs: 30 * 60_000,
  },
  retry: {
    replyMaxAttempts: 3,
    replyBaseDelayMs: 1_000,
  },
  log: {
    rotateAtBytes: 10 * 1024 * 1024,
  },
  ws: {
    maxReconnectFailures: 5,
  },
  dailyReport: {
    chatId: process.env.FEISHU_DAILY_REPORT_CHAT_ID ?? '',
    botChatId: 'daily-report-bot',
    promptTimeoutMs: 600_000,
  },
} as const;

export type Config = typeof config;
