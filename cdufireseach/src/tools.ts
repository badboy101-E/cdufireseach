import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FirecrawlAdapter } from "./firecrawl/adapter.js";

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
  adapter: FirecrawlAdapter
): void {
  server.registerTool(
    "get_cdu_site_catalog",
    {
      title: "成都大学二级网站目录",
      description: "抓取并返回成都大学组织机构与院系设置下的二级网站目录。",
      inputSchema: {}
    },
    async () => jsonContent(await adapter.getSiteCatalog())
  );

  server.registerTool(
    "find_cdu_site",
    {
      title: "查找成都大学二级网站",
      description: "根据机构或院系名称关键字，定位对应二级网站。",
      inputSchema: {
        keyword: z.string().min(1).describe("机构或院系名称关键字，例如 信息网络中心。")
      }
    },
    async ({ keyword }) => jsonContent(await adapter.findSite(keyword))
  );

  server.registerTool(
    "get_cdu_site_content",
    {
      title: "获取成都大学站点内容",
      description: "根据机构或院系名称抓取对应二级网站首页内容摘要和重要链接。",
      inputSchema: {
        siteName: z.string().min(1).describe("机构或院系名称，例如 信息网络中心。")
      }
    },
    async ({ siteName }) => jsonContent(await adapter.getSiteContent(siteName))
  );

  server.registerTool(
    "ask_cdu_site",
    {
      title: "成都大学站点问答",
      description: "根据问题定位对应二级网站，并基于站点内容回答问题。",
      inputSchema: {
        question: z.string().min(1).describe("要询问的问题，例如 信息网络中心在哪？"),
        siteName: z
          .string()
          .min(1)
          .optional()
          .describe("可选。已知站点名称时传入，例如 信息网络中心。")
      }
    },
    async ({ question, siteName }) => jsonContent(await adapter.askSite(question, siteName))
  );

  server.registerTool(
    "get_org_structure",
    {
      title: "成都大学组织机构",
      description: "获取成都大学组织机构页的结构化结果。",
      inputSchema: {}
    },
    async () => jsonContent(await adapter.getOrgStructure())
  );

  server.registerTool(
    "get_departments",
    {
      title: "成都大学院系列表",
      description: "获取成都大学院系设置和二级网站入口。",
      inputSchema: {}
    },
    async () => jsonContent(await adapter.getDepartments())
  );

  server.registerTool(
    "find_department_site",
    {
      title: "查询院系二级网站",
      description: "根据院系名称关键字查找成都大学院系站点。",
      inputSchema: {
        keyword: z.string().min(1).describe("院系名称关键字，例如 计算机学院。")
      }
    },
    async ({ keyword }) => jsonContent(await adapter.findDepartmentSite(keyword))
  );

  server.registerTool(
    "get_department_profile",
    {
      title: "获取院系简介",
      description: "获取指定院系官网首页的摘要与重要链接。",
      inputSchema: {
        departmentName: z.string().min(1).describe("院系全称，例如 机械工程学院。")
      }
    },
    async ({ departmentName }) =>
      jsonContent(await adapter.getDepartmentProfile(departmentName))
  );
}
