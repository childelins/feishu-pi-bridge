import { config } from './config.js';
import { logger } from './logger.js';
import type { FeishuClient, IncomingMessage } from './feishu-client.js';
import type { PiRpcPool } from './pi-rpc-pool.js';

function truncate(s: string, n = 80): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > n ? oneLine.slice(0, n) + '...' : oneLine;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface MessageHandlerOptions {
  feishu: FeishuClient;
  pool: PiRpcPool;
}

export class MessageHandler {
  private readonly feishu: FeishuClient;
  private readonly pool: PiRpcPool;
  private readonly inFlight = new Set<string>();

  constructor(opts: MessageHandlerOptions) {
    this.feishu = opts.feishu;
    this.pool = opts.pool;
  }

  async handle(msg: IncomingMessage): Promise<void> {
    const { chatId, text } = msg;
    if (!text) return;

    if (this.inFlight.has(chatId)) {
      logger.debug(`dedup chat=${chatId}, in-flight`);
      return;
    }
    this.inFlight.add(chatId);

    const sender = msg.senderName ?? msg.senderId ?? 'unknown';
    logger.info(`message chat=${chatId} sender=${sender} text=${truncate(text)}`);

    try {
      await this.feishu.replyText(chatId, config.reply.ackText);
    } catch (err) {
      logger.warn(`ack failed chat=${chatId}: ${errMsg(err)}`);
    }

    try {
      const proc = this.pool.getOrCreate(chatId);
      const prefixed = `[来自 ${sender}]: ${text}`;
      const reply = await proc.prompt(prefixed);
      this.pool.touch(chatId);
      if (reply) {
        await this.feishu.replyText(chatId, reply);
        logger.info(`reply chat=${chatId} text=${truncate(reply)}`);
      } else {
        logger.warn(`reply chat=${chatId} empty assistant text`);
      }
    } catch (err) {
      const m = errMsg(err);
      logger.warn(`handle failed chat=${chatId}: ${m}`);
      const isTimeout = m.includes('timeout');
      try {
        await this.feishu.replyText(
          chatId,
          isTimeout ? config.reply.timeoutText : config.reply.crashText,
        );
      } catch (err2) {
        logger.error(`error-reply failed chat=${chatId}: ${errMsg(err2)}`);
      }
      if (isTimeout || m.includes('exited') || m.includes('killed')) {
        await this.pool.remove(chatId);
      }
    } finally {
      this.inFlight.delete(chatId);
    }
  }
}
