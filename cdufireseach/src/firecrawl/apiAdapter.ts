import type { FirecrawlAdapter } from "./adapter.js";
import type {
  CatalogSite,
  DepartmentProfile,
  DepartmentSite,
  DepartmentSiteSearchResult,
  DepartmentsResult,
  LinkItem,
  OrganizationGroup,
  OrganizationStructure,
  SiteAnswerResult,
  SiteCatalogResult,
  SiteContentResult,
  SiteSearchResult
} from "../types.js";

const ORG_URL = "https://www.cdu.edu.cn/zzjg.htm";
const DEPT_URL = "https://www.cdu.edu.cn/yxsz.htm";

const ORG_SCHEMA = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          group_name: { type: "string" },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                url: { type: "string" }
              },
              required: ["name"],
              additionalProperties: true
            }
          }
        },
        required: ["group_name", "items"],
        additionalProperties: true
      }
    }
  },
  required: ["groups"],
  additionalProperties: true
} as const;

const DEPARTMENT_SCHEMA = {
  type: "object",
  properties: {
    departments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          category: { type: "string" },
          website_url: { type: "string" }
        },
        required: ["name", "website_url"],
        additionalProperties: true
      }
    }
  },
  required: ["departments"],
  additionalProperties: true
} as const;

const PROFILE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    important_links: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          url: { type: "string" }
        },
        required: ["name", "url"],
        additionalProperties: true
      }
    }
  },
  required: ["title", "summary", "important_links"],
  additionalProperties: true
} as const;

const QA_SCHEMA = {
  type: "object",
  properties: {
    answered: { type: "boolean" },
    answer: { type: "string" },
    evidence: { type: "string" }
  },
  required: ["answered", "answer", "evidence"],
  additionalProperties: true
} as const;

type JsonObject = Record<string, unknown>;

type ScrapeResponse = {
  success?: boolean;
  data?: {
    json?: JsonObject;
    markdown?: string;
    links?: string[];
    metadata?: {
      title?: string;
      sourceURL?: string;
    };
  };
};

type PageAnswerResult = {
  answered: boolean;
  answer: string;
  evidence: string;
  analysisStep: string;
  sourceUrl: string;
  discoveredLinks: LinkItem[];
};

type FirecrawlApiAdapterOptions = {
  apiKey?: string;
  baseUrl: string;
  cacheTtlMs?: number;
  maxDiscoveryDepth?: number;
  maxDiscoveryPages?: number;
};

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolveUrl(url: string, baseUrl: string): string {
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return url;
  }
}

function cleanWebsiteUrl(rawUrl: string, baseUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed === "#" || /^javascript:/i.test(trimmed)) {
    return null;
  }

  const withoutQuotedTitle = trimmed.replace(/\s+["'].+$/, "");
  const withoutEncodedQuotedTitle = withoutQuotedTitle.replace(/%20%22[^%]+(?:%[0-9A-Fa-f]{2}[^%]*)*$/u, "");
  const withoutTrailingQuote = withoutEncodedQuotedTitle.replace(/["']+$/, "");
  const cleaned = withoutTrailingQuote.trim();

  if (!cleaned || cleaned === "#") {
    return null;
  }

  const resolved = resolveUrl(cleaned, baseUrl);

  if (resolved === `${DEPT_URL}#` || resolved === `${ORG_URL}#`) {
    return null;
  }

  return resolved;
}

function urlLooksSuspicious(url: string): boolean {
  return (
    url.includes("%20%22") ||
    /%22$/i.test(url) ||
    /\/\s*%22/i.test(url) ||
    url.endsWith("#")
  );
}

function isAllowedDepartmentName(name: string): boolean {
  return /(学院|研究院|中心|附属|创新创业)/.test(name);
}

function dedupeByNameAndUrl<T extends { name: string; url?: string; website_url?: string }>(
  items: T[]
): T[] {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const item of items) {
    const key = `${item.name}::${item.url ?? item.website_url ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }

  return result;
}

function markdownLinksToNamedItems(markdown: string, baseUrl: string): LinkItem[] {
  const pattern = /\[([^\]]+)\]\(([^)]+)\)/g;
  const results: LinkItem[] = [];

  for (const match of markdown.matchAll(pattern)) {
    const name = match[1]?.trim();
    const rawUrl = match[2]?.trim();
    if (!name || !rawUrl) {
      continue;
    }
    if (/^(javascript:|mailto:|#)/i.test(rawUrl)) {
      continue;
    }
    const cleanedUrl = cleanWebsiteUrl(rawUrl, baseUrl);
    if (!cleanedUrl) {
      continue;
    }
    results.push({
      name,
      url: cleanedUrl
    });
  }

  return dedupeByNameAndUrl(results).slice(0, 100);
}

function extractSummaryFromMarkdown(markdown: string): string {
  const lines = markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("["));

  return lines.slice(0, 3).join(" ").slice(0, 300) || "暂未从页面中提取到摘要。";
}

function normalizeDepartmentCategory(name: string, category?: string | null): string {
  if (category) {
    return category;
  }
  if (name.includes("学院")) {
    return "学院";
  }
  if (name.includes("研究院")) {
    return "研究院";
  }
  if (name.includes("中心")) {
    return "中心";
  }
  return "其他";
}

function safeParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function markdownExcerpt(markdown: string, maxLength = 600): string {
  const text = markdown
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/[#>*`-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return text.slice(0, maxLength);
}

function summarizeForAnalysis(markdown: string, maxLength = 120): string {
  return markdownExcerpt(markdown, maxLength) || "页面正文中没有提取到足够的可读内容。";
}

function normalizeSearchText(value: string): string {
  return value
    .replace(/\s+/g, "")
    .replace(/[？?！!。,.，、:：（）()【】\[\]]/g, "")
    .replace(/(在哪里|在哪儿|在哪|位置|地址|电话|邮箱|邮件|官网|网站|主页|首页|是什么|是哪里|多少|怎么走|联系电话)/g, "")
    .trim()
    .toLowerCase();
}

function expandSearchNames(name: string): string[] {
  const results = new Set<string>();
  const trimmed = name.trim();

  if (!trimmed) {
    return [];
  }

  results.add(trimmed);

  const normalized = trimmed
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/[【\[]/g, "(")
    .replace(/[】\]]/g, ")");

  results.add(normalized);
  results.add(normalized.replace(/\(([^)]+)\)/g, "$1"));
  results.add(normalized.replace(/\(([^)]+)\)/g, "").trim());

  const parentheticalParts = [...normalized.matchAll(/\(([^)]+)\)/g)]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);

  for (const part of parentheticalParts) {
    results.add(part);
    for (const subPart of part.split(/[、,，/]/).map((item) => item.trim()).filter(Boolean)) {
      results.add(subPart);
    }
  }

  for (const piece of normalized.split(/[、,，/]/).map((item) => item.trim()).filter(Boolean)) {
    results.add(piece);
  }

  return [...results].filter(Boolean);
}

