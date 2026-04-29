import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import type { FirecrawlAdapter } from "../../firecrawl/adapter.js";
import type { SiteAnswerResult } from "../../types.js";
import type { ArkChatClient } from "../../llm/arkChatClient.js";
import type { MemoryMatchResult } from "../../memory/markdownMemory.js";
import { createFetchCduSiteContentTool } from "../tools/fetchCduSiteContentTool.js";
import { createGetCatalogContextTool } from "../tools/getCatalogContextTool.js";
import { createGetMemoryCandidatesTool } from "../tools/getMemoryCandidatesTool.js";
import { createResolveCduSiteTool } from "../tools/resolveCduSiteTool.js";
import { createRunAskCduTool } from "../tools/runAskCduTool.js";

const CduQaGraphState = Annotation.Root({
  question: Annotation<string>(),
  siteName: Annotation<string | undefined>(),
  resolvedSiteName: Annotation<string | undefined>(),
  resolvedSiteUrl: Annotation<string | undefined>(),
  siteSummary: Annotation<string | undefined>(),
  memoryCandidates: Annotation<MemoryMatchResult[]>({
    reducer: (_current, update) => update,
    default: () => []
  }),
  skipMemory: Annotation<boolean>({
    reducer: (_current, update) => update,
    default: () => false
  }),
  workflowSteps: Annotation<string[]>({
    reducer: (current, update) => current.concat(update),
    default: () => []
  }),
  finalResult: Annotation<SiteAnswerResult | undefined>()
});

type LlmResolvedSite = {
  resolvedSiteName?: string;
  resolvedSiteUrl?: string;
  reasoning?: string;
};

type LlmRefinedAnswer = {
  answered?: boolean;
  answer?: string;
  evidence?: string;
  analysis_note?: string;
};

type MemoryDecision = {
  decision?: "direct_answer" | "use_memory_but_refine" | "need_live_crawl";
  selectedEntryTitle?: string;
  answer?: string;
  evidence?: string;
  reason?: string;
};

function summarizeCatalogSites(raw: string, limit: number): string {
  const parsed = JSON.parse(raw) as {
    sites?: Array<{ name?: string; category?: string; website_url?: string }>;
  };

  return (parsed.sites ?? [])
    .slice(0, limit)
    .map((site) => {
      const name = site.name?.trim();
      const category = site.category?.trim();
      const url = site.website_url?.trim();
      return [name, category, url].filter(Boolean).join(" | ");
    })
    .filter(Boolean)
    .join("\n");
}

async function resolveSiteWithLlm(params: {
  llmClient: ArkChatClient;
  question: string;
  candidateSitesRaw: string;
  catalogContextRaw: string;
}): Promise<LlmResolvedSite> {
  return params.llmClient.completeJson<LlmResolvedSite>([
    {
      role: "system",
      content: [
        "你是成都大学站点解析助手。",
        "你的任务是根据用户问题，从候选站点中选出最可能需要查询的成都大学二级站点。",
        "优先理解别名、字序变化、括号中的正式名称，例如“网络信息中心”≈“信息网络中心”。",
        "如果没有足够依据，返回空字符串，不要猜测。",
        "只返回 JSON：{\"resolvedSiteName\":\"...\",\"resolvedSiteUrl\":\"...\",\"reasoning\":\"...\"}"
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `用户问题：${params.question}`,
        "",
        "候选站点列表（优先参考）：",
        params.candidateSitesRaw,
        "",
        "目录上下文（仅作补充）：",
        summarizeCatalogSites(params.catalogContextRaw, 50)
      ].join("\n")
    }
  ]);
}

async function refineAnswerWithLlm(params: {
  llmClient: ArkChatClient;
  question: string;
  resolvedSiteName?: string;
  resolvedSiteUrl?: string;
  siteSummary?: string;
  baseResult: SiteAnswerResult;
}): Promise<LlmRefinedAnswer> {
  return params.llmClient.completeJson<LlmRefinedAnswer>([
    {
      role: "system",
      content: [
        "你是成都大学问答结果整理助手。",
        "你只能基于提供的结构化结果和证据重写答案，不能补充外部事实。",
        "如果问题是在问位置/电话/邮箱，要尽量保留与问题最直接相关的字段，删掉无关噪音。",
        "如果当前结果已经明确说没有找到，就保持这个结论，不要编造。",
        "如果当前结果 answered=false 但证据或答案中已经包含可直接回答问题的内容，可以返回 answered=true。",
        "只返回 JSON：{\"answered\":true,\"answer\":\"...\",\"evidence\":\"...\",\"analysis_note\":\"...\"}"
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `用户问题：${params.question}`,
        `已解析站点：${params.resolvedSiteName ?? ""}`,
        `站点地址：${params.resolvedSiteUrl ?? ""}`,
        `站点首页摘要：${params.siteSummary ?? ""}`,
        "当前结构化结果：",
        JSON.stringify(params.baseResult, null, 2)
      ].join("\n")
    }
  ]);
}

