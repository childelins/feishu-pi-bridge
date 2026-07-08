import * as Lark from '@larksuiteoapi/node-sdk';
import { config } from './config.js';
import { logger } from './logger.js';

export interface IncomingMessage {
  chatId: string;
  senderName?: string;
  senderId?: string;
  text: string;
  raw: unknown;
}

export type MessageHandler = (msg: IncomingMessage) => void | Promise<void>;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class FeishuClient {
  private readonly client: Lark.Client;
  private readonly ws: Lark.WSClient;
  private readonly startedAt = Date.now();
  private consecutiveWsFailures = 0;

  constructor() {
    const base = {
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
    };
    this.client = new Lark.Client(base);
    this.ws = new Lark.WSClient({
      ...base,
      loggerLevel: Lark.LoggerLevel.warn,
    });
  }

  get startedAtMs(): number {
    return this.startedAt;
  }

  async replyText(chatId: string, text: string): Promise<void> {
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= config.retry.replyMaxAttempts; attempt++) {
      try {
        await this.client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            content: JSON.stringify({ text }),
            msg_type: 'text',
          },
        });
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < config.retry.replyMaxAttempts) {
          const delay = config.retry.replyBaseDelayMs * 2 ** (attempt - 1);
          await sleep(delay);
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`replyText failed: ${String(lastErr)}`);
  }

  startEventLoop(handler: MessageHandler): void {
    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        try {
          const msg = this.parseIncoming(data);
          if (msg) await handler(msg);
        } catch (err) {
          logger.error(`event handler error: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    });

    try {
      this.ws.start({ eventDispatcher: dispatcher });
      logger.info('ws start invoked');
      this.consecutiveWsFailures = 0;
    } catch (err) {
      this.consecutiveWsFailures += 1;
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`ws start failed (${this.consecutiveWsFailures}): ${msg}`);
      if (this.consecutiveWsFailures >= config.ws.maxReconnectFailures) {
        logger.error(`ws max reconnect failures reached, exiting`);
        process.exit(1);
      }
    }
  }
  private parseIncoming(data: unknown): IncomingMessage | null {
    const d = data as {
      message?: { chat_id?: string; content?: string; message_type?: string };
      sender?: { sender_id?: { open_id?: string }; name?: string };
    };
    const message = d.message;
    if (!message?.chat_id || !message.content) return null;
    if (message.message_type !== 'text') return null;

    let text = '';
    try {
      const content = JSON.parse(message.content) as { text?: string };
      text = content.text ?? '';
    } catch {
      return null;
    }

    return {
      chatId: message.chat_id,
      senderId: d.sender?.sender_id?.open_id,
      senderName: d.sender?.name,
      text: text.trim(),
      raw: data,
    };
  }
}