function keywordToTokens(keyword: string): string[] {
  return keyword
    .split(/[\s，。！？、,.!?/]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function characterCoverageScore(name: string, keyword: string): number {
  const nameChars = [...new Set(name)];
  const keywordChars = new Set(keyword);

  if (nameChars.length === 0 || keywordChars.size === 0) {
    return 0;
  }

  const hitCount = nameChars.filter((char) => keywordChars.has(char)).length;
  const coverage = hitCount / nameChars.length;

  if (coverage === 1) {
    return 70;
  }
  if (coverage >= 0.8) {
    return 45;
  }
  if (coverage >= 0.6) {
    return 25;
  }
  return 0;
}

function scoreSiteMatch(name: string, keyword: string): number {
  const normalizedName = normalizeSearchText(name);
  const normalizedKeyword = normalizeSearchText(keyword);

  if (!normalizedKeyword) {
    return 0;
  }
  if (normalizedName === normalizedKeyword) {
    return 100;
  }
  if (normalizedKeyword.includes(normalizedName)) {
    return 80;
  }
  if (normalizedName.includes(normalizedKeyword)) {
    return 60;
  }

  const tokenScore = keywordToTokens(normalizedKeyword).reduce((score, token) => {
    if (token && normalizedName.includes(token)) {
      return score + 10;
    }
    return score;
  }, 0);

  return tokenScore + characterCoverageScore(normalizedName, normalizedKeyword);
}

function scoreCatalogSiteMatch(site: CatalogSite, keyword: string): number {
  return expandSearchNames(site.name).reduce((bestScore, candidateName) => {
    return Math.max(bestScore, scoreSiteMatch(candidateName, keyword));
  }, 0);
}

function extractAddressAnswer(markdown: string): string | null {
  const compact = markdown.replace(/\s+/g, " ").trim();
  const match = compact.match(/地址[：:]\s*([^。；;\n]{4,120})/u);
  return match?.[1]?.trim() ?? null;
}

function extractPhoneAnswer(markdown: string): string | null {
  const phones = [...markdown.matchAll(/0\d{2,3}-\d{7,8}/g)].map((match) => match[0]);
  return phones.length > 0 ? phones.join("，") : null;
}

function extractEmailAnswer(markdown: string): string | null {
  const match = markdown.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu);
  return match?.[0] ?? null;
}

type QuestionIntent = "location" | "phone" | "email" | "generic";

function detectQuestionIntent(question: string): QuestionIntent {
  if (/(在哪|地址|位置)/.test(question)) {
    return "location";
  }
  if (/(电话|联系电话|联系方式)/.test(question)) {
    return "phone";
  }
  if (/(邮箱|邮件|email)/i.test(question)) {
    return "email";
  }
  return "generic";
}

function cleanAnswerText(value: string): string {
  return value
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/版权所有[:：]?\s*.+$/u, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[，,。；;]+$/u, "");
}

