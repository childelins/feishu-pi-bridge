import * as Lark from '@larksuiteoapi/node-sdk'
import { config } from './config.js'
import { logger } from './logger.js'
import { buildCard, type CardOpts } from './feishu-card.js'

export interface IncomingMessage {
  chatId: string
  senderName?: string
  senderId?: string
  text: string
  raw: unknown
}

export type MessageHandler = (msg: IncomingMessage) => void | Promise<void>

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export class FeishuClient {
  private readonly client: Lark.Client
  private readonly ws: Lark.WSClient
  private readonly startedAt = Date.now()
  private consecutiveWsFailures = 0

  constructor() {
    const base = {
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
    }
    this.client = new Lark.Client(base)
    this.ws = new Lark.WSClient({
      ...base,
      loggerLevel: Lark.LoggerLevel.warn,
    })
  }

  get startedAtMs(): number {
    return this.startedAt
  }

  async replyText(chatId: string, text: string): Promise<void> {
    await this.sendWithRetry(() =>
      this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ text }),
          msg_type: 'text',
        },
      }),
    )
  }

  async replyCard(chatId: string, opts: CardOpts): Promise<{ messageId: string }> {
    const res = await this.sendWithRetry(() =>
      this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: buildCard(opts),
        },
      }),
    )
    const r = res as { message_id?: string; data?: { message_id?: string } }
    const messageId = r?.message_id ?? r?.data?.message_id
    if (!messageId) {
      throw new Error('replyCard: missing message_id in response')
    }
    return { messageId }
  }

  async patchCard(messageId: string, opts: CardOpts): Promise<void> {
    await this.sendWithRetry(() =>
      this.client.im.v1.message.patch({
        data: { content: buildCard(opts) },
        path: { message_id: messageId },
      }),
    )
  }

  private async sendWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown = null
    for (let attempt = 1; attempt <= config.retry.replyMaxAttempts; attempt++) {
      try {
        return await fn()
      } catch (err) {
        lastErr = err
        if (attempt < config.retry.replyMaxAttempts) {
          const delay = config.retry.replyBaseDelayMs * 2 ** (attempt - 1)
          await sleep(delay)
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`send failed: ${String(lastErr)}`)
  }

  startEventLoop(handler: MessageHandler): void {
    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        try {
          const msg = this.parseIncoming(data)
          if (msg) await handler(msg)
        } catch (err) {
          logger.error(`event handler error: ${err instanceof Error ? err.message : String(err)}`)
        }
      },
    })

    try {
      this.ws.start({ eventDispatcher: dispatcher })
      logger.info('ws start invoked')
      this.consecutiveWsFailures = 0
    } catch (err) {
      this.consecutiveWsFailures += 1
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`ws start failed (${this.consecutiveWsFailures}): ${msg}`)
      if (this.consecutiveWsFailures >= config.ws.maxReconnectFailures) {
        logger.error(`ws max reconnect failures reached, exiting`)
        process.exit(1)
      }
    }
  }
  private parseIncoming(data: unknown): IncomingMessage | null {
    const d = data as {
      message?: { chat_id?: string; content?: string; message_type?: string }
      sender?: { sender_id?: { open_id?: string }; name?: string }
    }
    const message = d.message
    if (!message?.chat_id || !message.content) return null
    if (message.message_type !== 'text') return null

    let text: string
    try {
      const content = JSON.parse(message.content) as { text?: string }
      text = content.text ?? ''
    } catch {
      return null
    }

    return {
      chatId: message.chat_id,
      senderId: d.sender?.sender_id?.open_id,
      senderName: d.sender?.name,
      text: text.trim(),
      raw: data,
    }
  }
}
