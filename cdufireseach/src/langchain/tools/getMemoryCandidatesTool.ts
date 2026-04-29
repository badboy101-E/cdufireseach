import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { FirecrawlAdapter } from "../../firecrawl/adapter.js";

export function createGetMemoryCandidatesTool(adapter: FirecrawlAdapter) {
  return new DynamicStructuredTool({
    name: "get_memory_candidates",
    description: "根据用户问题和可选站点名称，获取长期记忆候选条目。",
    schema: z.object({
      question: z.string().min(1).describe("用户问题。"),
      siteName: z.string().min(1).optional().describe("可选的已解析站点名称。")
    }),
    func: async ({ question, siteName }) => {
      const result = await adapter.getMemoryCandidates(question, siteName);
      return JSON.stringify(result);
    }
  });
}
