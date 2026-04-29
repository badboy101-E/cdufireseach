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
import {
  MarkdownMemoryService,
  type MemoryMatchResult
} from "../memory/markdownMemory.js";
import { CduCatalogService } from "../services/catalogService.js";
import {
  CduPageQaService,
  type PageAnswerResult
} from "../services/pageQaService.js";

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

type FirecrawlApiAdapterOptions = {
  apiKey?: string;
  baseUrl: string;
  cacheTtlMs?: number;
  maxDiscoveryDepth?: number;
  maxDiscoveryPages?: number;
  memoryFilePath?: string;
  memoryCacheTtlMs?: number;
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

  let resolved = resolveUrl(cleaned, baseUrl);

  try {
    const parsed = new URL(resolved);
    if (/\/Line$/i.test(parsed.pathname)) {
      parsed.pathname = parsed.pathname.replace(/\/Line$/i, "/");
      resolved = parsed.toString();
    }
  } catch {
    // Keep the original resolved value if URL parsing fails.
  }

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

function normalizeMemorySiteText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[？?！!。.,，、:：;；'"“”‘’()（）【】\[\]<>《》]/g, "")
    .trim();
}

function expandMemorySiteTerms(value: string): string[] {
  const normalized = value
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/[【\[]/g, "(")
    .replace(/[】\]]/g, ")");
  const results = new Set<string>([value.trim(), normalized.trim()]);

  const innerParts = [...normalized.matchAll(/\(([^)]+)\)/g)]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
  for (const part of innerParts) {
    results.add(part);
    for (const segment of part.split(/[、,，/]/).map((item) => item.trim()).filter(Boolean)) {
      results.add(segment);
    }
  }

  const withoutParens = normalized.replace(/\(([^)]+)\)/g, "").trim();
  if (withoutParens) {
    results.add(withoutParens);
  }

  for (const segment of normalized.split(/[、,，/]/).map((item) => item.trim()).filter(Boolean)) {
    results.add(segment);
  }

  return [...results]
    .map((item) => normalizeMemorySiteText(item))
    .filter(Boolean);
}

function memoryMatchBelongsToSite(memoryEntryTitle: string, target: CatalogSite): boolean {
  const entryTerms = expandMemorySiteTerms(memoryEntryTitle);
  const siteTerms = expandMemorySiteTerms(target.name);

  return entryTerms.some((entryTerm) =>
    siteTerms.some(
      (siteTerm) =>
        entryTerm === siteTerm ||
        entryTerm.includes(siteTerm) ||
        siteTerm.includes(entryTerm)
    )
  );
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

function extractParentheticalLocationAnswer(markdown: string): string | null {
  const lines = normalizeMarkdownLines(markdown);
  for (const line of lines) {
    const match = line.match(/办公(?:地点|地址|位置)[（(]\s*([^）)\n]{2,120})\s*[）)]/u);
    if (match?.[1]) {
      return cleanAnswerText(`办公地点：${match[1]}`);
    }
  }

  return null;
}

function extractPhoneAnswer(markdown: string): string | null {
  const normalized = normalizePhoneText(markdown);
  const phones = [...normalized.matchAll(/0\d{2,3}-\d{7,8}/g)].map((match) => match[0]);
  return phones.length > 0 ? phones.join("，") : null;
}

function normalizePhoneText(value: string): string {
  return value.replace(/[（(]\s*(0\d{2,3})\s*[）)]\s*(\d{7,8})/g, "$1-$2");
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
    .replace(/^[：:，,。；;\s]+/u, "")
    .replace(/[，,。；;]+$/u, "");
}

function cleanMarkdownTableCell(value: string): string {
  return cleanAnswerText(
    value
      .replace(/\*\*/g, "")
      .replace(/<br\s*\/?>/gi, "、")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/\\\|/g, "|")
  );
}

function parseMarkdownTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
    return null;
  }

  return trimmed
    .slice(1, -1)
    .split("|")
    .map(cleanMarkdownTableCell);
}

