import { config, allocateChatWorkdir } from './config.js';
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
  /**
   * chatId → 该会话实例的实际 workdir（绝对路径）。
   * 每次新分配一个带时间戳的子目录，/new 后清空对应项，使下次 getOrCreate 重新分配。
   * 若未配置 FEISHU_BRIDGE_WORKDIR（base 为空），则不分配，spawn 继承进程 cwd。
   */
  private workdirs = new Map<string, string>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly workdirBase: string | undefined;

  constructor(workdirBase?: string) {
    this.workdirBase = workdirBase;
  }

  /**
   * 显式指定某 chatId 的 workdir（如日报按天目录）。优先于自动分配。
   * 在 getOrCreate 之前调用；后续同一 chatId 复用此目录。
   */
  setChatWorkdir(chatId: string, dir: string): void {
    this.workdirs.set(chatId, dir);
  }

  /**
   * 清掉某 chatId 的 workdir 映射，使下次 getOrCreate 重新分配新目录。
   * /new 时调用，配合 deleteSessionFiles 实现真正的会话隔离。
   */
  clearWorkdir(chatId: string): void {
    this.workdirs.delete(chatId);
  }

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
    const workdir = this.resolveWorkdirFor(chatId);
    const proc = new PiRpcProcess({
      chatId,
      provider: model.provider,
      model: model.model,
      workdir,
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

  /**
   * 计算 chatId 的 workdir：
   *  - base 未配置 → 返回 undefined（spawn 继承 bridge 进程 cwd，旧行为）
   *  - 已有显式映射（setChatWorkdir）或自动分配的实例目录 → 复用
   *  - 否则在 base 下分配新带时间戳子目录并 mkdir
   */
  private resolveWorkdirFor(chatId: string): string | undefined {
    if (!this.workdirBase) return undefined;
    const cached = this.workdirs.get(chatId);
    if (cached) return cached;
    const dir = allocateChatWorkdir(this.workdirBase, chatId);
    this.workdirs.set(chatId, dir);
    logger.info(`workdir allocated chat=${chatId} dir=${dir}`);
    return dir;
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
