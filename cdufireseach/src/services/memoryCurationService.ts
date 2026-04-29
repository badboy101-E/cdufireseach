import type { CatalogSite, SiteAnswerResult } from "../types.js";
import { ArkChatClient } from "../llm/arkChatClient.js";
import {
  MarkdownMemoryStore,
  type MemoryEntryDraft,
  type MemoryConfidence,
  type QuestionIntent
} from "../memory/markdownMemory.js";

type MemoryCurationResult = {
  target: "formal" | "candidate";
  confidence: MemoryConfidence;
  title: string;
};

type MemoryCurationServiceOptions = {
  formalFilePath: string;
  candidateFilePath: string;
  enabled?: boolean;
};

type MemoryDraftResponse = {
  should_write?: boolean;
  confidence?: MemoryConfidence;
  title?: string;
  sectionTitle?: string;
  standardQuestions?: string[];
  aliases?: string[];
  keywords?: string[];
  answers?: {
    location?: string;
    phone?: string;
    email?: string;
    generic?: string;
  };
  sourcePage?: string;
  sourceSite?: string;
  sourceExcerpt?: string;
  reason?: string;
};

function detectQuestionIntent(question: string): QuestionIntent {
  if (/(邮箱|电子邮箱|email|邮件)/i.test(question)) {
    return "email";
  }
  if (/(电话|联系电话|联系方式|号码)/.test(question)) {
    return "phone";
  }
  if (/(在哪|哪里|位置|地址|办公地点|办公地址|办公位置)/.test(question)) {
    return "location";
  }
  return "generic";
}

function isMemoryHit(result: SiteAnswerResult): boolean {
  return result.analysis_steps.some((step) => step.includes("命中长期记忆库"));
}

function isSpecificIntent(intent: QuestionIntent): boolean {
  return intent === "location" || intent === "phone" || intent === "email";
}

function inferSectionTitle(matchedSite: CatalogSite | null): string {
  if (!matchedSite) {
    return "自动沉淀";
  }
  return matchedSite.source_kind === "organization" ? "组织机构" : "院系设置";
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export class MemoryCurationService {
  private readonly enabled: boolean;
  private readonly formalStore: MarkdownMemoryStore;
  private readonly candidateStore: MarkdownMemoryStore;

  constructor(
    private readonly llmClient: ArkChatClient,
    options: MemoryCurationServiceOptions
  ) {
    this.enabled = options.enabled ?? true;
    this.formalStore = new MarkdownMemoryStore({
      filePath: options.formalFilePath,
      documentTitle: "cdufireseach 长期记忆库",
      usageNotes: [
        "本文件用于维护高频、稳定、人工核验或高置信度自动核验过的问答条目。",
        "当前优先覆盖：办公地点、电话、邮箱。",
        "高置信度且字段明确的条目可由系统自动写入。"
      ],
      defaultSectionTitle: "自动沉淀"
    });
    this.candidateStore = new MarkdownMemoryStore({
      filePath: options.candidateFilePath,
      documentTitle: "cdufireseach 候选记忆库",
      usageNotes: [
        "本文件用于保存 LLM 根据实时抓取结果生成的候选记忆条目。",
        "中低置信度或字段不够稳定的条目会先写入这里，待人工审核后再进入正式记忆库。",
        "当前优先覆盖：办公地点、电话、邮箱。"
      ],
      defaultSectionTitle: "待审核候选条目"
    });
  }

  async maybePersist(question: string, result: SiteAnswerResult): Promise<MemoryCurationResult | null> {
    if (!this.enabled || isMemoryHit(result) || !result.answered) {
      return null;
    }

    const intent = detectQuestionIntent(question);
    if (!isSpecificIntent(intent) || result.source_urls.length === 0) {
      return null;
    }

    const draft = await this.llmClient.completeJson<MemoryDraftResponse>([
      {
        role: "system",
        content: [
          "你是成都大学长期记忆沉淀助手。",
          "你的任务是根据实时抓取后的结构化问答结果，判断该结果是否适合沉淀为长期记忆条目。",
          "只处理办公地点、电话、邮箱这三类稳定字段。",
          "高置信度标准：来源明确、字段明确、答案与证据一致、适合重复复用。",
          "中低置信度：答案可能不够稳定、页面是泛化信息、字段边界不够清楚、或需要人工复核。",
          "你必须只基于提供的 question/result 生成，不得编造。",
          "只返回 JSON：{\"should_write\":true,\"confidence\":\"high|medium|low\",\"title\":\"...\",\"sectionTitle\":\"...\",\"standardQuestions\":[...],\"aliases\":[...],\"keywords\":[...],\"answers\":{\"location\":\"...\",\"phone\":\"...\",\"email\":\"...\"},\"sourcePage\":\"...\",\"sourceSite\":\"...\",\"sourceExcerpt\":\"...\",\"reason\":\"...\"}"
        ].join("\n")
      },
      {
        role: "user",
        content: [
          `问题：${question}`,
          `意图：${intent}`,
          `匹配站点：${result.matched_site?.name ?? ""}`,
          `匹配站点网址：${result.matched_site?.website_url ?? ""}`,
          "结构化问答结果：",
          JSON.stringify(result, null, 2)
        ].join("\n")
      }
    ]);

    if (!draft.should_write || !draft.title?.trim()) {
      return null;
    }

    const draftEntry: MemoryEntryDraft = {
      sectionTitle: draft.sectionTitle?.trim() || inferSectionTitle(result.matched_site),
      title: draft.title.trim(),
      standardQuestions: draft.standardQuestions?.length
        ? draft.standardQuestions
        : [question.trim()],
      aliases: draft.aliases ?? [],
      keywords: draft.keywords ?? [],
      answers: {
        location: draft.answers?.location,
        phone: draft.answers?.phone,
        email: draft.answers?.email
      },
      sourcePage: draft.sourcePage?.trim() || result.source_urls[0],
      sourceSite: draft.sourceSite?.trim() || result.matched_site?.website_url,
      sourceExcerpt: draft.sourceExcerpt?.trim() || result.evidence,
      lastVerifiedAt: todayIsoDate(),
      confidence: draft.confidence ?? "medium"
    };

    if (draftEntry.confidence === "high") {
      draftEntry.writeMode = "auto_verified";
      await this.formalStore.upsertEntry(draftEntry);
      return {
        target: "formal",
        confidence: "high",
        title: draftEntry.title
      };
    }

    const candidateConfidence: MemoryConfidence =
      draftEntry.confidence === "low" ? "low" : "medium";
    draftEntry.writeMode = "candidate_review";
    await this.candidateStore.upsertEntry(draftEntry);
    return {
      target: "candidate",
      confidence: candidateConfidence,
      title: draftEntry.title
    };
  }
}