function isMarkdownTableSeparator(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function questionRequestsStaffTable(question: string): boolean {
  return (
    /(清单|列表|列一?个|各个|各科室|所有|全部)/.test(question) &&
    /(科室|部门|人员|工作人员|办公地点|电话|联系方式)/.test(question)
  );
}

function questionRequestsContactList(question: string): boolean {
  return (
    /(清单|列表|列一?个|各个|各科室|所有|全部|分别|对应|有哪些)/.test(question) &&
    /(电话|联系电话|联系方式|办公电话)/.test(question)
  );
}

function normalizeContactDepartmentName(value: string): string {
  return cleanAnswerText(value)
    .replace(/^(科室|部门|名称|联系电话|办公电话|电话|联系方式)[：:]?/u, "")
    .replace(/[：:：\-–—]+$/u, "")
    .trim();
}

function isLikelyDepartmentContactName(value: string): boolean {
  if (!value || value.length > 24) {
    return false;
  }

  if (/(处长|副处长|书记|领导|校长|主任委员)/.test(value)) {
    return false;
  }

  return /(科|室|办公室|中心|大厅|部|处)$/.test(value);
}

function extractContactListAnswer(question: string, markdown: string): string | null {
  if (!questionRequestsContactList(question)) {
    return null;
  }

  const rows = markdown
    .split("\n")
    .map(parseMarkdownTableRow)
    .filter((row): row is string[] => !!row && !isMarkdownTableSeparator(row));
  const tableContacts: Array<{ department: string; phone: string }> = [];

  for (let index = 0; index < rows.length; index += 1) {
    const header = rows[index] ?? [];
    const joined = header.join("");
    if (!/(科室|部门|名称)/.test(joined) || !/(电话|联系方式)/.test(joined)) {
      continue;
    }

    const departmentIndex = header.findIndex((cell) => /(科室|部门|名称)/.test(cell));
    const phoneIndex = header.findIndex((cell) => /(办公电话|联系电话|电话|联系方式)/.test(cell));
    if (departmentIndex < 0 || phoneIndex < 0) {
      continue;
    }

    for (const row of rows.slice(index + 1)) {
      const department = normalizeContactDepartmentName(row[departmentIndex] ?? "");
      const phone = extractPhoneAnswer(row[phoneIndex] ?? "");
      if (!department || !phone || !isLikelyDepartmentContactName(department)) {
        continue;
      }
      tableContacts.push({ department, phone });
    }
  }

  const lineContacts = normalizeMarkdownLines(markdown).flatMap((line) => {
    const normalized = normalizePhoneText(line);
    const phone = extractPhoneAnswer(normalized);
    if (!phone) {
      return [];
    }

    const firstPhoneIndex = normalized.search(/0\d{2,3}-\d{7,8}/);
    if (firstPhoneIndex < 0) {
      return [];
    }

    const department = normalizeContactDepartmentName(
      normalized
        .slice(0, firstPhoneIndex)
        .replace(/联系电话|办公电话|电话|联系方式/gu, "")
        .replace(/[（(]$/u, "")
    );

    return isLikelyDepartmentContactName(department) ? [{ department, phone }] : [];
  });

  const contacts = [...tableContacts, ...lineContacts];
  const deduped = new Map<string, string>();
  for (const item of contacts) {
    if (!deduped.has(item.department)) {
      deduped.set(item.department, item.phone);
    }
  }

  if (deduped.size < 2) {
    return null;
  }

  return [
    "| 科室 | 联系电话 |",
    "| --- | --- |",
    ...[...deduped.entries()].map(([department, phone]) => `| ${department} | ${phone} |`)
  ].join("\n");
}

function extractStaffTableAnswer(question: string, markdown: string): string | null {
  if (!questionRequestsStaffTable(question)) {
    return null;
  }

  const rows = markdown
    .split("\n")
    .map(parseMarkdownTableRow)
    .filter((row): row is string[] => !!row && !isMarkdownTableSeparator(row));

  const headerIndex = rows.findIndex((row) => {
    const joined = row.join("");
    return (
      joined.includes("科室") &&
      /(办公地点|地点|地址)/.test(joined) &&
      /(办公电话|电话|联系方式)/.test(joined) &&
      /(工作人员|人员)/.test(joined)
    );
  });

  if (headerIndex < 0) {
    return null;
  }

  const header = rows[headerIndex] ?? [];
  const columnIndexes = {
    department: header.findIndex((cell) => cell.includes("科室") || cell.includes("部门")),
    location: header.findIndex((cell) => /(办公地点|地点|地址)/.test(cell)),
    phone: header.findIndex((cell) => /(办公电话|电话|联系方式)/.test(cell)),
    staff: header.findIndex((cell) => /(工作人员|人员)/.test(cell))
  };

  if (Object.values(columnIndexes).some((index) => index < 0)) {
    return null;
  }

  const bodyRows = rows
    .slice(headerIndex + 1)
    .map((row) => ({
      department: row[columnIndexes.department] ?? "",
      location: row[columnIndexes.location] ?? "",
      phone: row[columnIndexes.phone] ?? "",
      staff: row[columnIndexes.staff] ?? ""
    }))
    .filter(
      (row) =>
        row.department &&
        !row.department.includes("科室") &&
        (row.location || row.phone || row.staff)
    );

  if (bodyRows.length === 0) {
    return null;
  }

  return [
    "| 科室 | 办公地点 | 办公电话 | 工作人员 |",
    "| --- | --- | --- | --- |",
    ...bodyRows.map(
      (row) =>
        `| ${row.department} | ${row.location || "未注明"} | ${row.phone || "未注明"} | ${row.staff || "未注明"} |`
    )
  ].join("\n");
}

function extractFocusedTableAnswer(
  question: string,
  markdown: string,
  focusTerms: string[]
): string | null {
  if (focusTerms.length === 0) {
    return null;
  }

  const rows = markdown
    .split("\n")
    .map(parseMarkdownTableRow)
    .filter((row): row is string[] => !!row && !isMarkdownTableSeparator(row));

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    if (!focusTerms.some((term) => row.some((cell) => cell.includes(term)))) {
      continue;
    }

    const header = [...rows]
      .slice(0, index)
      .reverse()
      .find((candidate) => {
        const joined = candidate.join("");
        return /(科室|部门|名称)/.test(joined) && /(办公地点|地点|地址|电话|联系方式|工作人员|人员)/.test(joined);
      });

    if (!header) {
      continue;
    }

    const intent = detectQuestionIntent(question);
    const locationIndex = header.findIndex((cell) => /(办公地点|地点|地址)/.test(cell));
    const phoneIndex = header.findIndex((cell) => /(办公电话|联系电话|电话|联系方式)/.test(cell));
    const staffIndex = header.findIndex((cell) => /(工作人员|人员)/.test(cell));

    if (intent === "location" && locationIndex >= 0 && row[locationIndex]) {
      return cleanAnswerText(`办公地点：${row[locationIndex]}`);
    }

    if (intent === "phone" && phoneIndex >= 0 && row[phoneIndex]) {
      return cleanAnswerText(`联系电话：${row[phoneIndex]}`);
    }

    if (/工作人员|人员/.test(question) && staffIndex >= 0 && row[staffIndex]) {
      return cleanAnswerText(`工作人员：${row[staffIndex]}`);
    }

    if (intent === "phone") {
      const phone = extractPhoneAnswer(row.join(" "));
      if (phone) {
        return cleanAnswerText(`联系电话：${phone}`);
      }
    }
  }

  return null;
}

function extractFocusedLineAnswer(
  question: string,
  markdown: string,
  focusTerms: string[]
): string | null {
  if (focusTerms.length === 0) {
    return null;
  }

  const intent = detectQuestionIntent(question);
  const lines = normalizeMarkdownLines(markdown);
  const directIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => lineDirectlyDescribesFocusTerm(line, focusTerms))
    .map(({ index }) => index);
  const fallbackIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => lineContainsFocusTerm(line, focusTerms))
    .map(({ index }) => index)
    .filter((index) => !directIndexes.includes(index));
  const orderedIndexes = directIndexes.length > 0 ? directIndexes : fallbackIndexes;

  for (const index of orderedIndexes) {
    const line = lines[index] ?? "";
    const snippet = lines.slice(index, index + 4).filter(Boolean).join("\n");

    if (intent === "location") {
      const answer =
        extractParentheticalLocationAnswer(snippet) ??
        extractLabelValue(snippet, ["办公地点", "办公地址", "办公位置", "地点", "地址"]);
      if (answer) {
        return answer;
      }
    }

    if (intent === "phone") {
      const answer =
        extractLabelValue(snippet, ["联系电话", "办公电话", "电话", "联系方式"]) ??
        extractPhoneAnswer(line) ??
        extractPhoneAnswer(snippet);
      if (answer) {
        return cleanAnswerText(answer.startsWith("联系电话") ? answer : `联系电话：${answer}`);
      }
    }

    if (intent === "email") {
      const answer =
        extractLabelValue(snippet, ["邮箱", "Email", "电子邮箱"]) ??
        extractEmailAnswer(snippet);
      if (answer) {
        return cleanAnswerText(answer);
      }
    }
  }

  return null;
}

