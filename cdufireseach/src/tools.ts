import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CduQaService } from "./services/cduQaService.js";

function jsonContent<T extends Record<string, unknown>>(payload: T) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2)
      }
    ],
    structuredContent: payload
  };
}

export function registerTools(
  server: McpServer,
  qaService: CduQaService
): void {
  server.registerTool(
    "ask_cdu",
    {
      title: "成都大学问答",
      description: "根据用户问题自动定位成都大学相关二级网站，递归抓取页面并返回答案、依据和分析步骤。",
      inputSchema: {
        question: z.string().min(1).describe("要询问的问题，例如 信息网络中心在哪？"),
        siteName: z
          .string()
          .min(1)
          .optional()
          .describe("可选调试参数。已知站点名称时可传入，例如 信息网络中心。正常 Agent 流程通常不需要。")
      }
    },
    async ({ question, siteName }) => jsonContent(await qaService.ask(question, siteName))
  );
}
