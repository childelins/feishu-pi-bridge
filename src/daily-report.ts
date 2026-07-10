import { config, allocateDailyWorkdir } from './config.js';
import { logger } from './logger.js';
import type { FeishuClient } from './feishu-client.js';
import type { PiRpcPool } from './pi-rpc-pool.js';
import { chunkMarkdown, type CardTemplate } from './feishu-card.js';
import { deleteSessionFiles } from './session-cleanup.js';

const REPORT_TEMPLATE = '/daily-report';
const FALLBACK_TITLE_DATE_OFFSET_MS = 0;
const CARD_TEMPLATE: CardTemplate = 'indigo';

function dateLabel(): string {
  return new Date(Date.now() + FALLBACK_TITLE_DATE_OFFSET_MS).toISOString().slice(0, 10);
}

function fallbackTitle(): string {
  const hour = new Date().getHours();
  const period = hour < 12 ? '早间' : '晚间';
  return `🚀 AI × 科技日报 · ${dateLabel()} ${period}`;
}

function splitTitleAndBody(markdown: string): { title: string; body: string } {
  const lines = markdown.split('\n');
  const titleIdx = lines.findIndex((l) => l.startsWith('# '));
  if (titleIdx < 0) {
    return { title: fallbackTitle(), body: markdown.replace(/^\s+/, '') };
  }
  const title = lines[titleIdx].slice(2).trim().slice(0, 50) || fallbackTitle();
  const body = lines.slice(titleIdx + 1).join('\n').replace(/^\s+/, '');
  return { title, body: body || markdown };
}

export interface PushDailyReportOptions {
  feishu: FeishuClient;
  pool: PiRpcPool;
  chatIdOverride?: string;
  /** 为 true 时在生成前清理 bot 的 session 历史，确保全新会话（默认 false，沿用历史）。 */
  freshSession?: boolean;
}

export async function pushDailyReport(opts: PushDailyReportOptions): Promise<void> {
  const chatId = opts.chatIdOverride ?? config.dailyReport.chatId;
  if (!chatId) {
    throw new Error('FEISHU_DAILY_REPORT_CHAT_ID not set (required for daily-report)');
  }

  const botChatId = config.dailyReport.botChatId;

  // 按本地日期分配日报专属 workdir（daily-report-YYYYMMDD）：同一天复用同一目录，
  // 跨天自然新建。无 base（FEISHU_BRIDGE_WORKDIR 未配）时不分配，沿用进程 cwd。
  const base = config.paths.workdir;
  if (base) {
    const dailyDir = allocateDailyWorkdir(base);
    opts.pool.setChatWorkdir(botChatId, dailyDir);
    logger.info(`daily-report workdir botChat=${botChatId} dir=${dailyDir}`);
  }

  if (opts.freshSession) {
    await opts.pool.remove(botChatId).catch(() => undefined);
    const deleted = await deleteSessionFiles(botChatId);
    logger.info(`daily-report fresh session botChat=${botChatId} deleted=${deleted.length}`);
  }

  const proc = opts.pool.getOrCreate(botChatId);
  logger.info(`daily-report begin botChat=${botChatId} timeout=${config.dailyReport.promptTimeoutMs}ms`);

  let markdown: string | null;
  try {
    markdown = await proc.prompt(REPORT_TEMPLATE, config.dailyReport.promptTimeoutMs);
  } finally {
    await opts.pool.remove(botChatId).catch(() => undefined);
  }

  if (!markdown || !markdown.trim()) {
    throw new Error('Pi returned empty daily-report');
  }

  const { title, body } = splitTitleAndBody(markdown);
  const chunks = chunkMarkdown(body);
  for (let i = 0; i < chunks.length; i++) {
    const cardTitle = i === 0 ? title : `${title} (续 ${i + 1}/${chunks.length})`;
    await opts.feishu.replyCard(chatId, {
      title: cardTitle,
      template: CARD_TEMPLATE,
      markdown: chunks[i],
    });
  }
  logger.info(
    `daily-report pushed chat=${chatId} title=${title} chunks=${chunks.length} bytes=${chunks
      .map((c) => c.length)
      .join('/')}`,
  );
}
