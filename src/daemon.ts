import { writeFileSync, unlinkSync } from 'node:fs';
import { config, assertFeishuConfig } from './config.js';
import { logger } from './logger.js';
import { FeishuClient } from './feishu-client.js';
import { PiRpcPool } from './pi-rpc-pool.js';
import { MessageHandler } from './message-handler.js';
import { IpcServer } from './ipc.js';

interface Components {
  ipc: IpcServer;
  pool: PiRpcPool;
}

let shuttingDown = false;

async function shutdown(reason: string, exitCode: number, comps: Components): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`shutdown begin: ${reason}`);
  comps.pool.stopSweep();
  try {
    await comps.ipc.stop();
  } catch (err) {
    logger.warn(`ipc stop error: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    await comps.pool.closeAll();
  } catch (err) {
    logger.warn(`pool closeAll error: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    unlinkSync(config.paths.pidFile);
  } catch {
    // pid file already gone
  }
  logger.info(`shutdown complete: ${reason}`);
  process.exit(exitCode);
}

export async function runDaemon(): Promise<void> {
  assertFeishuConfig();
  logger.info(`daemon starting pid=${process.pid}`);

  try {
    writeFileSync(config.paths.pidFile, String(process.pid));
  } catch (err) {
    logger.error(`cannot write pid file ${config.paths.pidFile}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const feishu = new FeishuClient();
  const pool = new PiRpcPool();
  const handler = new MessageHandler({ feishu, pool });
  const ipc = new IpcServer({
    pid: process.pid,
    startedAt: feishu.startedAtMs,
    getSnapshot: () => pool.snapshot(),
  });

  try {
    await ipc.start();
  } catch (err) {
    logger.error(`ipc start failed: ${err instanceof Error ? err.message : String(err)}`);
    try {
      unlinkSync(config.paths.pidFile);
    } catch {
      // ignore
    }
    process.exit(1);
  }

  pool.startSweep();
  feishu.startEventLoop((msg) => {
    void handler.handle(msg);
  });

  const onSignal = (sig: NodeJS.Signals) => {
    void shutdown(sig, 0, { ipc, pool });
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  process.on('uncaughtException', (err) => {
    logger.error(`uncaughtException: ${err.stack ?? err.message}`);
    void shutdown('uncaughtException', 1, { ipc, pool });
  });

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    logger.error(`unhandledRejection: ${msg}`);
  });

  logger.info('daemon ready');
}