function extractNavigationAnswer(question: string, markdown: string): string | null {
  if (!/(首页|主页|网站).*(栏目|菜单|导航)|主要栏目|有哪些栏目/.test(question)) {
    return null;
  }

  const items = markdownLinksToNamedItems(markdown, "https://example.invalid/")
    .map((item) => item.name.trim())
    .filter((name) => /^[\u4e00-\u9fa5A-Za-z0-9（）()、-]{2,16}$/.test(name))
    .filter((name) => !/(更多|查看|搜索|上一页|下一页|学校官网|主站|返回|通知|公告标题)/.test(name));

  const seen = new Set<string>();
  const ordered = items.filter((name) => {
    if (seen.has(name)) {
      return false;
    }
    seen.add(name);
    return true;
  });

  const knownTopLevel = [
    "首页",
    "学院概况",
    "机构设置",
    "师资队伍",
    "教学工作",
    "科学研究",
    "学工工作",
    "研究生培养",
    "通知公告",
    "资料下载",
    "创新创业",
    "实验室建设",
    "党群工作",
    "对外交流",
    "规章制度",
    "部门动态",
    "中心概况",
    "信息网络服务",
    "网络安全",
    "网络安全周专题网站",
    "下载中心",
    "党风廉政建设"
  ];
  const matched = knownTopLevel.filter((item) => ordered.includes(item));
  const result = (matched.length >= 3 ? matched : ordered.slice(0, 14)).filter(Boolean);

  return result.length >= 3 ? `首页主要栏目包括：${result.join("、")}` : null;
}

function extractLinkNameAndUrl(line: string): { name: string; url: string } | null {
  const match = line.match(/\[([^\]]+)\]\(([^)]+)\)/u);
  const name = match?.[1]?.trim();
  const url = match?.[2]?.trim();
  return name && url ? { name, url } : null;
}

