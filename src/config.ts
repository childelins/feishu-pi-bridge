import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PI_AGENT_DIR = join(homedir(), '.pi/agent');

function loadEnvFile() {
  const envPath = process.env.FEISHU_BRIDGE_ENV_FILE
    ?? join(process.cwd(), '.env');
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, 'utf-8');
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
    if (!(key in process.env)) {
      process.env[key] = value;
    }
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

export const config = {
  feishu: {
    appId: process.env.FEISHU_APP_ID ?? '',
    appSecret: process.env.FEISHU_APP_SECRET ?? '',
  },
  paths: {
    agentDir: PI_AGENT_DIR,
    pidFile: join(PI_AGENT_DIR, 'feishu-pi-bridge.pid'),
    logFile: join(PI_AGENT_DIR, 'feishu-pi-bridge.log'),
    sockFile: join(PI_AGENT_DIR, 'feishu-pi-bridge.sock'),
    sessionsDir: join(PI_AGENT_DIR, 'sessions'),
  },
  timeouts: {
    rpcPromptMs: 30_000,
    rpcKillGraceMs: 5_000,
  },
  reply: {
    ackText: '收到，正在处理…',
    timeoutText: '处理超时，请稍后重试',
    crashText: '处理失败，请稍后重试',
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
} as const;

export type Config = typeof config;