function normalizeMarkdownLines(markdown: string): string[] {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        !!line &&
        !/^!\[[^\]]*\]\([^)]+\)$/.test(line) &&
        !/^\[[^\]]+\]\([^)]+\)$/.test(line) &&
        !/^(上一页|下一页|返回|关闭)$/.test(line)
    );
}

function lineContainsFocusTerm(line: string, focusTerms: string[]): boolean {
  return focusTerms.some((term) => line.includes(term));
}

function buildFocusWindows(lines: string[], focusTerms: string[]): string[] {
  if (focusTerms.length === 0) {
    return [];
  }

  const windows: string[] = [];
  const usedRanges = new Set<string>();

  for (let index = 0; index < lines.length; index += 1) {
    if (!lineContainsFocusTerm(lines[index] ?? "", focusTerms)) {
      continue;
    }

    const start = Math.max(0, index - 3);
    const end = Math.min(lines.length, index + 8);
    const key = `${start}:${end}`;
    if (usedRanges.has(key)) {
      continue;
    }
    usedRanges.add(key);
    windows.push(lines.slice(start, end).join("\n"));
  }

  return windows;
}

function extractLabelValue(block: string, labels: string[]): string | null {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const inlinePattern = new RegExp(`${escaped}[：:]\\s*([^\\n]{2,120})`, "u");
    const inlineMatch = block.match(inlinePattern);
    if (inlineMatch?.[1]) {
      return cleanAnswerText(`${label}：${inlineMatch[1]}`);
    }

    const nextLinePattern = new RegExp(`${escaped}[：:]?\\s*\\n\\s*([^\\n]{2,120})`, "u");
    const nextLineMatch = block.match(nextLinePattern);
    if (nextLineMatch?.[1]) {
      return cleanAnswerText(`${label}：${nextLineMatch[1]}`);
    }
  }

  return null;
}

function extractFocusedAnswer(
  question: string,
  markdown: string,
  focusTerms: string[]
): string | null {
  const intent = detectQuestionIntent(question);
  const lines = normalizeMarkdownLines(markdown);
  const focusBlocks = buildFocusWindows(lines, focusTerms);

  if (focusBlocks.length === 0) {
    return null;
  }

  for (const block of focusBlocks) {
    if (intent === "location") {
      const answer =
        extractLabelValue(block, ["办公地点", "办公地址", "办公位置", "地点"]) ??
        extractLabelValue(block, ["地址"]);
      if (answer) {
        return answer;
      }
    }

    if (intent === "phone") {
      const answer =
        extractLabelValue(block, ["联系电话", "电话", "联系方式"]) ??
        extractPhoneAnswer(block);
      if (answer) {
        return answer;
      }
    }

    if (intent === "email") {
      const answer =
        extractLabelValue(block, ["邮箱", "Email", "电子邮箱"]) ??
        extractEmailAnswer(block);
      if (answer) {
        return cleanAnswerText(answer);
      }
    }
  }

  return null;
}

function extractHeuristicAnswer(
  question: string,
  markdown: string,
  focusTerms: string[]
): string | null {
  const focusedAnswer = extractFocusedAnswer(question, markdown, focusTerms);
  if (focusedAnswer) {
    return focusedAnswer;
  }

  if (detectQuestionIntent(question) === "location") {
    const directAnswer =
      extractLabelValue(markdown, ["办公地点", "办公地址", "办公位置", "地点"]) ??
      extractAddressAnswer(markdown);
    return directAnswer ? cleanAnswerText(directAnswer) : null;
  }
  if (detectQuestionIntent(question) === "phone") {
    const directAnswer =
      extractLabelValue(markdown, ["联系电话", "电话", "联系方式"]) ??
      extractPhoneAnswer(markdown);
    return directAnswer ? cleanAnswerText(directAnswer) : null;
  }
  if (detectQuestionIntent(question) === "email") {
    const directAnswer =
      extractLabelValue(markdown, ["邮箱", "Email", "电子邮箱"]) ??
      extractEmailAnswer(markdown);
    return directAnswer ? cleanAnswerText(directAnswer) : null;
  }

  return null;
}

