import { config } from './config.js';
import { logger } from './logger.js';
import { PiRpcProcess } from './pi-rpc-process.js';

export interface PoolSnapshot {
  chatId: string;
  pid?: number;
  lastActiveAt: number;
}

export class PiRpcPool {
  private procs = new Map<string, PiRpcProcess>();
  private lastActive = new Map<string, number>();
  private sweepTimer: NodeJS.Timeout | null = null;

  getOrCreate(chatId: string): PiRpcProcess {
    const existing = this.procs.get(chatId);
    if (existing) {
      this.lastActive.set(chatId, Date.now());
      return existing;
    }
    const proc = new PiRpcProcess({
      chatId,
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

  async remove(chatId: string): Promise<void> {
    const proc = this.procs.get(chatId);
    if (!proc) return;
    this.procs.delete(chatId);
    this.lastActive.delete(chatId);
    await proc.kill();
  }

  snapshot(): PoolSnapshot[] {
    const now = Date.now();
    return [...this.procs.entries()].map(([chatId, proc]) => ({
      chatId,
      pid: proc.pid,
      lastActiveAt: this.lastActive.get(chatId) ?? now,
    }));
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
