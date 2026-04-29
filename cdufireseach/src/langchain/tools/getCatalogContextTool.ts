import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { FirecrawlAdapter } from "../../firecrawl/adapter.js";

export function createGetCatalogContextTool(adapter: FirecrawlAdapter) {
  return new DynamicStructuredTool({
    name: "get_cdu_catalog_context",
    description: "获取成都大学二级站点目录上下文，用于站点解析和别名理解。",
    schema: z.object({}),
    func: async () => {
      const result = await adapter.getSiteCatalog();
      return JSON.stringify(result);
    }
  });
}
