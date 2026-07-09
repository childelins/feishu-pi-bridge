import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("Tencent", {
    baseUrl: "https://tokenhub.tencentmaas.com/v1",
    apiKey: "$TENCENT_API_KEY",
    api: "openai-completions",
    models: [
      {
        id: "deepseek-v4-flash-202605",
        name: "DeepSeek-V4-Flash",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 384000,
        compat: { supportsStore: false, supportsDeveloperRole: false, requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" },
      },
      {
        id: "deepseek-v4-pro-202606",
        name: "DeepSeek-V4-Pro",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 384000,
        compat: { supportsStore: false, supportsDeveloperRole: false, requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" },
      },
    ],
  });
}
