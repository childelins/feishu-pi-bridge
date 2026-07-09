import { config } from './config.js';
import { logger } from './logger.js';
import { PiRpcProcess } from './pi-rpc-process.js';

export interface PoolSnapshot {
  chatId: string;
  pid?: number;
  lastActiveAt: number;
  provider?: string;
  model?: string;
}

export interface ModelOverride {
  provider?: string;
  model?: string;
}

export class PiRpcPool {
  private procs = new Map<string, PiRpcProcess>();
  private lastActive = new Map<string, number>();
  private overrides = new Map<string, ModelOverride>();
  private sweepTimer: NodeJS.Timeout | null = null;

  private resolveModel(chatId: string): ModelOverride {
    const override = this.overrides.get(chatId);
    const model = override?.model ?? (config.pi.model || undefined);
    // If model is "provider/id" form, let Pi parse provider from model — skip --provider to avoid conflict.
    const provider = model && model.includes('/')
      ? undefined
      : (override?.provider ?? (config.pi.provider || undefined));
    return { provider, model };
  }

  getOrCreate(chatId: string): PiRpcProcess {
    const existing = this.procs.get(chatId);
    if (existing) {
      this.lastActive.set(chatId, Date.now());
      return existing;
    }
    const model = this.resolveModel(chatId);
    const proc = new PiRpcProcess({
      chatId,
      provider: model.provider,
      model: model.model,
      onExit: () => {
        if (this.procs.get(chatId) === proc) {
          this.procs.delete(chatId);
          this.lastActive.delete(chatId);
        }
      },
    });
    this.procs.set(chatId, proc);
    this.lastActive.set(chatId, Date.now());
    return proc;
  }

  touch(chatId: string): void {
    this.lastActive.set(chatId, Date.now());
  }

  setOverride(chatId: string, override: ModelOverride): void {
    this.overrides.set(chatId, override);
  }

  clearOverride(chatId: string): boolean {
    return this.overrides.delete(chatId);
  }

  getOverride(chatId: string): ModelOverride | undefined {
    const o = this.overrides.get(chatId);
    return o ? { ...o } : undefined;
  }

  async remove(chatId: string): Promise<void> {
    const proc = this.procs.get(chatId);
    if (!proc) return;
    this.procs.delete(chatId);
    this.lastActive.delete(chatId);
    await proc.kill();
  }

  snapshot(): PoolSnapshot[] {
    const now = Date.now();
    return [...this.procs.entries()].map(([chatId, proc]) => {
      const o = this.resolveModel(chatId);
      return {
        chatId,
        pid: proc.pid,
        lastActiveAt: this.lastActive.get(chatId) ?? now,
        provider: o.provider,
        model: o.model,
      };
    });
  }

  async closeAll(): Promise<void> {
    const entries = [...this.procs.values()];
    this.procs.clear();
    this.lastActive.clear();
    await Promise.allSettled(entries.map((p) => p.kill()));
  }

  startSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.sweep();
    }, config.idle.sweepIntervalMs);
  }

  stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    const threshold = config.idle.rpcIdleThresholdMs;
    const idleChats: string[] = [];
    for (const [chatId, ts] of this.lastActive) {
      if (now - ts > threshold) idleChats.push(chatId);
    }
    for (const chatId of idleChats) {
      const mins = Math.round((now - (this.lastActive.get(chatId) ?? now)) / 60_000);
      logger.info(`idle cleanup chat=${chatId} idle=${mins}m`);
      await this.remove(chatId);
    }
  }
}
