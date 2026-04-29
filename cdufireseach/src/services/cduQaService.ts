import type { FirecrawlAdapter } from "../firecrawl/adapter.js";
import type { SiteAnswerResult } from "../types.js";
import { runCduQaGraph } from "../langchain/workflows/cduQaGraph.js";
import type { ArkChatClient } from "../llm/arkChatClient.js";
import type { MemoryCurationService } from "./memoryCurationService.js";

export class CduQaService {
  constructor(
    private readonly adapter: FirecrawlAdapter,
    private readonly llmClient?: ArkChatClient,
    private readonly memoryCurationService?: MemoryCurationService
  ) {}

  async ask(question: string, siteName?: string): Promise<SiteAnswerResult> {
    const result = await runCduQaGraph(this.adapter, {
      question,
      siteName
    }, this.llmClient);

    if (!this.memoryCurationService) {
      return result;
    }

    try {
      const persisted = await this.memoryCurationService.maybePersist(question, result);
      if (!persisted) {
        return result;
      }

      return {
        ...result,
        analysis_steps: [
          ...result.analysis_steps,
          persisted.target === "formal"
            ? `长期记忆沉淀：已自动写入正式记忆（置信度：${persisted.confidence}，条目：${persisted.title}）`
            : `长期记忆沉淀：已写入候选记忆待审核（置信度：${persisted.confidence}，条目：${persisted.title}）`
        ]
      };
    } catch (error) {
      return {
        ...result,
        analysis_steps: [
          ...result.analysis_steps,
          `长期记忆沉淀：写入失败${
            error instanceof Error ? `（${error.message}）` : ""
          }`
        ]
      };
    }
  }
}
