import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { FirecrawlAdapter } from "../../firecrawl/adapter.js";

export function createFetchCduSiteContentTool(adapter: FirecrawlAdapter) {
  return new DynamicStructuredTool({
    name: "fetch_cdu_site_content",
    description: "获取成都大学指定二级站点的首页摘要、重要链接和正文摘要。",
    schema: z.object({
      siteName: z.string().min(1).describe("站点名称，例如 信息网络中心。")
    }),
    func: async ({ siteName }) => {
      const result = await adapter.getSiteContent(siteName);
      return JSON.stringify(result);
    }
  });
}
