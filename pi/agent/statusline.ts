import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { basename } from "node:path";

type FooterDataLike = {
  getGitBranch(): string | null;
  onBranchChange(listener: () => void): () => void;
};

const C_GRAY = "\x1b[38;5;245m";
const C_GREEN = "\x1b[38;5;70m";
const C_YELLOW = "\x1b[38;5;178m";
const C_RED = "\x1b[38;5;167m";
const C_ACCENT = "\x1b[38;5;74m";
const C_RESET = "\x1b[0m";

const SEPARATOR = `${C_GRAY} | ${C_RESET}`;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function renderLine1(ctx: ExtensionContext, footerData: FooterDataLike): string {
  const now = new Date();
  const hour = now.getHours();
  const timeIcon = hour >= 6 && hour < 18 ? "🐥" : "🦉";
  const hhmm = `${pad2(hour)}:${pad2(now.getMinutes())}`;

  const model = ctx.model?.name || ctx.model?.id || "?";
  const dir = basename(ctx.cwd) || ctx.cwd;
  const branch = footerData.getGitBranch();

  const usage = ctx.getContextUsage();
  const percent = usage?.percent ?? null;
  const maxCtx = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const maxK = maxCtx > 0 ? `${Math.round(maxCtx / 1000)}k` : "?";
  const usedK = percent != null && maxCtx > 0
    ? `${Math.round(maxCtx * percent / 100 / 1000)}k`
    : "?";
  const pctLabel = percent == null ? "?" : `${Math.round(percent)}%`;

  const ctxColor = percent == null
    ? C_GRAY
    : percent <= 30 ? C_GREEN
    : percent <= 60 ? C_YELLOW
    : C_RED;
  const battery = percent != null && percent > 60 ? "🪫" : "🔋";

  const parts: string[] = [
    `${C_ACCENT}${timeIcon} ${hhmm}${C_RESET}`,
    `${C_ACCENT}🍭 ${model}${C_RESET}`,
    `${C_ACCENT}🎯 ${dir}${C_RESET}`,
  ];
  if (branch) parts.push(`${C_ACCENT}🌿 ${branch}${C_RESET}`);
  parts.push(`${ctxColor}${battery} ${usedK}/${maxK} tokens (${pctLabel})${C_RESET}`);

  return parts.join(SEPARATOR);
}

function renderStatusline(width: number, input: { ctx: ExtensionContext; footerData: FooterDataLike }): string[] {
  return [truncateToWidth(renderLine1(input.ctx, input.footerData), width)];
}

export default function (pi: ExtensionAPI) {
  let requestFooterRender: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const installFooter = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;

    ctx.ui.setFooter((tui, _theme, footerData) => {
      requestFooterRender = () => tui.requestRender();
      const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());
      timer = setInterval(() => requestFooterRender?.(), 30_000);

      return {
        dispose() {
          unsubscribeBranch();
          if (timer) {
            clearInterval(timer);
            timer = undefined;
          }
          requestFooterRender = undefined;
        },
        invalidate() {},
        render(width: number): string[] {
          return renderStatusline(width, { ctx, footerData });
        },
      };
    });
  };

  pi.on("session_start", (_event, ctx) => {
    installFooter(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    requestFooterRender = undefined;
    if (ctx.hasUI) ctx.ui.setFooter(undefined);
  });
}
