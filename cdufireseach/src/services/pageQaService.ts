import type {
  CatalogSite,
  LinkItem,
  SiteAnswerResult,
  SiteContentResult
} from "../types.js";

export type PageAnswerResult = {
  answered: boolean;
  answer: string;
  answerScore?: number;
  evidence: string;
  analysisStep: string;
  sourceUrl: string;
  discoveredLinks: LinkItem[];
};

type AskSiteQuestionInput = {
  question: string;
  target: CatalogSite;
  maxDiscoveryDepth: number;
  maxDiscoveryPages: number;
  getSiteContent: (siteName: string) => Promise<SiteContentResult>;
  extractQuestionFocusTerms: (question: string, matchedSiteName: string) => string[];
  selectCandidateUrls: (
    question: string,
    siteUrl: string,
    links: LinkItem[],
    focusTerms: string[]
  ) => string[];
  scoreQuestionLink: (question: string, linkName: string, url: string) => number;
  answerFromPage: (
    url: string,
    question: string,
    matchedSite: CatalogSite,
    focusTerms: string[]
  ) => Promise<PageAnswerResult>;
  nowIso: () => string;
};

type QueueItem = {
  url: string;
  depth: number;
  score: number;
};

type AnswerCandidate = PageAnswerResult & {
  checkedAt: number;
};

function questionAsksForSiteEntry(question: string): boolean {
  return /(官网|入口|网址|链接|网站|页面|查看)/.test(question);
}

function questionAsksForOfficialSite(question: string): boolean {
  return /(官网|官方网站|网址|入口|链接)/.test(question);
}

