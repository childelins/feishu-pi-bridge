import { spawn, type ChildProcess } from 'node:child_process';
import { config } from './config.js';
import { logger } from './logger.js';

export interface PiRpcProcessOptions {
  chatId: string;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

interface PendingPrompt {
  resolve: (text: string | null) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

function sanitizeChatId(chatId: string): string {
  return chatId.replace(/[^A-Za-z0-9_-]/g, '_');
}

function extractAssistantText(messages: unknown[]): string {
  return (messages as Array<{ role?: string; content?: unknown }>)
    .filter((m) => m?.role === 'assistant')
    .map((m) => {
      const content = m.content;
      if (Array.isArray(content)) {
        return content
          .filter((c): c is { type: string; text?: string } => c?.type === 'text')
          .map((c) => c.text ?? '')
          .join('\n');
      }
      return typeof content === 'string' ? content : '';
    })
    .join('\n\n');
}

export class PiRpcProcess {
  private readonly proc: ChildProcess;
  private readonly chatId: string;
  private readonly onExitCb?: PiRpcProcessOptions['onExit'];
  private promptId = 1;
  private pending = new Map<number, PendingPrompt>();
  private buffer = '';
  private killed = false;

  constructor(opts: PiRpcProcessOptions) {
    this.chatId = opts.chatId;
    this.onExitCb = opts.onExit;

    const sessionId = `feishu-${sanitizeChatId(opts.chatId)}`;
    this.proc = spawn('pi', [
      '--mode', 'rpc',
      '--session-id', sessionId,
    ], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env },
    });

    logger.info(`rpc spawn chat=${opts.chatId} pid=${this.proc.pid ?? 'n/a'} session=${sessionId}`);

    this.proc.stdout?.setEncoding('utf-8');
    this.proc.stdout?.on('data', (chunk: string) => this.onStdoutData(chunk));
    this.proc.on('exit', (code, signal) => this.onProcExit(code, signal));
    this.proc.on('error', (err) => {
      logger.error(`rpc spawn error chat=${opts.chatId}: ${err.message}`);
    });
  }

  get pid(): number | undefined {
    return this.proc.pid;
  }

  prompt(message: string, timeoutMs: number = config.timeouts.rpcPromptMs): Promise<string | null> {
    if (this.killed) {
      return Promise.reject(new Error('rpc process already killed'));
    }
    const stdin = this.proc.stdin;
    if (!stdin || stdin.destroyed) {
      return Promise.reject(new Error('rpc stdin closed'));
    }

    return new Promise<string | null>((resolve, reject) => {
      const id = this.promptId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`prompt timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      const payload = JSON.stringify({ id, type: 'prompt', message }) + '\n';
      stdin.write(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new Error(`stdin write failed: ${err.message}`));
        }
      });
    });
  }

  async kill(): Promise<void> {
    if (this.killed) return;
    this.killed = true;

    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('rpc process killed'));
    }
    this.pending.clear();

    const pid = this.proc.pid;
    if (!pid) return;

    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };

      this.proc.once('exit', finish);
      const grace = config.timeouts.rpcKillGraceMs;
      const force = setTimeout(() => {
        if (!done && this.proc.pid) {
          try { this.proc.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }, grace);

      try {
        this.proc.kill('SIGTERM');
      } catch {
        clearTimeout(force);
        finish();
      }
    });
  }

  private onStdoutData(chunk: string) {
    this.buffer += chunk;
    while (true) {
      const nl = this.buffer.indexOf('\n');
      if (nl === -1) break;
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line) this.handleLine(line);
    }
  }

  private handleLine(line: string) {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      logger.debug(`rpc stdout non-json chat=${this.chatId}: ${line.slice(0, 200)}`);
      return;
    }

    const ev = obj as { type?: string; id?: number; messages?: unknown[] };
    if (ev.type === 'agent_end') {
      const entry = this.pending.entries().next().value as [number, PendingPrompt] | undefined;
      if (entry) {
        const [id, p] = entry;
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.resolve(extractAssistantText(ev.messages ?? []));
      } else {
        logger.warn(`rpc agent_end with no pending prompt chat=${this.chatId}`);
      }
      return;
    }

    if (ev.type === 'response' && ev.id != null && this.pending.has(ev.id)) {
      logger.debug(`rpc response id=${ev.id} chat=${this.chatId}`);
    }
  }

  private onProcExit(code: number | null, signal: NodeJS.Signals | null) {
    logger.info(`rpc exit chat=${this.chatId} code=${code} signal=${signal}`);
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`rpc process exited code=${code} signal=${signal}`));
    }
    this.pending.clear();
    this.onExitCb?.(code, signal);
  }
}