function extractFocusedNavigationAnswer(
  question: string,
  markdown: string,
  focusTerms: string[]
): string | null {
  if (/(电话|联系电话|联系方式|办公地点|地址|位置|工作人员|人员)/.test(question)) {
    return null;
  }

  if (!/(栏目|菜单|导航|有哪些内容|有哪些|下设|包括)/.test(question) || focusTerms.length === 0) {
    return null;
  }

  const lines = markdown.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const link = extractLinkNameAndUrl(line);
    if (!link || !focusTerms.some((term) => link.name.includes(term) || term.includes(link.name))) {
      continue;
    }

    const currentIndent = line.match(/^\s*/)?.[0].length ?? 0;
    const children: string[] = [];
    for (const childLine of lines.slice(index + 1)) {
      if (!childLine.trim()) {
        continue;
      }

      const childIndent = childLine.match(/^\s*/)?.[0].length ?? 0;
      const childLink = extractLinkNameAndUrl(childLine);
      if (!childLink) {
        continue;
      }

      if (childIndent <= currentIndent) {
        break;
      }

      if (!/(更多|查看|返回|首页|主站|学校官网)/.test(childLink.name)) {
        children.push(childLink.name);
      }
    }

    const uniqueChildren = [...new Set(children)].slice(0, 12);
    if (uniqueChildren.length >= 2) {
      return `${link.name}栏目包括：${uniqueChildren.join("、")}`;
    }
  }

  return null;
}

