import { readdir, stat, unlink } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import { config, sanitizeChatId } from './config.js';

/**
 * 删除指定 chat 对应的 pi session 文件，使下次 spawn pi 时以全新 session 启动。
 *
 * pi 把对话历史持久化到 sessions/<cwd-encoded>/<timestamp>_feishu-<chatId>.jsonl，
 * bridge 用固定 session-id（feishu-<sanitized chatId>）复用 session，长期累积会污染
 * 上下文（如定时日报会被旧日报历史带偏）。本函数扫描所有 session 子目录，删除该
 * chatId 的全部 jsonl。与飞书 /new 命令共用同一逻辑。
 *
 * @returns 已删除文件的绝对路径列表
 */
export async function deleteSessionFiles(chatId: string): Promise<string[]> {
  const sanitized = sanitizeChatId(chatId);
  const suffix = `_feishu-${sanitized}.jsonl`;
  const sessionsDir = config.paths.sessionsDir;
  const deleted: string[] = [];

  let subs: string[];
  try {
    subs = await readdir(sessionsDir);
  } catch {
    return deleted;
  }

  for (const sub of subs) {
    const subPath = join(sessionsDir, sub);
    let st: Stats;
    try {
      st = await stat(subPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    let files: string[];
    try {
      files = await readdir(subPath);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(suffix)) continue;
      const fp = join(subPath, file);
      try {
        await unlink(fp);
        deleted.push(fp);
      } catch {
        // ignore individual unlink errors
      }
    }
  }
  return deleted;
}