export class CduPageQaService {
  async askSiteQuestion(input: AskSiteQuestionInput): Promise<SiteAnswerResult> {
    if (questionAsksForOfficialSite(input.question)) {
      return {
        question: input.question,
        answered: true,
        answer: `${input.target.website_url}`,
        evidence: `已从成都大学二级站点目录定位到 ${input.target.name} 的官网入口。`,
        analysis_steps: [
          `收到问题：${input.question}`,
          `已定位站点：${input.target.name} (${input.target.website_url})`,
          "问题询问官网/入口/网址，因此直接返回目录中的站点地址，不再用页面正文中的页脚或图片链接抢答。"
        ],
        matched_site: input.target,
        source_urls: [input.target.website_url],
        fetched_at: input.nowIso()
      };
    }

    let home: SiteContentResult;
    try {
      home = await input.getSiteContent(input.target.name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const asksForEntry = questionAsksForSiteEntry(input.question);
      return {
        question: input.question,
        answered: asksForEntry,
        answer: asksForEntry
          ? `${input.target.name}官网入口：${input.target.website_url}`
          : `已定位到${input.target.name}官网，但抓取页面正文失败，暂时无法确认具体答案。`,
        evidence: `已从成都大学站点目录定位到 ${input.target.name} (${input.target.website_url})；页面抓取失败：${message}`,
        analysis_steps: [
          `收到问题：${input.question}`,
          `已定位站点：${input.target.name} (${input.target.website_url})`,
          "尝试抓取站点首页内容时失败，因此没有继续递归抓取。",
          asksForEntry
            ? "问题询问官网入口/页面位置，因此直接返回目录中的官网地址。"
            : "问题需要页面正文支撑，当前抓取失败，返回未能确认。"
        ],
        matched_site: input.target,
        source_urls: [input.target.website_url],
        fetched_at: input.nowIso()
      };
    }
    const focusTerms = input.extractQuestionFocusTerms(input.question, input.target.name);
    const candidateUrls = input.selectCandidateUrls(
      input.question,
      input.target.website_url,
      home.important_links,
      focusTerms
    );

    const analysisSteps = [
      `收到问题：${input.question}`,
      `已定位站点：${input.target.name} (${input.target.website_url})`,
      `准备递归检查这些页面（最大深度 ${input.maxDiscoveryDepth}，最多 ${input.maxDiscoveryPages} 页）：${candidateUrls.join("，")}`
    ];

    const visitedUrls: string[] = [];
    const visitedSet = new Set<string>();
    const answerCandidates: AnswerCandidate[] = [];
    const queue: QueueItem[] = candidateUrls.map((url, index) => ({
      url,
      depth: index === 0 ? 0 : 1,
      score:
        index === 0
          ? /(在哪|地址|位置|电话|邮箱|联系|办公室)/.test(input.question)
            ? 100
            : 50
          : input.scoreQuestionLink(
              input.question,
              home.important_links.find((item) => item.url === url)?.name ?? "",
              url
            )
    }));

    while (queue.length > 0 && visitedUrls.length < input.maxDiscoveryPages) {
      queue.sort((a, b) => b.score - a.score);
      const current = queue.shift();
      if (!current || visitedSet.has(current.url)) {
        continue;
      }

      visitedSet.add(current.url);
      visitedUrls.push(current.url);

      let result: PageAnswerResult;
      try {
        result = await input.answerFromPage(
          current.url,
          input.question,
          input.target,
          focusTerms
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        analysisSteps.push(`抓取页面 ${current.url} 失败，已跳过该页面继续检查其他候选页面：${message}`);
        continue;
      }
      analysisSteps.push(result.analysisStep);
      if (result.answered) {
        answerCandidates.push({
          ...result,
          checkedAt: visitedUrls.length
        });
      }

      if (current.depth >= input.maxDiscoveryDepth) {
        continue;
      }

      for (const link of result.discoveredLinks) {
        if (visitedSet.has(link.url) || queue.some((item) => item.url === link.url)) {
          continue;
        }

        queue.push({
          url: link.url,
          depth: current.depth + 1,
          score:
            input.scoreQuestionLink(input.question, link.name, link.url) +
            (focusTerms.some((term) => link.name.includes(term) || link.url.includes(term))
              ? 80
              : 0)
        });
      }
    }

    if (answerCandidates.length > 0) {
      const bestCandidate = answerCandidates
        .sort(
          (a, b) =>
            (b.answerScore ?? 0) - (a.answerScore ?? 0) ||
            a.checkedAt - b.checkedAt
        )[0];

      return {
        question: input.question,
        answered: true,
        answer: bestCandidate.answer,
        evidence: bestCandidate.evidence,
        analysis_steps: [
          ...analysisSteps,
          `综合 ${answerCandidates.length} 个候选答案后，选择置信度最高的结果（分数：${bestCandidate.answerScore ?? 0}）。`
        ],
        matched_site: input.target,
        source_urls: [bestCandidate.sourceUrl],
        fetched_at: input.nowIso()
      };
    }

    if (questionAsksForSiteEntry(input.question)) {
      return {
        question: input.question,
        answered: true,
        answer: `${input.target.name}官网入口：${input.target.website_url}`,
        evidence: `已从成都大学站点目录定位到 ${input.target.name} (${input.target.website_url})；当前未能从抓取正文中提取更具体信息。`,
        analysis_steps: [
          ...analysisSteps,
          "问题询问官网入口/页面位置，虽然正文抓取未提取到更具体答案，但目录中已有该站点入口，因此返回官网地址。"
        ],
        matched_site: input.target,
        source_urls: [input.target.website_url],
        fetched_at: input.nowIso()
      };
    }

    return {
      question: input.question,
      answered: false,
      answer: "没有在当前已抓取页面中找到明确答案。",
      evidence: home.markdown_excerpt || home.summary,
      analysis_steps: [
        ...analysisSteps,
        `综合已检查的 ${visitedUrls.length} 个页面内容判断，当前没有出现可以直接回答该问题的明确信息，所以返回“没有”。`
      ],
      matched_site: input.target,
      source_urls: visitedUrls,
      fetched_at: input.nowIso()
    };
  }
}