async function decideMemoryWithLlm(params: {
  llmClient: ArkChatClient;
  question: string;
  resolvedSiteName?: string;
  resolvedSiteUrl?: string;
  candidates: MemoryMatchResult[];
}): Promise<MemoryDecision> {
  return params.llmClient.completeJson<MemoryDecision>([
    {
      role: "system",
      content: [
        "你是成都大学长期记忆命中决策助手。",
        "你的任务是根据用户问题、已解析站点和长期记忆候选条目，判断是否可以直接使用长期记忆回答。",
        "如果候选条目与当前问题对象或粒度不一致，必须返回 need_live_crawl。",
        "如果候选条目足以直接回答当前问题，返回 direct_answer 或 use_memory_but_refine。",
        "不能编造，只能基于候选条目中的 answer/evidence/sourceUrls 做判断。",
        "只返回 JSON：{\"decision\":\"direct_answer|use_memory_but_refine|need_live_crawl\",\"selectedEntryTitle\":\"...\",\"answer\":\"...\",\"evidence\":\"...\",\"reason\":\"...\"}"
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `用户问题：${params.question}`,
        `已解析站点：${params.resolvedSiteName ?? ""}`,
        `站点地址：${params.resolvedSiteUrl ?? ""}`,
        "长期记忆候选：",
        JSON.stringify(params.candidates, null, 2)
      ].join("\n")
    }
  ]);
}

function buildMemoryDirectResult(params: {
  question: string;
  candidate: MemoryMatchResult;
  overrideAnswer?: string;
  overrideEvidence?: string;
}): SiteAnswerResult {
  return {
    question: params.question,
    answered: true,
    answer: params.overrideAnswer?.trim() || params.candidate.answer,
    evidence: params.overrideEvidence?.trim() || params.candidate.evidence,
    analysis_steps: [
      `收到问题：${params.question}`,
      `长期记忆库匹配策略：${params.candidate.strategy}（意图：${params.candidate.intent}，条目：${params.candidate.entryTitle}）`,
      "命中长期记忆库，未触发实时抓取。"
    ],
    matched_site: null,
    source_urls: params.candidate.sourceUrls,
    fetched_at: new Date().toISOString()
  };
}

