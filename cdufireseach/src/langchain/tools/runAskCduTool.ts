import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { FirecrawlAdapter } from "../../firecrawl/adapter.js";

export function createRunAskCduTool(adapter: FirecrawlAdapter) {
  return new DynamicStructuredTool({
    name: "run_ask_cdu",
    description:
      "执行成都大学问答主流程。当前为过渡性工具，内部仍会复用现有 ask_cdu 逻辑。",
    schema: z.object({
      question: z.string().min(1).describe("用户问题。"),
      siteName: z.string().min(1).optional().describe("可选的已解析站点名称。"),
      skipMemory: z.boolean().optional().describe("是否跳过长期记忆，直接走实时抓取。")
    }),
    func: async ({ question, siteName, skipMemory }) => {
      const result = await adapter.askSite(question, siteName, { skipMemory });
      return JSON.stringify(result);
    }
  });
}
