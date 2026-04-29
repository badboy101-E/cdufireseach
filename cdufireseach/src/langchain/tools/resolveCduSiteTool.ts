import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { FirecrawlAdapter } from "../../firecrawl/adapter.js";

export function createResolveCduSiteTool(adapter: FirecrawlAdapter) {
  return new DynamicStructuredTool({
    name: "resolve_cdu_site",
    description:
      "根据用户问题或关键词定位成都大学相关二级站点，返回最可能的候选站点列表。",
    schema: z.object({
      keyword: z.string().min(1).describe("用户问题或站点关键词。")
    }),
    func: async ({ keyword }) => {
      const result = await adapter.findSite(keyword);
      return JSON.stringify(result);
    }
  });
}
