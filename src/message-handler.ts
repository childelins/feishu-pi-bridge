import { config, resolveModelArg } from './config.js';
import { logger } from './logger.js';
import type { FeishuClient, IncomingMessage } from './feishu-client.js';
import type { PiRpcPool } from './pi-rpc-pool.js';
import type { CardOpts } from './feishu-card.js';
import { truncateMarkdown } from './feishu-card.js';
import { pushDailyReport } from './daily-report.js';
import { deleteSessionFiles } from './session-cleanup.js';

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

    const lower = text.trim().toLowerCase();
    if (lower === '日报' || lower === 'daily' || lower === '/daily' || lower === 'daily report') {
      await this.handleDailyReport(msg);
      return;
    }

    if (text.startsWith('/')) {
      await this.handleCommand(msg);
      return;
    }

    if (this.inFlight.has(chatId)) {
      logger.debug(`dedup chat=${chatId}, in-flight`);
      return;
    }
    this.inFlight.add(chatId);

    const sender = msg.senderName ?? msg.senderId ?? 'unknown';
    logger.info(`message chat=${chatId} sender=${sender} text=${truncate(text)}`);

    let card: { messageId: string } | null = null;
    try {
      card = await this.feishu.replyCard(chatId, {
        title: config.reply.thinkingTitle,
        template: 'blue',
        markdown: config.reply.ackText,
      });
    } catch (err) {
      logger.warn(`placeholder card failed chat=${chatId}: ${errMsg(err)}`);
    }

    try {
      const proc = this.pool.getOrCreate(chatId);
      const prefixed = `[来自 ${sender}]: ${text}`;
      const reply = await proc.prompt(prefixed);
      this.pool.touch(chatId);
      const opts: CardOpts = reply
        ? { title: config.reply.replyTitle, template: 'green', markdown: truncateMarkdown(reply.trimStart()) }
        : { title: config.reply.replyTitle, template: 'grey', markdown: config.reply.emptyText };
      await this.finalizeReply(chatId, card, opts);
      logger.info(`reply chat=${chatId} text=${truncate(reply || config.reply.emptyText)}`);
    } catch (err) {
      const m = errMsg(err);
      logger.warn(`handle failed chat=${chatId}: ${m}`);
      const isTimeout = m.includes('timeout');
      const opts: CardOpts = {
        title: isTimeout ? config.reply.timeoutTitle : config.reply.crashTitle,
        template: 'red',
        markdown: isTimeout ? config.reply.timeoutText : config.reply.crashText,
      };
      await this.finalizeReply(chatId, card, opts);
      if (isTimeout || m.includes('exited') || m.includes('killed')) {
        await this.pool.remove(chatId);
      }
    } finally {
      this.inFlight.delete(chatId);
    }
  }

  private async handleDailyReport(msg: IncomingMessage): Promise<void> {
    const { chatId } = msg;
    const targetChat = config.dailyReport.chatId;
    const sender = msg.senderName ?? msg.senderId ?? 'unknown';
    logger.info(`daily-report request chat=${chatId} sender=${sender}`);

    if (!targetChat) {
      await this.cmdReply(chatId, '✗ 日报未配置：管理员需在 .env 设置 FEISHU_DAILY_REPORT_CHAT_ID');
      return;
    }

    await this.cmdReply(chatId, '⏳ 正在生成日报（约 1-3 分钟，Pi 串行调三个 skill）…');
    try {
      await pushDailyReport({ feishu: this.feishu, pool: this.pool, chatIdOverride: targetChat });
      if (chatId !== targetChat) {
        await this.cmdReply(chatId, `✓ 日报已推送到目标群（${targetChat}）`);
      }
    } catch (err) {
      const m = errMsg(err);
      logger.warn(`daily-report failed chat=${chatId}: ${m}`);
      await this.cmdReply(chatId, `✗ 日报生成失败：${m}`);
    }
  }

  private async finalizeReply(
    chatId: string,
    card: { messageId: string } | null,
    opts: CardOpts,
  ): Promise<void> {
    if (card) {
      try {
        await this.feishu.patchCard(card.messageId, opts);
        return;
      } catch (err) {
        logger.warn(`patch card failed chat=${chatId}, fallback to new card: ${errMsg(err)}`);
      }
    }
    try {
      await this.feishu.replyCard(chatId, opts);
    } catch (err) {
      logger.error(`final card create failed chat=${chatId}: ${errMsg(err)}`);
    }
  }

  private async cmdReply(chatId: string, markdown: string): Promise<void> {
    try {
      await this.feishu.replyCard(chatId, {
        title: config.reply.systemTitle,
        template: 'grey',
        markdown,
      });
    } catch (err) {
      logger.warn(`cmdReply failed chat=${chatId}: ${errMsg(err)}`);
    }
  }

  private async handleCommand(msg: IncomingMessage): Promise<void> {
    const { chatId, text } = msg;
    const trimmed = text.trim();
    const sender = msg.senderName ?? msg.senderId ?? 'unknown';
    logger.info(`command chat=${chatId} sender=${sender} cmd=${truncate(trimmed, 40)}`);

    if (trimmed === '/new') {
      await this.cmdNew(chatId);
      return;
    }

    if (trimmed === '/model' || trimmed.startsWith('/model ')) {
      const arg = trimmed === '/model' ? '' : trimmed.slice('/model '.length).trim();
      await this.cmdModel(chatId, arg);
      return;
    }

    if (trimmed === '/help' || trimmed === '/?') {
      await this.cmdHelp(chatId);
      return;
    }

    await this.cmdReply(
      chatId,
      `未知命令：${trimmed}\n\n可用命令：\n/new — 新开会话（删历史）\n/model — 查看模型和编号\n/model <编号|pattern|reset> — 切换模型\n/help — 显示帮助`,
    );
  }

  private async cmdNew(chatId: string): Promise<void> {
    await this.pool.remove(chatId);
    const deleted = await deleteSessionFiles(chatId);
    logger.info(`/new chat=${chatId} deleted=${deleted.length}`);
    await this.cmdReply(chatId, `✓ 已新开会话（清理 ${deleted.length} 个历史文件）`);
  }

  private async cmdModel(chatId: string, arg: string): Promise<void> {
    if (!arg) {
      const override = this.pool.getOverride(chatId);
      const current = override?.model ?? config.pi.model ?? '(Pi default)';
      const def = config.pi.model || '(Pi default)';
      const lines: string[] = [`当前模型：${current}`, `默认模型：${def}`, ''];

      const nums = Object.keys(config.pi.modelMap).map(Number).sort((a, b) => a - b);
      if (nums.length > 0) {
        const defaultProvider = config.pi.provider || 'Pi default';
        lines.push('快捷切换：');
        lines.push('/model 0 — 恢复默认');
        for (const n of nums) {
          const id = config.pi.modelMap[n];
          const display = id.includes('/') ? id : `${id} (via ${defaultProvider})`;
          const mark = override?.model === id ? ' (当前)' : '';
          lines.push(`/model ${n} — ${display}${mark}`);
        }
        lines.push('');
        lines.push('或 /model <pattern> 按字符串切换（如 glm-4.6）');
      } else {
        lines.push('用法：');
        lines.push('/model <pattern> — 切换（如 glm-4.6 / anthropic/claude-sonnet-4:high）');
        lines.push('/model reset — 恢复默认');
        lines.push('（提示：可在 .env 配 FEISHU_MODEL_MAP 启用 /model <编号> 快捷切换）');
      }
      await this.cmdReply(chatId, lines.join('\n'));
      return;
    }

    const resolved = resolveModelArg(arg, config.pi.modelMap);
    if (resolved.kind === 'default') {
      const had = this.pool.clearOverride(chatId);
      await this.pool.remove(chatId);
      logger.info(`/model reset chat=${chatId} hadOverride=${had}`);
      await this.cmdReply(chatId, `✓ 已恢复默认模型（${config.pi.model || 'Pi default'}）`);
      return;
    }

    if (resolved.kind === 'error') {
      await this.cmdReply(chatId, `✗ ${resolved.message}`);
      return;
    }
    this.pool.setOverride(chatId, { model: resolved.model });
    await this.pool.remove(chatId);
    logger.info(`/model set chat=${chatId} model=${resolved.model}`);
    await this.cmdReply(chatId, `✓ 已切换到 ${resolved.model}（下条消息生效）`);
  }

  private async cmdHelp(chatId: string): Promise<void> {
    await this.cmdReply(
      chatId,
      `飞书-Pi Bridge 命令：\n\n/new — 新开会话（删当前 chat 的历史）\n/model — 查看当前模型和可用编号\n/model <编号> — 按编号切换（0=默认，1/2/3...=映射表）\n/model <pattern> — 按字符串切换（下条消息生效）\n/model reset — 恢复默认模型\n/help — 显示本帮助\n\n其他文本正常发给 Pi 处理。`,
    );
  }
}