function extractSectionListAnswer(
  question: string,
  markdown: string,
  focusTerms: string[]
): string | null {
  if (/(电话|联系电话|联系方式|办公地点|地址|位置|工作人员|人员)/.test(question)) {
    return null;
  }

  if (!/(有哪些|内容|列表|清单|包括)/.test(question)) {
    return null;
  }

  const explicitTerms = [...question.matchAll(/(用户指南|常见故障|通知公告|部门动态|最新动态|快速通道|服务指南)/g)]
    .map((match) => match[1] ?? "")
    .filter(Boolean);
  const sectionTerms = [
    ...focusTerms.map((term) => term.replace(/(有哪些|内容|列表|清单|包括)$/g, "")),
    ...explicitTerms
  ].filter((term) => term.length >= 2);
  const uniqueTerms = [...new Set(sectionTerms)];
  if (uniqueTerms.length === 0) {
    return null;
  }

  const lines = markdown.split("\n");
  const sectionBreakPattern = /^(通知公告|部门动态|最新动态|用户指南|常见故障|快速通道|服务指南|首页|中心概况|机构设置|规章制度|网络安全)$/;

  for (let index = 0; index < lines.length; index += 1) {
    const text = cleanMarkdownTableCell(lines[index] ?? "")
      .replace(/^[*#\s]+/g, "")
      .trim();
    const matchedTerm = uniqueTerms.find((term) => text === term || text.includes(term));
    if (!matchedTerm) {
      continue;
    }

    const items: string[] = [];
    for (const line of lines.slice(index + 1)) {
      const cleanedLine = cleanMarkdownTableCell(line).replace(/^[*#\s]+/g, "").trim();
      if (items.length > 0 && sectionBreakPattern.test(cleanedLine)) {
        break;
      }

      const link = extractLinkNameAndUrl(line);
      if (!link || /更多|查看|首页|主站|返回|Chrome|Firefox|Safari|Edge/i.test(link.name)) {
        continue;
      }
      if (/!\[|图片|logo|banner/i.test(link.name)) {
        continue;
      }
      items.push(link.name);
      if (items.length >= 10) {
        break;
      }
    }

    const uniqueItems = [...new Set(items)];
    if (uniqueItems.length >= 2) {
      return `${matchedTerm}包括：${uniqueItems.join("、")}`;
    }
  }

  return null;
}

function extractFocusedLinkAnswer(
  question: string,
  markdown: string,
  baseUrl: string,
  focusTerms: string[]
): string | null {
  if (!/(入口|链接|网址|查看|介绍|页面)/.test(question) || focusTerms.length === 0) {
    return null;
  }

  for (const item of markdownLinksToNamedItems(markdown, baseUrl)) {
    if (!focusTerms.some((term) => item.name.includes(term) || term.includes(item.name))) {
      continue;
    }
    if (/^(javascript:|mailto:)/i.test(item.url)) {
      continue;
    }
    if (/!\[|图片|logo|banner/i.test(item.name) || /\.(?:jpg|jpeg|png|gif|svg|webp)(?:[?#].*)?$/i.test(item.url)) {
      continue;
    }
    return `可以在“${item.name}”页面查看：${item.url}`;
  }

  return null;
}

function extractVpnLinkAnswer(question: string, markdown: string, baseUrl: string): string | null {
  if (!/vpn/i.test(question)) {
    return null;
  }

  const link = markdownLinksToNamedItems(markdown, baseUrl)
    .filter((item) => /vpn/i.test(`${item.name} ${item.url}`) && isHtmlLikeUrl(item.url))
    .map((item) => {
      let score = 10;
      if (/VPN服务|校园VPN系统使用手册/i.test(item.name)) {
        score += 100;
      }
      if (/vpn\.cdu\.edu\.cn/i.test(item.url)) {
        score += 90;
      }
      if (/VPN常见问题/i.test(item.name)) {
        score += 60;
      }
      if (/堡垒机|运维/i.test(item.name)) {
        score -= 50;
      }
      return { item, score };
    })
    .sort((a, b) => b.score - a.score)[0]?.item;

  return link ? `可以在“${link.name}”入口找到：${link.url}` : null;
}

function extractUserGuideAnswer(question: string, markdown: string, baseUrl: string): string | null {
  if (!/用户指南/.test(question)) {
    return null;
  }

  const links = markdownLinksToNamedItems(markdown, baseUrl)
    .filter((item) => /\/info\/1035\//.test(item.url))
    .map((item) => item.name)
    .filter((name) => !/更多|查看/.test(name));
  const uniqueLinks = [...new Set(links)].slice(0, 10);

  return uniqueLinks.length >= 2 ? `用户指南包括：${uniqueLinks.join("、")}` : null;
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

function lineDirectlyDescribesFocusTerm(line: string, focusTerms: string[]): boolean {
  const normalized = line.replace(/^[*#\s|]+/g, "").trim();
  return focusTerms.some((term) => {
    const index = normalized.indexOf(term);
    if (index < 0) {
      return false;
    }
    const before = normalized.slice(0, index);
    return (
      index <= 4 ||
      /[|，,、：:\s]$/.test(before) ||
      normalized.includes(`${term}：`) ||
      normalized.includes(`${term}:`)
    ) && !/分管[^，,。；;\n]*$/.test(before);
  });
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
  const focusedTableAnswer = extractFocusedTableAnswer(question, markdown, focusTerms);
  if (focusedTableAnswer) {
    return focusedTableAnswer;
  }

  const focusedLineAnswer = extractFocusedLineAnswer(question, markdown, focusTerms);
  if (focusedLineAnswer) {
    return focusedLineAnswer;
  }

  const intent = detectQuestionIntent(question);
  const lines = normalizeMarkdownLines(markdown);
  const focusBlocks = buildFocusWindows(lines, focusTerms);

  if (focusBlocks.length === 0) {
    return null;
  }

  for (const block of focusBlocks) {
    if (intent === "location") {
      const answer =
        extractParentheticalLocationAnswer(block) ??
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
  baseUrl: string,
  focusTerms: string[]
): string | null {
  const contactListAnswer = extractContactListAnswer(question, markdown);
  if (contactListAnswer) {
    return contactListAnswer;
  }

  const focusedNavigationAnswer = extractFocusedNavigationAnswer(question, markdown, focusTerms);
  if (focusedNavigationAnswer) {
    return focusedNavigationAnswer;
  }

  const sectionListAnswer = extractSectionListAnswer(question, markdown, focusTerms);
  if (sectionListAnswer) {
    return sectionListAnswer;
  }

  const userGuideAnswer = extractUserGuideAnswer(question, markdown, baseUrl);
  if (userGuideAnswer) {
    return userGuideAnswer;
  }

  const focusedLinkAnswer = extractFocusedLinkAnswer(question, markdown, baseUrl, focusTerms);
  if (focusedLinkAnswer) {
    return focusedLinkAnswer;
  }

  const vpnLinkAnswer = extractVpnLinkAnswer(question, markdown, baseUrl);
  if (vpnLinkAnswer) {
    return vpnLinkAnswer;
  }

  const navigationAnswer = extractNavigationAnswer(question, markdown);
  if (navigationAnswer) {
    return navigationAnswer;
  }

  const focusedAnswer = extractFocusedAnswer(question, markdown, focusTerms);
  if (focusedAnswer) {
    return focusedAnswer;
  }

  if (detectQuestionIntent(question) === "location") {
    const directAnswer =
      extractParentheticalLocationAnswer(markdown) ??
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

function scoreExtractedAnswer(params: {
  question: string;
  answer: string;
  title: string;
  url: string;
  focusMatched: boolean;
  focusTerms: string[];
  kind: "staff_table" | "heuristic" | "firecrawl_json";
}): number {
  const { question, answer, title, url, focusMatched, focusTerms, kind } = params;
  const intent = detectQuestionIntent(question);
  let score = kind === "staff_table" ? 100 : kind === "heuristic" ? 70 : 50;
  const answerText = cleanAnswerText(answer);
  const pageText = `${title} ${url}`;

  if (/(机构设置|联系我们|部门简介|中心概况|科室人员|岗位职责|办公地点)/.test(pageText)) {
    score += 25;
  }

  if (/\/(?:index|default)\.htm?$|\/$/i.test(url)) {
    score -= 10;
  }

  if (focusTerms.length > 0) {
    score += focusMatched ? 15 : -25;
  }

  if (intent === "location") {
    if (/(办公地点|办公地址|办公位置)/.test(answerText)) {
      score += 25;
    }
    if (/(行政保障中心|教学楼|办公楼|实验楼|[A-Z]?\d{3,4}|[一二三四五六七八九十]楼)/.test(answerText)) {
      score += 20;
    }
    if (/(邮编|版权所有|成都市外东十陵成都大学)/.test(answerText)) {
      score -= 35;
    }
  }

  if (intent === "phone" && /0\d{2,3}-\d{7,8}/.test(answerText)) {
    score += 20;
  }

  if (intent === "email" && /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(answerText)) {
    score += 20;
  }

  return Math.max(0, Math.min(120, score));
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

  if (isContactQuestion && /(联系|关于|简介|概况|办公室|部门简介|中心简介|机构设置|科室人员|岗位职责|人员|联系我们)/.test(linkName)) {
    score += 40;
  }

  if (isContactQuestion && /(科室人员|岗位职责|jgsz|ksry|gwzz)/i.test(`${linkName} ${url}`)) {
    score += 55;
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
  const normalizedSiteName = matchedSiteName.replace(/（/g, "(").replace(/）/g, ")");
  const parentheticalFocusTerms = [...normalizedSiteName.matchAll(/\(([^)]+)\)/g)]
    .flatMap((match) => (match[1] ?? "").split(/[、,，/]/))
    .map((item) => item.trim())
    .filter((item) => item && question.includes(item) && /(科|室|中心|办公室|部门)$/.test(item));

  if (parentheticalFocusTerms.length > 0) {
    return [...new Set(parentheticalFocusTerms)];
  }

  const aliases = expandSearchNames(matchedSiteName)
    .map((item) => normalizeSearchText(item))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  for (const alias of aliases) {
    remainder = remainder.replace(alias, " ");
  }

  const cleaned = remainder
    .replace(/工资福利科/g, "劳资科")
    .replace(/(请问|麻烦|帮我|一下|告诉我|查询|查一下|列一个|清单|列表)/g, " ")
    .replace(/(在哪里|在哪|哪里|地址|位置|办公地点|办公地址|办公位置|地点)/g, " ")
    .replace(/(电话|联系电话|联系方式|号码|邮箱|电子邮箱|email)/gi, " ")
    .replace(/(是多少|是什么|有哪些|哪些|有哪个|各个|所有|全部|对应|相关|主要栏目|栏目|菜单|导航|首页|主页|网站|专业介绍|介绍|查看|页面|入口|链接|网址)/g, " ")
    .replace(/[的呢吗呀啊]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const matches = [...cleaned.matchAll(/[\u4e00-\u9fa5]{1,12}(?:科|室|中心|办公室|部门)/g)]
    .map((match) => match[0]?.trim() ?? "")
    .filter(Boolean);

  if (matches.length > 0) {
    const uniqueMatches = [...new Set(matches)];
    const hasSiteEquivalentFocus = uniqueMatches.every((term) =>
      aliases.some((alias) => scoreSiteMatch(alias, term) >= 45 || scoreSiteMatch(term, alias) >= 45)
    );

    return hasSiteEquivalentFocus ? [] : uniqueMatches;
  }

  if (cleaned && cleaned.length >= 2 && cleaned.length <= 12) {
    const isEquivalentToSite = aliases.some(
      (alias) => scoreSiteMatch(alias, cleaned) >= 45 || scoreSiteMatch(cleaned, alias) >= 45
    );
    return isEquivalentToSite ? [] : [cleaned];
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

function answerMatchesFocusTerms(answer: string, focusTerms: string[]): boolean {
  if (focusTerms.length === 0) {
    return true;
  }

  return focusTerms.some((term) => {
    if (answer.includes(term)) {
      return true;
    }
    if (/vpn/i.test(term) && /vpn/i.test(answer)) {
      return true;
    }
    const compact = term.replace(/(专业介绍|专业|介绍|查看|页面|入口|链接|网址|内容)$/g, "").trim();
    return compact.length >= 2 && answer.includes(compact);
  });
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
  private readonly memory?: MarkdownMemoryService;
  private readonly catalogService: CduCatalogService;
  private readonly pageQaService: CduPageQaService;
  private readonly cache = new Map<string, { expiresAt: number; value: unknown }>();

  constructor(options: FirecrawlApiAdapterOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.cacheTtlMs = options.cacheTtlMs ?? 30 * 60 * 1000;
    this.maxDiscoveryDepth = Math.max(0, options.maxDiscoveryDepth ?? 2);
    this.maxDiscoveryPages = Math.max(1, options.maxDiscoveryPages ?? 8);
    this.memory = options.memoryFilePath
      ? new MarkdownMemoryService({
          filePath: options.memoryFilePath,
          cacheTtlMs: options.memoryCacheTtlMs
        })
      : undefined;
    this.catalogService = new CduCatalogService();
    this.pageQaService = new CduPageQaService();
  }

  async getOrgStructure(): Promise<OrganizationStructure> {
    return this.withCache("org-structure", async () => {
      return this.catalogService.buildOrgStructure({
        orgUrl: ORG_URL,
        scrape: () =>
          this.scrape(ORG_URL, [
            {
              type: "json",
              schema: ORG_SCHEMA,
              prompt:
                "提取成都大学组织机构页面中的一级分组和每个分组下的机构名称、链接。"
            },
            "markdown"
          ]),
        parseGroupsFromJson: (payload) => mapOrganizationGroups(payload),
        parseGroupsFromMarkdown: (markdown) => parseOrganizationMarkdown(markdown),
        fetchOrgHtml: () => this.fetchPageHtml(ORG_URL),
        parseGroupsFromHtml: (html) => parseOrganizationHtml(html),
        nowIso
      });
    });
  }

  async getDepartments(): Promise<DepartmentsResult> {
    return this.withCache("departments", async () => {
      return this.catalogService.buildDepartments({
        deptUrl: DEPT_URL,
        scrapeJson: () =>
          this.scrape(DEPT_URL, [
            {
              type: "json",
              schema: DEPARTMENT_SCHEMA,
              prompt:
                "提取成都大学院系设置页面中的院系、研究院、附属单位名称及其官网或二级网站链接。category 取值如 学院、研究院、附属单位、其他。"
            }
          ]),
        scrapeMarkdown: () => this.scrape(DEPT_URL, ["markdown"]),
        parseDepartmentsFromJson: (payload) => parseDepartmentJson(payload),
        parseDepartmentsFromMarkdown: (markdown) => parseDepartmentMarkdown(markdown),
        nowIso
      });
    });
  }

  async getSiteCatalog(): Promise<SiteCatalogResult> {
    return this.withCache("site-catalog", async () => {
      const [org, departments] = await Promise.all([
        this.getOrgStructure(),
        this.getDepartments()
      ]);
      return this.catalogService.buildSiteCatalog({
        orgUrl: ORG_URL,
        deptUrl: DEPT_URL,
        org,
        departments,
        toCatalogSite,
        fetchOrgHtml: () => this.fetchPageHtml(ORG_URL),
        parseSupplementalOrgLinksFromHtml: (html) => parseSupplementalOrgLinksFromHtml(html),
        dedupeCatalogSites,
        urlLooksSuspicious,
        nowIso
      });
    });
  }

  async findSite(keyword: string): Promise<SiteSearchResult> {
    const catalog = await this.getSiteCatalog();
    return this.catalogService.findSite(catalog, keyword, scoreCatalogSiteMatch);
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
      const payloadImportantLinks =
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
          : [];
      const markdownImportantLinks = markdownLinksToNamedItems(
        response.data?.markdown ?? "",
        target.website_url
      )
        .filter((link) => isSameSiteUrl(link.url, target.website_url) && isHtmlLikeUrl(link.url))
        .slice(0, 30);
      const importantLinks =
        payloadImportantLinks.length > 0
          ? [...payloadImportantLinks, ...markdownImportantLinks]
          : markdownImportantLinks;

      return {
        site_name: target.name,
        website_url: target.website_url,
        title,
        summary,
        important_links: dedupeByNameAndUrl(importantLinks).slice(0, 20),
        markdown_excerpt: markdownExcerpt(response.data?.markdown ?? ""),
        source_url: target.website_url,
        fetched_at: nowIso()
      };
    });
  }

  async getMemoryCandidates(question: string, siteName?: string): Promise<MemoryMatchResult[]> {
    const target = siteName ? await this.resolveSite(siteName) : await this.inferSiteFromQuestion(question);
    const candidates = await this.findMemoryCandidates(question);
    if (!target) {
      return candidates;
    }
    return candidates.filter((candidate) => memoryMatchBelongsToSite(candidate.entryTitle, target));
  }

  async askSite(
    question: string,
    siteName?: string,
    options?: {
      skipMemory?: boolean;
    }
  ): Promise<SiteAnswerResult> {
    return this.withCache(`site-answer:${siteName ?? ""}:${question}`, async () => {
      if (/(成都大学|学校).*(有哪些|哪些).*(二级学院|院系)|有哪些(二级学院|院系)/.test(question)) {
        const departments = await this.getDepartments();
        const names = departments.departments
          .filter((item) => item.category === "学院")
          .map((item) => item.name);

        return {
          question,
          answered: names.length > 0,
          answer:
            names.length > 0
              ? `成都大学二级学院包括：${names.join("、")}`
              : "未能从院系设置目录中提取到二级学院列表。",
          evidence: `来源：${DEPT_URL}`,
          analysis_steps: [
            `收到问题：${question}`,
            "问题询问学校二级学院/院系列表，直接读取成都大学院系设置目录。",
            `从目录中提取到 ${names.length} 个学院条目。`
          ],
          matched_site: null,
          source_urls: [DEPT_URL],
          fetched_at: nowIso()
        };
      }

      const target = siteName ? await this.resolveSite(siteName) : await this.inferSiteFromQuestion(question);
      const memoryMatch = options?.skipMemory ? null : await this.findAnswerInMemory(question);
      if (memoryMatch && (!target || memoryMatchBelongsToSite(memoryMatch.entryTitle, target))) {
        return this.buildMemoryAnswerResult(question, memoryMatch);
      }

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

      return this.pageQaService.askSiteQuestion({
        question,
        target,
        maxDiscoveryDepth: this.maxDiscoveryDepth,
        maxDiscoveryPages: this.maxDiscoveryPages,
        getSiteContent: (siteName) => this.getSiteContent(siteName),
        extractQuestionFocusTerms,
        selectCandidateUrls: (nextQuestion, siteUrl, links, focusTerms) =>
          this.selectCandidateUrls(nextQuestion, siteUrl, links, focusTerms),
        scoreQuestionLink,
        answerFromPage: (url, nextQuestion, matchedSite, focusTerms) =>
          this.answerFromPage(url, nextQuestion, matchedSite, focusTerms),
        nowIso
      });
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

  private async findMemoryCandidates(question: string): Promise<MemoryMatchResult[]> {
    if (!this.memory) {
      return [];
    }

    try {
      return await this.memory.findCandidates(question, 5);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[cdufireseach] memory candidate lookup failed: ${message}`);
      return [];
    }
  }

  private async findAnswerInMemory(question: string): Promise<MemoryMatchResult | null> {
    if (!this.memory) {
      return null;
    }

    try {
      return await this.memory.findAnswer(question);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[cdufireseach] memory lookup failed: ${message}`);
      return null;
    }
  }

  private buildMemoryAnswerResult(
    question: string,
    memoryMatch: MemoryMatchResult
  ): SiteAnswerResult {
    return {
      question,
      answered: true,
      answer: memoryMatch.answer,
      evidence: memoryMatch.evidence,
      analysis_steps: [
        `收到问题：${question}`,
        `长期记忆库匹配策略：${memoryMatch.strategy}（意图：${memoryMatch.intent}，条目：${memoryMatch.entryTitle}）`,
        "命中长期记忆库，未触发实时抓取。"
      ],
      matched_site: null,
      source_urls: memoryMatch.sourceUrls,
      fetched_at: nowIso()
    };
  }

  private selectCandidateUrls(
    question: string,
    siteUrl: string,
    links: LinkItem[],
    focusTerms: string[]
  ): string[] {
    const urlMap = new Map<string, number>();
    const isContactQuestion = /(在哪|地址|位置|电话|邮箱|联系|办公室)/.test(question);
    // Contact/location answers are often on "机构设置/联系我们" pages rather than
    // the homepage footer, so keep the homepage in the queue but do not let it
    // outrank more specific navigation links.
    urlMap.set(siteUrl, isContactQuestion ? 30 : 50);

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
    const staffTableAnswer = extractStaffTableAnswer(
      question,
      response.data?.markdown ?? ""
    );
    const focusMatched = pageMatchesFocusTerms(
      response.data?.markdown ?? "",
      title,
      focusTerms
    );
    const heuristicAnswer = extractHeuristicAnswer(
      question,
      response.data?.markdown ?? "",
      url,
      focusTerms
    );
    const heuristicFocusMatched = heuristicAnswer
      ? focusMatched || answerMatchesFocusTerms(heuristicAnswer, focusTerms)
      : false;
    const discoveredLinks = markdownLinksToNamedItems(
      response.data?.markdown ?? "",
      url
    )
      .filter((link) => isSameSiteUrl(link.url, matchedSite.website_url) && isHtmlLikeUrl(link.url))
      .slice(0, 20);

    if (staffTableAnswer) {
      return {
        answered: true,
        answer: staffTableAnswer,
        answerScore: scoreExtractedAnswer({
          question,
          answer: staffTableAnswer,
          title,
          url,
          focusMatched: true,
          focusTerms,
          kind: "staff_table"
        }),
        evidence: `从页面正文表格中提取到科室、办公地点、办公电话和工作人员清单。`,
        analysisStep: `已检查页面《${title}》(${url})，并从页面表格中提取到科室办公地点、电话和工作人员清单。`,
        sourceUrl: url,
        discoveredLinks
      };
    }

    if (heuristicAnswer && heuristicFocusMatched) {
      return {
        answered: true,
        answer: heuristicAnswer,
        answerScore: scoreExtractedAnswer({
          question,
          answer: heuristicAnswer,
          title,
          url,
          focusMatched: heuristicFocusMatched,
          focusTerms,
          kind: "heuristic"
        }),
        evidence: `从页面正文中提取到与问题直接相关的信息：${heuristicAnswer}`,
        analysisStep: `已检查页面《${title}》(${url})，并通过页面正文中的地址/联系方式字段提取到直接答案。`,
        sourceUrl: url,
        discoveredLinks
      };
    }

    const jsonAnswerUsable =
      answered &&
      !!answer &&
      (focusTerms.length === 0 || focusMatched || answerMatchesFocusTerms(answer, focusTerms));

    return {
      answered: jsonAnswerUsable,
      answer: answer ?? "当前页面没有明确答案。",
      answerScore:
        jsonAnswerUsable && answer
          ? scoreExtractedAnswer({
              question,
              answer,
              title,
              url,
              focusMatched,
              focusTerms,
              kind: "firecrawl_json"
            })
          : 0,
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