export async function runCduQaGraph(
  adapter: FirecrawlAdapter,
  input: { question: string; siteName?: string },
  llmClient?: ArkChatClient
): Promise<SiteAnswerResult> {
  const resolveTool = createResolveCduSiteTool(adapter);
  const catalogTool = createGetCatalogContextTool(adapter);
  const fetchTool = createFetchCduSiteContentTool(adapter);
  const memoryTool = createGetMemoryCandidatesTool(adapter);
  const askTool = createRunAskCduTool(adapter);

  const graph = new StateGraph(CduQaGraphState)
    .addNode("resolveSite", async (state) => {
      if (state.siteName?.trim()) {
        return {
          resolvedSiteName: state.siteName.trim(),
          workflowSteps: [`LangGraph: 直接使用外部传入站点 ${state.siteName.trim()}`]
        };
      }

      const candidateRaw = await resolveTool.invoke({ keyword: state.question });
      const parsed = JSON.parse(candidateRaw) as {
        matches?: Array<{ name?: string; website_url?: string }>;
      };
      const catalogRaw = await catalogTool.invoke({});

      if (llmClient) {
        try {
          const llmResolved = await resolveSiteWithLlm({
            llmClient,
            question: state.question,
            candidateSitesRaw: candidateRaw,
            catalogContextRaw: catalogRaw
          });

          if (llmResolved.resolvedSiteName?.trim()) {
            return {
              resolvedSiteName: llmResolved.resolvedSiteName.trim(),
              resolvedSiteUrl: llmResolved.resolvedSiteUrl?.trim(),
              workflowSteps: [
                `LangGraph: 已通过 LLM 解析候选站点 ${llmResolved.resolvedSiteName.trim()}${
                  llmResolved.reasoning ? `（${llmResolved.reasoning.trim()}）` : ""
                }`
              ]
            };
          }
        } catch (error) {
          return {
            resolvedSiteName: parsed.matches?.[0]?.name,
            resolvedSiteUrl: parsed.matches?.[0]?.website_url,
            workflowSteps: [
              `LangGraph: LLM 站点解析失败，回退到规则候选${
                error instanceof Error ? `（${error.message}）` : ""
              }`
            ]
          };
        }
      }

      const first = parsed.matches?.[0];
      return {
        resolvedSiteName: first?.name,
        resolvedSiteUrl: first?.website_url,
        workflowSteps: first?.name
          ? [`LangGraph: 已解析候选站点 ${first.name}`]
          : ["LangGraph: 未能从目录上下文中预解析出明确站点，后续交由主流程判断"]
      };
    })
    .addNode("fetchSiteContext", async (state) => {
      if (!state.resolvedSiteName) {
        return {
          workflowSteps: ["LangGraph: 跳过站点上下文抓取，因为当前没有可用站点名"]
        };
      }

      const raw = await fetchTool.invoke({ siteName: state.resolvedSiteName });
      const parsed = JSON.parse(raw) as {
        summary?: string;
        title?: string;
      };

      return {
        siteSummary: parsed.summary,
        workflowSteps: [
          `LangGraph: 已抓取站点首页上下文${parsed.title ? `（${parsed.title}）` : ""}`
        ]
      };
    })
    .addNode("decideMemory", async (state) => {
      if (!llmClient) {
        return {
          skipMemory: false,
          workflowSteps: ["LangGraph: 未启用 LLM memory 决策，沿用原有长期记忆逻辑"]
        };
      }

      const raw = await memoryTool.invoke({
        question: state.question,
        siteName: state.resolvedSiteName ?? state.siteName
      });
      const candidates = JSON.parse(raw) as MemoryMatchResult[];

      if (candidates.length === 0) {
        return {
          memoryCandidates: [],
          skipMemory: true,
          workflowSteps: ["LangGraph: 未召回可用长期记忆候选，继续实时抓取"]
        };
      }

      try {
        const decision = await decideMemoryWithLlm({
          llmClient,
          question: state.question,
          resolvedSiteName: state.resolvedSiteName ?? state.siteName,
          resolvedSiteUrl: state.resolvedSiteUrl,
          candidates
        });

        const selected = candidates.find(
          (candidate) => candidate.entryTitle === decision.selectedEntryTitle
        );

        if (
          selected &&
          (decision.decision === "direct_answer" ||
            decision.decision === "use_memory_but_refine")
        ) {
          return {
            memoryCandidates: candidates,
            skipMemory: true,
            finalResult: buildMemoryDirectResult({
              question: state.question,
              candidate: selected,
              overrideAnswer: decision.answer,
              overrideEvidence: decision.evidence
            }),
            workflowSteps: [
              `LangGraph: 已通过 LLM 决定直接使用长期记忆${
                decision.reason ? `（${decision.reason.trim()}）` : ""
              }`
            ]
          };
        }

        return {
          memoryCandidates: candidates,
          skipMemory: true,
          workflowSteps: [
            `LangGraph: 已通过 LLM 决定继续实时抓取${
              decision.reason ? `（${decision.reason.trim()}）` : ""
            }`
          ]
        };
      } catch (error) {
        return {
          memoryCandidates: candidates,
          skipMemory: true,
          workflowSteps: [
            `LangGraph: LLM memory 决策失败，继续实时抓取${
              error instanceof Error ? `（${error.message}）` : ""
            }`
          ]
        };
      }
    })
    .addNode("answerQuestion", async (state) => {
      if (state.finalResult) {
        return {
          finalResult: state.finalResult,
          workflowSteps: ["LangGraph: 已直接采用长期记忆答案，跳过实时抓取"]
        };
      }

      const raw = await askTool.invoke({
        question: state.question,
        siteName: state.resolvedSiteName ?? state.siteName,
        skipMemory: state.skipMemory
      });
      const baseResult = JSON.parse(raw) as SiteAnswerResult;

      if (llmClient) {
        try {
          const refined = await refineAnswerWithLlm({
            llmClient,
            question: state.question,
            resolvedSiteName: state.resolvedSiteName ?? state.siteName,
            resolvedSiteUrl: state.resolvedSiteUrl,
            siteSummary: state.siteSummary,
            baseResult
          });

          return {
            finalResult: {
              ...baseResult,
              answered:
                typeof refined.answered === "boolean"
                  ? refined.answered
                  : baseResult.answered,
              answer: refined.answer?.trim() || baseResult.answer,
              evidence: refined.evidence?.trim() || baseResult.evidence
            },
            workflowSteps: [
              `LangGraph: 已通过 LLM 整理最终答案${
                refined.analysis_note ? `（${refined.analysis_note.trim()}）` : ""
              }`
            ]
          };
        } catch (error) {
          return {
            finalResult: baseResult,
            workflowSteps: [
              `LangGraph: LLM 最终答案整理失败，回退到结构化结果${
                error instanceof Error ? `（${error.message}）` : ""
              }`
            ]
          };
        }
      }

      return {
        finalResult: baseResult,
        workflowSteps: ["LangGraph: 已执行问答主流程并生成最终结果"]
      };
    })
    .addEdge(START, "resolveSite")
    .addEdge("resolveSite", "fetchSiteContext")
    .addEdge("fetchSiteContext", "decideMemory")
    .addEdge("decideMemory", "answerQuestion")
    .addEdge("answerQuestion", END);

  const app = graph.compile();
  const result = await app.invoke({
    question: input.question,
    siteName: input.siteName
  });

  if (!result.finalResult) {
    throw new Error("LangGraph workflow returned no final result");
  }

  return {
    ...result.finalResult,
    analysis_steps: [
      ...(result.workflowSteps ?? []),
      ...result.finalResult.analysis_steps
    ]
  };
}
