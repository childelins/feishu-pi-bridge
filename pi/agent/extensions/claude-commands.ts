/**
 * Claude-style /clear and /exit commands.
 *
 * - /clear   Clears the conversation and starts a fresh session.
 *            The previous session is still saved on disk and can be resumed
 *            with /resume or revisited via /tree.
 * - /exit    Exits pi gracefully (equivalent to the built-in /quit).
 *
 * Mirrors the behavior of claude-code's /clear and /exit. Auto-discovered from
 * ~/.pi/agent/extensions/; reload after edits with /reload.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function claudeCommands(pi: ExtensionAPI) {
	// /clear — start a fresh session, clearing the visible conversation context.
	pi.registerCommand("clear", {
		description: "Clear conversation and start a fresh session",
		handler: async (_args, ctx) => {
			// Capture plain data before any session replacement; the old session
			// objects become stale once a new session is created.
			const previousSessionFile = ctx.sessionManager.getSessionFile();

			// Nothing to do if the current branch has no messages yet.
			const hasConversation = ctx
				.sessionManager.getBranch()
				.some((entry) => entry.type === "message");
			if (!hasConversation) {
				if (ctx.hasUI) ctx.ui.notify("Conversation is already empty.", "info");
				return;
			}

			const result = await ctx.newSession({
				// Record the parent so the cleared session stays linked/resumable.
				parentSession: previousSessionFile,
				// Use only the replacement-session ctx here; the old ctx is stale
				// after a successful replacement.
				withSession: async (replacementCtx) => {
					if (!replacementCtx.hasUI) return;
					const note = previousSessionFile
						? `Cleared. Previous session saved: ${previousSessionFile}`
						: "Cleared.";
					replacementCtx.ui.notify(note, "info");
				},
			});

			// The old ctx is only safe to touch when no replacement happened.
			if (result.cancelled && ctx.hasUI) {
				ctx.ui.notify("Clear cancelled.", "info");
			}
		},
	});

	// /exit — quit pi gracefully (claude-code style). Alias of the built-in /quit.
	pi.registerCommand("exit", {
		description: "Exit pi",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});
}