function isHtmlLikeUrl(url: string): boolean {
  return !/\.(?:jpg|jpeg|png|gif|svg|webp|bmp|ico|pdf|docx?|xlsx?|pptx?|zip|rar|7z|mp3|mp4|avi|mov)(?:[?#].*)?$/i.test(
    url
  );
}

function isSameSiteUrl(candidateUrl: string, siteUrl: string): boolean {
  const candidate = safeParseUrl(candidateUrl);
  const site = safeParseUrl(siteUrl);

  if (!candidate || !site) {
    return false;
  }

  return candidate.hostname === site.hostname;
}

function scoreQuestionLink(question: string, linkName: string, url: string): number {
  let score = 10;
  const isContactQuestion = /(在哪|地址|位置|电话|邮箱|联系|办公室)/.test(question);

  if (isContactQuestion && /(联系|关于|简介|概况|办公室|部门简介|中心简介|机构设置|联系我们)/.test(linkName)) {
    score += 40;
  }

  if (question.includes(linkName)) {
    score += 30;
  }

  if (/(通知|公告|新闻|动态)/.test(linkName) && /(在哪|地址|位置|电话|邮箱|联系|办公室)/.test(question)) {
    score -= 10;
  }

  if (/index|home|default/i.test(url)) {
    score += 5;
  }

  return score;
}

function extractQuestionFocusTerms(question: string, matchedSiteName: string): string[] {
  let remainder = normalizeSearchText(question);
  const aliases = expandSearchNames(matchedSiteName)
    .map((item) => normalizeSearchText(item))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  for (const alias of aliases) {
    remainder = remainder.replace(alias, " ");
  }

  const cleaned = remainder.replace(/\s+/g, " ").trim();
  const matches = [...cleaned.matchAll(/[\u4e00-\u9fa5]{1,12}(?:科|室|中心|办公室|部门)/g)]
    .map((match) => match[0]?.trim() ?? "")
    .filter(Boolean);

  if (matches.length > 0) {
    return [...new Set(matches)];
  }

  if (cleaned && cleaned.length >= 2 && cleaned.length <= 12) {
    return [cleaned];
  }

  return [];
}

function pageMatchesFocusTerms(markdown: string, title: string, focusTerms: string[]): boolean {
  if (focusTerms.length === 0) {
    return true;
  }

  const haystack = `${title}\n${markdown}`;
  return focusTerms.some((term) => haystack.includes(term));
}

function dedupeCatalogSites(items: CatalogSite[]): CatalogSite[] {
  const seen = new Set<string>();
  const results: CatalogSite[] = [];

  for (const item of items) {
    const key = `${item.name}::${item.website_url}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push(item);
  }

  return results;
}

function isLikelyInstitutionName(name: string): boolean {
  if (!name || /^(首页|搜索|关闭|TOP|EN|学生|教职工|校友|访客|网络理政|VPN入口)$/.test(name)) {
    return false;
  }

  return /(学院|研究院|中心|办公室|处|部|馆|委|所|医院|工会|团委|基金会|公司|大学附属|门户|大厅|系统|小学|幼儿园)/.test(
    name
  );
}

function parseSupplementalOrgLinksFromHtml(html: string): LinkItem[] {
  const results: LinkItem[] = [];
  const anchorPattern = /<a\s+[^>]*href="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(anchorPattern)) {
    const rawUrl = decodeHtmlEntities(match[1] ?? "").trim();
    const attrs = match[2] ?? "";
    const titleMatch = attrs.match(/title="([^"]+)"/i);
    const title = stripHtmlTags(titleMatch?.[1] ?? "");
    const text = stripHtmlTags(match[3] ?? "");
    const name = title || text;
    const cleanedUrl = cleanWebsiteUrl(rawUrl, ORG_URL);
    const parsedUrl = cleanedUrl ? safeParseUrl(cleanedUrl) : null;

    if (!name || !cleanedUrl || !parsedUrl) {
      continue;
    }

    if (!parsedUrl.hostname.endsWith(".cdu.edu.cn") || parsedUrl.hostname === "www.cdu.edu.cn") {
      continue;
    }

    if (!isLikelyInstitutionName(name)) {
      continue;
    }

    results.push({
      name,
      url: cleanedUrl
    });
  }

  return dedupeByNameAndUrl(results);
}

function toCatalogSite(
  item: DepartmentSite,
  sourceKind: "organization" | "department",
  groupName?: string
): CatalogSite {
  return {
    name: item.name,
    category: item.category,
    website_url: item.website_url,
    source_url: item.source_url,
    source_kind: sourceKind,
    group_name: groupName,
    last_synced_at: item.last_synced_at
  };
}

function mapDepartment(item: JsonObject, sourceUrl: string, fetchedAt: string): DepartmentSite | null {
  const name = asNonEmptyString(item.name);
  const websiteUrl = asNonEmptyString(item.website_url);
  const category = asNonEmptyString(item.category);

  if (!name || !websiteUrl) {
    return null;
  }

  const cleanedUrl = cleanWebsiteUrl(websiteUrl, sourceUrl);
  if (!cleanedUrl) {
    return null;
  }

  return {
    name,
    category: normalizeDepartmentCategory(name, category),
    website_url: cleanedUrl,
    source_url: sourceUrl,
    last_synced_at: fetchedAt
  };
}

function parseDepartmentJson(payload: JsonObject | undefined): DepartmentSite[] {
  const fetchedAt = nowIso();
  const items = Array.isArray(payload?.departments) ? payload.departments : [];
  const departments = items
    .map((item) => (item && typeof item === "object" ? mapDepartment(item as JsonObject, DEPT_URL, fetchedAt) : null))
    .filter((item): item is DepartmentSite => item !== null && isAllowedDepartmentName(item.name));

  return dedupeByNameAndUrl(departments);
}

function parseDepartmentMarkdown(markdown: string): DepartmentSite[] {
  const fetchedAt = nowIso();
  const items = markdownLinksToNamedItems(markdown, DEPT_URL)
    .filter((item) => isAllowedDepartmentName(item.name))
    .map((item) => {
      const cleanedUrl = cleanWebsiteUrl(item.url, DEPT_URL);
      if (!cleanedUrl) {
        return null;
      }
      return {
        name: item.name,
        category: normalizeDepartmentCategory(item.name),
        website_url: cleanedUrl,
        source_url: DEPT_URL,
        last_synced_at: fetchedAt
      };
    })
    .filter((item): item is DepartmentSite => item !== null);

  return dedupeByNameAndUrl(items);
}

function mapOrganizationGroups(payload: JsonObject | undefined): OrganizationGroup[] {
  const groups: unknown[] = Array.isArray(payload?.groups) ? payload.groups : [];

  return groups
    .map((group) => {
      if (!group || typeof group !== "object") {
        return null;
      }
      const groupName = asNonEmptyString((group as JsonObject).group_name);
      const rawItems = (group as JsonObject).items;
      const items: unknown[] = Array.isArray(rawItems) ? rawItems : [];

      if (!groupName) {
        return null;
      }

      const normalizedItems = items
        .map((item) => {
          if (!item || typeof item !== "object") {
            return null;
          }
          const name = asNonEmptyString((item as JsonObject).name);
          const url = asNonEmptyString((item as JsonObject).url);
          if (!name) {
            return null;
          }
          return {
            name,
            url: resolveUrl(url ?? ORG_URL, ORG_URL)
          };
        })
        .filter((item): item is LinkItem => item !== null);

      return {
        group_name: groupName,
        items: dedupeByNameAndUrl(normalizedItems)
      };
    })
    .filter((group): group is OrganizationGroup => group !== null);
}

function parseOrganizationMarkdown(markdown: string): OrganizationGroup[] {
  const lines = markdown.split("\n");
  const groups: OrganizationGroup[] = [];
  let currentGroup: OrganizationGroup | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      if (currentGroup && currentGroup.items.length > 0) {
        groups.push(currentGroup);
      }
      currentGroup = {
        group_name: heading[1].trim(),
        items: []
      };
      continue;
    }

    const linkMatch = line.match(/^\s*[-*]\s+\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch && currentGroup) {
      currentGroup.items.push({
        name: linkMatch[1].trim(),
        url: resolveUrl(linkMatch[2].trim(), ORG_URL)
      });
    }
  }

  if (currentGroup && currentGroup.items.length > 0) {
    groups.push(currentGroup);
  }

  return groups;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripHtmlTags(value: string): string {
  return decodeHtmlEntities(value).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function parseOrganizationHtml(html: string): OrganizationGroup[] {
  const groups: OrganizationGroup[] = [];
  const boxPattern =
    /<div class="box"[\s\S]*?<div class="line">([\s\S]*?)<\/div>[\s\S]*?<div class="con">([\s\S]*?)<\/div><\/div>/g;

  for (const boxMatch of html.matchAll(boxPattern)) {
    const groupName = stripHtmlTags(boxMatch[1] ?? "");
    const body = boxMatch[2] ?? "";
    if (!groupName) {
      continue;
    }

    const items: LinkItem[] = [];
    const anchorPattern =
      /<a\s+[^>]*href="([^"]+)"[^>]*title="([^"]*)"[^>]*class="a[^"]*"[^>]*>/g;

    for (const anchorMatch of body.matchAll(anchorPattern)) {
      const rawUrl = decodeHtmlEntities(anchorMatch[1] ?? "").trim();
      const title = stripHtmlTags(anchorMatch[2] ?? "");
      const cleanedUrl = cleanWebsiteUrl(rawUrl, ORG_URL);

      if (!title || !cleanedUrl) {
        continue;
      }

      items.push({
        name: title,
        url: cleanedUrl
      });
    }

    if (items.length > 0) {
      groups.push({
        group_name: groupName,
        items: dedupeByNameAndUrl(items)
      });
    }
  }

  return groups;
}

export class FirecrawlApiAdapter implements FirecrawlAdapter {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly cacheTtlMs: number;
  private readonly maxDiscoveryDepth: number;
  private readonly maxDiscoveryPages: number;
  private readonly cache = new Map<string, { expiresAt: number; value: unknown }>();

  constructor(options: FirecrawlApiAdapterOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.cacheTtlMs = options.cacheTtlMs ?? 30 * 60 * 1000;
    this.maxDiscoveryDepth = Math.max(0, options.maxDiscoveryDepth ?? 2);
    this.maxDiscoveryPages = Math.max(1, options.maxDiscoveryPages ?? 8);
  }

  async getOrgStructure(): Promise<OrganizationStructure> {
    return this.withCache("org-structure", async () => {
      const response = await this.scrape(ORG_URL, [
        {
          type: "json",
          schema: ORG_SCHEMA,
          prompt:
            "提取成都大学组织机构页面中的一级分组和每个分组下的机构名称、链接。"
        },
        "markdown"
      ]);

      const groups = mapOrganizationGroups(response.data?.json);
      if (groups.length === 0) {
        const markdown = response.data?.markdown;
        const markdownGroups = markdown ? parseOrganizationMarkdown(markdown) : [];
        if (markdownGroups.length > 0) {
          return {
            source_url: ORG_URL,
            fetched_at: nowIso(),
            groups: markdownGroups
          };
        }

        const html = await this.fetchPageHtml(ORG_URL);
        const htmlGroups = parseOrganizationHtml(html);
        if (htmlGroups.length === 0) {
          throw new Error("Organization extraction returned no groups");
        }

        return {
          source_url: ORG_URL,
          fetched_at: nowIso(),
          groups: htmlGroups
        };
      }

      return {
        source_url: ORG_URL,
        fetched_at: nowIso(),
        groups
      };
    });
  }

  async getDepartments(): Promise<DepartmentsResult> {
    return this.withCache("departments", async () => {
      const response = await this.scrape(DEPT_URL, [
        {
          type: "json",
          schema: DEPARTMENT_SCHEMA,
          prompt:
            "提取成都大学院系设置页面中的院系、研究院、附属单位名称及其官网或二级网站链接。category 取值如 学院、研究院、附属单位、其他。"
        }
      ]);

      let departments = parseDepartmentJson(response.data?.json);

      if (departments.length === 0) {
        const markdownFallback = await this.scrape(DEPT_URL, ["markdown"]);
        const markdown = markdownFallback.data?.markdown ?? response.data?.markdown;
        if (!markdown) {
          throw new Error("Department extraction returned no markdown");
        }
        departments = parseDepartmentMarkdown(markdown);
      }

      return {
        source_url: DEPT_URL,
        fetched_at: nowIso(),
        departments
      };
    });
  }

  async getSiteCatalog(): Promise<SiteCatalogResult> {
    return this.withCache("site-catalog", async () => {
      const [org, departments] = await Promise.all([
        this.getOrgStructure(),
        this.getDepartments()
      ]);

      const orgSites: CatalogSite[] = org.groups.flatMap((group) =>
        group.items
          .filter((item) => item.url.startsWith("http"))
          .map((item) =>
            toCatalogSite(
              {
                name: item.name,
                category: group.group_name,
                website_url: item.url,
                source_url: org.source_url,
                last_synced_at: org.fetched_at
              },
              "organization",
              group.group_name
            )
          )
      );

      const departmentSites = departments.departments.map((item) =>
        toCatalogSite(item, "department")
      );

      let supplementalOrgSites: CatalogSite[] = [];
      try {
        const html = await this.fetchPageHtml(ORG_URL);
        supplementalOrgSites = parseSupplementalOrgLinksFromHtml(html).map((item) =>
          toCatalogSite(
            {
              name: item.name,
              category: "组织机构",
              website_url: item.url,
              source_url: ORG_URL,
              last_synced_at: nowIso()
            },
            "organization",
            "组织机构"
          )
        );
      } catch {
        supplementalOrgSites = [];
      }

      return {
        fetched_at: nowIso(),
        sites: dedupeCatalogSites(
          [...orgSites, ...supplementalOrgSites, ...departmentSites].filter(
            (item) =>
              item.website_url !== item.source_url &&
              item.website_url !== ORG_URL &&
              item.website_url !== DEPT_URL &&
              !urlLooksSuspicious(item.website_url)
          )
        )
      };
    });
  }

  async findSite(keyword: string): Promise<SiteSearchResult> {
    const catalog = await this.getSiteCatalog();
    const matches = catalog.sites
      .map((item) => ({
        item,
        score: scoreCatalogSiteMatch(item, keyword)
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((item) => item.item)
      .slice(0, 10);

    return {
      keyword,
      matches
    };
  }

  async getSiteContent(siteName: string): Promise<SiteContentResult> {
    return this.withCache(`site-content:${siteName}`, async () => {
      const target = await this.resolveSite(siteName);
      const response = await this.scrape(target.website_url, [
        {
          type: "json",
          schema: PROFILE_SCHEMA,
          prompt:
            "提取这个成都大学二级网站首页的标题、1到3句简介摘要，以及最重要的导航链接。important_links 最多返回 8 个。"
        },
        "markdown"
      ]);

      const payload = response.data?.json;
      const title =
        asNonEmptyString(payload?.title) ??
        asNonEmptyString(response.data?.metadata?.title) ??
        target.name;
      const summary =
        asNonEmptyString(payload?.summary) ??
        extractSummaryFromMarkdown(response.data?.markdown ?? "");
      const importantLinks =
        Array.isArray(payload?.important_links)
          ? (payload.important_links as unknown[])
              .map((item) => {
                if (!item || typeof item !== "object") {
                  return null;
                }
                const name = asNonEmptyString((item as JsonObject).name);
                const url = asNonEmptyString((item as JsonObject).url);
                const cleanedUrl = url ? cleanWebsiteUrl(url, target.website_url) : null;
                if (!name || !cleanedUrl) {
                  return null;
                }
                return {
                  name,
                  url: cleanedUrl
                };
              })
              .filter((item): item is LinkItem => item !== null)
          : markdownLinksToNamedItems(response.data?.markdown ?? "", target.website_url).slice(0, 8);

      return {
        site_name: target.name,
        website_url: target.website_url,
        title,
        summary,
        important_links: dedupeByNameAndUrl(importantLinks).slice(0, 8),
        markdown_excerpt: markdownExcerpt(response.data?.markdown ?? ""),
        source_url: target.website_url,
        fetched_at: nowIso()
      };
    });
  }

  async askSite(question: string, siteName?: string): Promise<SiteAnswerResult> {
    return this.withCache(`site-answer:${siteName ?? ""}:${question}`, async () => {
      const target = siteName ? await this.resolveSite(siteName) : await this.inferSiteFromQuestion(question);
      if (!target) {
        return {
          question,
          answered: false,
          answer: "未能从目录中定位到对应的成都大学二级网站。",
          evidence: "问题中没有命中已同步的机构或院系站点名称。",
          analysis_steps: [
            `收到问题：${question}`,
            "尝试根据问题内容匹配成都大学机构或院系站点，但没有命中已同步的站点名称。",
            "因此当前无法确定应该抓取哪个二级网站。"
          ],
          matched_site: null,
          source_urls: [],
          fetched_at: nowIso()
        };
      }

      const home = await this.getSiteContent(target.name);
      const focusTerms = extractQuestionFocusTerms(question, target.name);
      const candidateUrls = this.selectCandidateUrls(
        question,
        target.website_url,
        home.important_links,
        focusTerms
      );
      const analysisSteps = [
        `收到问题：${question}`,
        `已定位站点：${target.name} (${target.website_url})`,
        `准备递归检查这些页面（最大深度 ${this.maxDiscoveryDepth}，最多 ${this.maxDiscoveryPages} 页）：${candidateUrls.join("，")}`
      ];

      const visitedUrls: string[] = [];
      const visitedSet = new Set<string>();
      const queue = candidateUrls.map((url, index) => ({
        url,
        depth: index === 0 ? 0 : 1,
        score:
          index === 0
            ? /(在哪|地址|位置|电话|邮箱|联系|办公室)/.test(question)
              ? 100
              : 50
            : scoreQuestionLink(
                question,
                home.important_links.find((item) => item.url === url)?.name ?? "",
                url
              )
      }));

      while (queue.length > 0 && visitedUrls.length < this.maxDiscoveryPages) {
        queue.sort((a, b) => b.score - a.score);
        const current = queue.shift();
        if (!current || visitedSet.has(current.url)) {
          continue;
        }

        visitedSet.add(current.url);
        visitedUrls.push(current.url);
        const result = await this.answerFromPage(current.url, question, target, focusTerms);
        analysisSteps.push(result.analysisStep);
        if (result.answered) {
          return {
            question,
            answered: true,
            answer: result.answer,
            evidence: result.evidence,
            analysis_steps: analysisSteps,
            matched_site: target,
            source_urls: [result.sourceUrl],
            fetched_at: nowIso()
          };
        }

        if (current.depth >= this.maxDiscoveryDepth) {
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
              scoreQuestionLink(question, link.name, link.url) +
              (focusTerms.some((term) => link.name.includes(term) || link.url.includes(term)) ? 80 : 0)
          });
        }
      }

      return {
        question,
        answered: false,
        answer: "没有在当前已抓取页面中找到明确答案。",
        evidence: home.markdown_excerpt || home.summary,
        analysis_steps: [
          ...analysisSteps,
          `综合已检查的 ${visitedUrls.length} 个页面内容判断，当前没有出现可以直接回答该问题的明确信息，所以返回“没有”。`
        ],
        matched_site: target,
        source_urls: visitedUrls,
        fetched_at: nowIso()
      };
    });
  }

  async findDepartmentSite(keyword: string): Promise<DepartmentSiteSearchResult> {
    const normalized = keyword.trim().toLowerCase();
    const departments = await this.getDepartments();

    return {
      keyword,
      matches: departments.departments.filter((item) =>
        item.name.toLowerCase().includes(normalized)
      )
    };
  }

  async getDepartmentProfile(departmentName: string): Promise<DepartmentProfile> {
    const content = await this.getSiteContent(departmentName);
    return {
      department_name: departmentName,
      website_url: content.website_url,
      title: content.title,
      summary: content.summary,
      important_links: content.important_links,
      source_url: content.source_url,
      fetched_at: content.fetched_at
    };
  }

  private async resolveSite(siteName: string): Promise<CatalogSite> {
    const result = await this.findSite(siteName);
    const target = result.matches[0];
    if (!target) {
      throw new Error(`No CDU site matched: ${siteName}`);
    }
    return target;
  }

  private async inferSiteFromQuestion(question: string): Promise<CatalogSite | null> {
    const result = await this.findSite(question);
    return result.matches[0] ?? null;
  }

  private selectCandidateUrls(
    question: string,
    siteUrl: string,
    links: LinkItem[],
    focusTerms: string[]
  ): string[] {
    const urlMap = new Map<string, number>();
    const isContactQuestion = /(在哪|地址|位置|电话|邮箱|联系|办公室)/.test(question);
    urlMap.set(siteUrl, isContactQuestion ? (focusTerms.length > 0 ? 35 : 100) : 50);

    for (const link of links) {
      if (!isSameSiteUrl(link.url, siteUrl) || !isHtmlLikeUrl(link.url)) {
        continue;
      }
      const score =
        scoreQuestionLink(question, link.name, link.url) +
        (focusTerms.some((term) => link.name.includes(term) || link.url.includes(term)) ? 80 : 0);
      if (!urlMap.has(link.url) || (urlMap.get(link.url) ?? 0) < score) {
        urlMap.set(link.url, score);
      }
    }

    return [...urlMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([url]) => url)
      .slice(0, 4);
  }

  private async answerFromPage(
    url: string,
    question: string,
    matchedSite: CatalogSite,
    focusTerms: string[]
  ): Promise<PageAnswerResult> {
    const response = await this.scrape(url, [
      {
        type: "json",
        schema: QA_SCHEMA,
        prompt: `请仅根据当前页面内容回答这个问题：${question}。如果页面没有明确答案，请返回 answered=false。evidence 字段给出页面里的简短证据。`
      },
      "markdown"
    ]);

    const payload = response.data?.json;
    const answered = payload?.answered === true;
    const answer = asNonEmptyString(payload?.answer);
    const evidence =
      asNonEmptyString(payload?.evidence) ??
      markdownExcerpt(response.data?.markdown ?? "", 220);
    const title =
      asNonEmptyString(response.data?.metadata?.title) ??
      matchedSite.name;
    const pageSummary = summarizeForAnalysis(response.data?.markdown ?? "");
    const heuristicAnswer = extractHeuristicAnswer(
      question,
      response.data?.markdown ?? "",
      focusTerms
    );
    const discoveredLinks = markdownLinksToNamedItems(
      response.data?.markdown ?? "",
      url
    )
      .filter((link) => isSameSiteUrl(link.url, matchedSite.website_url) && isHtmlLikeUrl(link.url))
      .slice(0, 20);
    const focusMatched = pageMatchesFocusTerms(
      response.data?.markdown ?? "",
      title,
      focusTerms
    );

    if (heuristicAnswer && focusMatched) {
      return {
        answered: true,
        answer: heuristicAnswer,
        evidence: `从页面正文中提取到与问题直接相关的信息：${heuristicAnswer}`,
        analysisStep: `已检查页面《${title}》(${url})，并通过页面正文中的地址/联系方式字段提取到直接答案。`,
        sourceUrl: url,
        discoveredLinks
      };
    }

    return {
      answered: answered && !!answer,
      answer: answer ?? "当前页面没有明确答案。",
      evidence,
      analysisStep:
        heuristicAnswer && !focusMatched
          ? `已检查页面《${title}》(${url})，发现了站点级通用联系方式，但未命中问题中的具体科室/部门信息，继续向下检查更细页面。`
          : answered && !!answer
          ? `已检查页面《${title}》(${url})，页面中存在可直接回答问题的内容。`
          : `已检查页面《${title}》(${url})，没有发现明确答案。页面摘要：${pageSummary}`,
      sourceUrl: url,
      discoveredLinks
    };
  }

  private async withCache<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value as T;
    }

    const value = await loader();
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + this.cacheTtlMs
    });
    return value;
  }

  private async scrape(url: string, formats: unknown[]): Promise<ScrapeResponse> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };

    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(`${this.baseUrl}/v2/scrape`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        url,
        formats,
        onlyMainContent: false
      })
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(
        `Firecrawl scrape failed (${response.status}) for ${url}: ${details.slice(0, 300)}`
      );
    }

    const payload = (await response.json()) as ScrapeResponse;
    if (!payload || typeof payload !== "object" || !payload.data) {
      throw new Error(`Firecrawl returned an unexpected payload for ${url}`);
    }

    return payload;
  }

  private async fetchPageHtml(url: string): Promise<string> {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "cdufireseach/0.1.0"
      }
    });

    if (!response.ok) {
      throw new Error(`Direct page fetch failed (${response.status}) for ${url}`);
    }

    return response.text();
  }
}
