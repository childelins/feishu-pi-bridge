export type CardTemplate = 'green' | 'red' | 'grey' | 'blue' | 'turquoise' | 'yellow' | 'orange' | 'purple' | 'indigo' | 'violet';

export interface CardOpts {
  title: string;
  template?: CardTemplate;
  markdown?: string;
}

export const CARD_CONTENT_LIMIT = 28_000;

export function truncateMarkdown(md: string, limit: number = CARD_CONTENT_LIMIT): string {
  if (md.length <= limit) return md;
  const trimmed = limit - 30;
  if (trimmed <= 0) return md.slice(0, limit);
  return md.slice(0, trimmed) + `\n\n…（已截断 ${md.length - trimmed} 字）`;
}

/**
 * 把超长 markdown 切成若干 ≤ limit 的块，用于分卡续发——避免单张卡超过飞书上限被
 * truncateMarkdown 硬切而丢失尾部内容。
 *
 * 切分优先级（尽量沿语义边界，不在行中间断）：
 *   1. 按 `# `/`## ` 章节标题切段，贪心打包：正常情况下每块由若干完整章节组成；
 *   2. 单个章节本身超 limit 时，对该章节按行边界二次切片；
 *   3. 整段没有任何章节标题时，整体按行边界切片；
 *   4. 单行仍超 limit（极少见，如超长代码块/URL）才走 truncateMarkdown 硬切兜底。
 *
 * 契约：恒返回 ≥ 1 个块；除单行硬切兜底外，每块 length ≤ limit。
 */
export function chunkMarkdown(md: string, limit: number = CARD_CONTENT_LIMIT): string[] {
  if (md.length <= limit) return [md];

  // 按章节标题（# / ##）切段，标题行保留在所属段落开头
  const sections = md.split(/(?=^#{1,2}\s)/m);
  const chunks: string[] = [];
  let cur = '';

  const flush = (): void => {
    const trimmed = cur.trimEnd();
    if (trimmed) chunks.push(trimmed);
    cur = '';
  };

  for (const section of sections) {
    if (!section) continue;
    const candidate = cur ? `${cur}\n\n${section}` : section;
    if (candidate.length <= limit) {
      cur = candidate;
    } else if (section.length <= limit) {
      // 当前块装不下这一节，但该节单独能装下 → 封箱开新块
      flush();
      cur = section;
    } else {
      // 单节就超 limit → 按行边界二次切片
      flush();
      for (const piece of chunkByLines(section, limit)) chunks.push(piece);
    }
  }
  flush();

  return chunks.length ? chunks : [md];
}

/** 按行边界把一段超长文本切成若干 ≤ limit 的块；单行超限才硬切。 */
function chunkByLines(text: string, limit: number): string[] {
  const lines = text.split('\n');
  const chunks: string[] = [];
  let cur = '';

  for (const line of lines) {
    const candidate = cur ? `${cur}\n${line}` : line;
    if (candidate.length <= limit) {
      cur = candidate;
    } else {
      if (cur) {
        chunks.push(cur);
        cur = '';
      }
      if (line.length <= limit) {
        cur = line;
      } else {
        // 单行超 limit（超长代码块/URL）→ 硬切兜底，末尾标注已截断字数
        chunks.push(truncateMarkdown(line, limit));
      }
    }
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [text];
}

interface CardHeader {
  title: { tag: 'plain_text'; content: string };
  template: CardTemplate;
}

interface CardElement {
  tag: 'markdown';
  content: string;
}

interface CardSchema {
  config: { update_multi: true };
  header: CardHeader;
  elements: CardElement[];
}

export function buildCard(opts: CardOpts): string {
  const template: CardTemplate = opts.template ?? 'green';
  const content = opts.markdown ?? '';
  const card: CardSchema = {
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: opts.title },
      template,
    },
    elements: [{ tag: 'markdown', content }],
  };
  return JSON.stringify(card);
}
