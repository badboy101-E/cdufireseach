import { readFile, writeFile } from "node:fs/promises";

export type QuestionIntent = "location" | "phone" | "email" | "generic";
export type MemoryMatchStrategy = "standard_question" | "normalized_question" | "entity_intent";
export type MemoryConfidence = "high" | "medium" | "low";
export type MemoryWriteMode = "auto_verified" | "candidate_review" | "manual";

type MemoryEntry = {
  sectionTitle: string;
  title: string;
  standardQuestions: string[];
  aliases: string[];
  keywords: string[];
  answers: {
    location?: string;
    phone?: string;
    email?: string;
    generic?: string;
  };
  sourceSite?: string;
  sourcePage?: string;
  sourceExcerpt?: string;
  lastVerifiedAt?: string;
  confidence?: MemoryConfidence;
  writeMode?: MemoryWriteMode;
};

export type MemoryEntryDraft = {
  sectionTitle?: string;
  title: string;
  standardQuestions: string[];
  aliases?: string[];
  keywords?: string[];
  answers: {
    location?: string;
    phone?: string;
    email?: string;
    generic?: string;
  };
  sourceSite?: string;
  sourcePage?: string;
  sourceExcerpt?: string;
  lastVerifiedAt?: string;
  confidence?: MemoryConfidence;
  writeMode?: MemoryWriteMode;
};

export type MemoryMatchResult = {
  entryTitle: string;
  answer: string;
  evidence: string;
  sourceUrls: string[];
  strategy: MemoryMatchStrategy;
  intent: QuestionIntent;
};

type MarkdownMemoryServiceOptions = {
  filePath: string;
  cacheTtlMs?: number;
};

type MarkdownMemoryStoreOptions = {
  filePath: string;
  documentTitle: string;
  usageNotes: string[];
  defaultSectionTitle: string;
};

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[？?！!。.,，、:：;；'"“”‘’()（）【】\[\]<>《》]/g, "")
    .trim();
}

function normalizeQuestionForMatch(question: string): string {
  const normalized = normalizeText(question);
  return normalized
    .replace(/(请问|一下|下|呢|啊|呀|吧|嘛|有没有|是多少|多少|在哪里|在哪儿|在哪|位于哪里|位置在哪|位置|地址|办公地点|办公地址|办公位置|电话|联系电话|联系方式|号码|邮箱|电子邮箱|email|邮件|是什么|是哪里)/g, "")
    .trim();
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function splitByFirstColon(value: string): { label: string; content: string } | null {
  const match = value.match(/^([^：:]{1,20})[：:]\s*(.+)$/u);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return {
    label: match[1].trim(),
    content: match[2].trim()
  };
}

function isLocationLabel(label: string): boolean {
  return /(办公地点|办公地址|办公位置|地点|位置|地址)/.test(label);
}

function isPhoneLabel(label: string): boolean {
  return /(电话|联系电话|联系方式|联系号码|号码)/.test(label);
}

function isEmailLabel(label: string): boolean {
  return /(邮箱|电子邮箱|email|邮件)/i.test(label);
}

function normalizeSectionName(value: string): string {
  return normalizeText(value);
}

function withLabelIfNeeded(label: string, value: string | undefined): string | null {
  if (!value?.trim()) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.includes("：") || trimmed.includes(":") ? trimmed : `${label}：${trimmed}`;
}

function applySourceField(entry: MemoryEntry, rawValue: string): void {
  const parsed = splitByFirstColon(rawValue);
  if (!parsed) {
    return;
  }

  const label = parsed.label;
  const content = parsed.content;
  if (/(站点|官网|网站)/.test(label)) {
    entry.sourceSite = content;
    return;
  }
  if (/(页面|来源页|来源页面)/.test(label)) {
    entry.sourcePage = content;
    return;
  }
  if (/(最后核验时间|核验时间|更新时间)/.test(label)) {
    entry.lastVerifiedAt = content;
  }
}

function applyMetadataField(entry: MemoryEntry, rawValue: string): void {
  const parsed = splitByFirstColon(rawValue);
  if (!parsed) {
    return;
  }

  const label = parsed.label;
  const content = parsed.content;
  if (/置信度/.test(label) && /^(high|medium|low)$/i.test(content)) {
    entry.confidence = content.toLowerCase() as MemoryConfidence;
    return;
  }
  if (/写入方式/.test(label) && /^(auto_verified|candidate_review|manual)$/i.test(content)) {
    entry.writeMode = content.toLowerCase() as MemoryWriteMode;
  }
}

function addLabeledAnswer(entry: MemoryEntry, rawValue: string): void {
  const parsed = splitByFirstColon(rawValue);
  if (!parsed) {
    if (!entry.answers.generic) {
      entry.answers.generic = rawValue.trim();
    }
    return;
  }

  const { label, content } = parsed;
  if (isLocationLabel(label)) {
    entry.answers.location = content;
    return;
  }
  if (isPhoneLabel(label)) {
    entry.answers.phone = content;
    return;
  }
  if (isEmailLabel(label)) {
    entry.answers.email = content;
    return;
  }

  if (!entry.answers.generic) {
    entry.answers.generic = `${label}：${content}`;
  }
}

function parseMemoryMarkdown(markdown: string): MemoryEntry[] {
  const lines = markdown.split("\n");
  const entries: MemoryEntry[] = [];
  let currentEntry: MemoryEntry | null = null;
  let currentSection = "";
  let currentTopLevelSection = "未分类";

  const pushCurrentEntry = () => {
    if (!currentEntry) {
      return;
    }
    currentEntry.standardQuestions = dedupe(currentEntry.standardQuestions);
    currentEntry.aliases = dedupe(currentEntry.aliases);
    currentEntry.keywords = dedupe(currentEntry.keywords);
    entries.push(currentEntry);
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const topHeading = line.match(/^##\s+(.+)$/u);
    if (topHeading?.[1]) {
      currentTopLevelSection = topHeading[1].trim();
      continue;
    }

    const entryHeading = line.match(/^###\s+(.+)$/u);
    if (entryHeading?.[1]) {
      pushCurrentEntry();
      currentEntry = {
        sectionTitle: currentTopLevelSection,
        title: entryHeading[1].trim(),
        standardQuestions: [],
        aliases: [],
        keywords: [],
        answers: {}
      };
      currentSection = "";
      continue;
    }

    if (!currentEntry) {
      continue;
    }

    const sectionHeading = line.match(/^####\s+(.+)$/u);
    if (sectionHeading?.[1]) {
      currentSection = normalizeSectionName(sectionHeading[1]);
      continue;
    }

    const bulletLine = line.match(/^-\s+(.+)$/u);
    if (!bulletLine?.[1]) {
      continue;
    }

    const value = bulletLine[1].trim();

    if (currentSection.includes("标准问法")) {
      currentEntry.standardQuestions.push(value);
      continue;
    }

    if (currentSection.includes("别名")) {
      currentEntry.aliases.push(value);
      continue;
    }

    if (currentSection.includes("匹配关键词")) {
      currentEntry.keywords.push(value);
      continue;
    }

    if (currentSection.includes("标准答案") || currentSection.includes("附加信息")) {
      addLabeledAnswer(currentEntry, value);
      continue;
    }

    if (currentSection.includes("来源摘录")) {
      currentEntry.sourceExcerpt = currentEntry.sourceExcerpt
        ? `${currentEntry.sourceExcerpt} ${value}`
        : value;
      continue;
    }

    if (currentSection.includes("来源")) {
      applySourceField(currentEntry, value);
      continue;
    }

    if (currentSection.includes("元数据")) {
      applyMetadataField(currentEntry, value);
    }
  }

  pushCurrentEntry();
  return entries;
}

function renderBulletLines(items: string[]): string[] {
  return items.filter(Boolean).map((item) => `- ${item}`);
}

function renderEntry(entry: MemoryEntry): string {
  const lines: string[] = [`### ${entry.title}`, "", "#### 标准问法", ""];

  lines.push(
    ...renderBulletLines(entry.standardQuestions.length > 0 ? entry.standardQuestions : [`${entry.title}是什么？`]),
    "",
    "#### 别名",
    "",
    ...renderBulletLines(entry.aliases.length > 0 ? entry.aliases : splitAliasesFromTitle(entry.title)),
    "",
    "#### 匹配关键词",
    "",
    ...renderBulletLines(entry.keywords.length > 0 ? entry.keywords : splitAliasesFromTitle(entry.title)),
    "",
    "#### 标准答案",
    ""
  );

  const answerLines = [
    withLabelIfNeeded("办公地点", entry.answers.location),
    withLabelIfNeeded("联系电话", entry.answers.phone),
    withLabelIfNeeded("邮箱", entry.answers.email),
    entry.answers.generic?.trim() || null
  ].filter((item): item is string => Boolean(item));
  lines.push(...renderBulletLines(answerLines), "", "#### 附加信息", "");

  const extraInfo = [
    entry.answers.location && !answerLines.includes(withLabelIfNeeded("办公地点", entry.answers.location) ?? "")
      ? withLabelIfNeeded("办公地点", entry.answers.location)
      : null,
    entry.answers.phone && !answerLines.includes(withLabelIfNeeded("联系电话", entry.answers.phone) ?? "")
      ? withLabelIfNeeded("联系电话", entry.answers.phone)
      : null,
    entry.answers.email && !answerLines.includes(withLabelIfNeeded("邮箱", entry.answers.email) ?? "")
      ? withLabelIfNeeded("邮箱", entry.answers.email)
      : null
  ].filter((item): item is string => Boolean(item));
  lines.push(...renderBulletLines(extraInfo), "", "#### 来源", "");

  const sourceLines = [
    entry.sourceSite ? `站点：${entry.sourceSite}` : null,
    entry.sourcePage ? `页面：${entry.sourcePage}` : null,
    entry.lastVerifiedAt ? `最后核验时间：${entry.lastVerifiedAt}` : null
  ].filter((item): item is string => Boolean(item));
  lines.push(...renderBulletLines(sourceLines), "", "#### 来源摘录", "");

  if (entry.sourceExcerpt?.trim()) {
    lines.push(`- ${entry.sourceExcerpt.trim()}`);
  }

  lines.push("", "#### 元数据", "");
  const metadataLines = [
    entry.confidence ? `置信度：${entry.confidence}` : null,
    entry.writeMode ? `写入方式：${entry.writeMode}` : null
  ].filter((item): item is string => Boolean(item));
  lines.push(...renderBulletLines(metadataLines), "");

  return lines.join("\n");
}

function renderMemoryMarkdownDocument(params: {
  documentTitle: string;
  usageNotes: string[];
  entries: MemoryEntry[];
  defaultSectionTitle: string;
}): string {
  const lines: string[] = [`# ${params.documentTitle}`, "", "## 使用说明", ""];
  lines.push(...renderBulletLines(params.usageNotes), "");

  const grouped = new Map<string, MemoryEntry[]>();
  for (const entry of params.entries) {
    const key = entry.sectionTitle?.trim() || params.defaultSectionTitle;
    const group = grouped.get(key) ?? [];
    group.push(entry);
    grouped.set(key, group);
  }

  for (const [sectionTitle, entries] of grouped.entries()) {
    lines.push(`## ${sectionTitle}`, "");
    for (const entry of entries) {
      lines.push(renderEntry(entry));
    }
  }

  return lines.join("\n").trimEnd() + "\n";
}

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

function resolveAnswer(entry: MemoryEntry, intent: QuestionIntent): string | null {
  if (intent === "location") {
    return withLabelIfNeeded("办公地点", entry.answers.location) ?? entry.answers.generic ?? null;
  }

  if (intent === "phone") {
    return withLabelIfNeeded("联系电话", entry.answers.phone) ?? entry.answers.generic ?? null;
  }

  if (intent === "email") {
    return withLabelIfNeeded("邮箱", entry.answers.email) ?? entry.answers.generic ?? null;
  }

  return (
    entry.answers.generic ??
    withLabelIfNeeded("办公地点", entry.answers.location) ??
    withLabelIfNeeded("联系电话", entry.answers.phone) ??
    withLabelIfNeeded("邮箱", entry.answers.email) ??
    null
  );
}

function buildEvidence(entry: MemoryEntry): string {
  const evidenceParts: string[] = [`命中长期记忆库条目「${entry.title}」`];

  if (entry.sourcePage) {
    evidenceParts.push(`来源页面：${entry.sourcePage}`);
  }
  if (entry.lastVerifiedAt) {
    evidenceParts.push(`最后核验时间：${entry.lastVerifiedAt}`);
  }

  return evidenceParts.join("；");
}

function splitAliasesFromTitle(title: string): string[] {
  const normalized = title
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/[【\[]/g, "(")
    .replace(/[】\]]/g, ")");
  const results = new Set<string>([title.trim(), normalized.trim()]);

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

  return [...results].filter(Boolean);
}

function entryTerms(entry: MemoryEntry): string[] {
  return dedupe([...splitAliasesFromTitle(entry.title), ...entry.aliases, ...entry.keywords]);
}

function collectSourceUrls(entry: MemoryEntry): string[] {
  return dedupe([entry.sourcePage ?? "", entry.sourceSite ?? ""]).filter((item) =>
    /^https?:\/\//.test(item)
  );
}

function mergeEntry(existing: MemoryEntry | undefined, draft: MemoryEntryDraft, defaultSectionTitle: string): MemoryEntry {
  return {
    sectionTitle: draft.sectionTitle?.trim() || existing?.sectionTitle || defaultSectionTitle,
    title: draft.title.trim(),
    standardQuestions: dedupe([...(existing?.standardQuestions ?? []), ...draft.standardQuestions]),
    aliases: dedupe([...(existing?.aliases ?? []), ...(draft.aliases ?? [])]),
    keywords: dedupe([...(existing?.keywords ?? []), ...(draft.keywords ?? [])]),
    answers: {
      location: draft.answers.location ?? existing?.answers.location,
      phone: draft.answers.phone ?? existing?.answers.phone,
      email: draft.answers.email ?? existing?.answers.email,
      generic: draft.answers.generic ?? existing?.answers.generic
    },
    sourceSite: draft.sourceSite ?? existing?.sourceSite,
    sourcePage: draft.sourcePage ?? existing?.sourcePage,
    sourceExcerpt: draft.sourceExcerpt ?? existing?.sourceExcerpt,
    lastVerifiedAt: draft.lastVerifiedAt ?? existing?.lastVerifiedAt,
    confidence: draft.confidence ?? existing?.confidence,
    writeMode: draft.writeMode ?? existing?.writeMode
  };
}

export class MarkdownMemoryService {
  private readonly filePath: string;
  private readonly cacheTtlMs: number;
  private cacheExpiresAt = 0;
  private cacheEntries: MemoryEntry[] = [];

  constructor(options: MarkdownMemoryServiceOptions) {
    this.filePath = options.filePath;
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60 * 1000;
  }

  async findAnswer(question: string): Promise<MemoryMatchResult | null> {
    const candidates = await this.findCandidates(question, 1);
    return candidates[0] ?? null;
  }

  async findCandidates(question: string, maxCandidates = 5): Promise<MemoryMatchResult[]> {
    const entries = await this.loadEntries();
    if (entries.length === 0) {
      return [];
    }

    const intent = detectQuestionIntent(question);
    const exactQuestion = question.trim();
    const normalizedQuestion = normalizeText(question);
    const compactQuestion = normalizeQuestionForMatch(question);
    const results: MemoryMatchResult[] = [];
    const seen = new Set<string>();

    const pushResult = (result: MemoryMatchResult | null) => {
      if (!result) {
        return;
      }
      const key = `${result.entryTitle}::${result.intent}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      results.push(result);
    };

    for (const entry of entries) {
      const matched = entry.standardQuestions.find(
        (candidate) => candidate.trim() === exactQuestion || normalizeText(candidate) === normalizedQuestion
      );
      if (!matched) {
        continue;
      }

      const answer = resolveAnswer(entry, intent);
      if (!answer) {
        continue;
      }

      pushResult({
        entryTitle: entry.title,
        answer,
        evidence: buildEvidence(entry),
        sourceUrls: collectSourceUrls(entry),
        strategy: "standard_question",
        intent
      });
    }

    if (compactQuestion) {
      for (const entry of entries) {
        const candidates = [...entry.standardQuestions, ...entry.aliases, ...entry.keywords];
        const matched = candidates.some(
          (candidate) => normalizeQuestionForMatch(candidate) === compactQuestion
        );
        if (!matched) {
          continue;
        }

        const answer = resolveAnswer(entry, intent);
        if (!answer) {
          continue;
        }

        pushResult({
          entryTitle: entry.title,
          answer,
          evidence: buildEvidence(entry),
          sourceUrls: collectSourceUrls(entry),
          strategy: "normalized_question",
          intent
        });
      }
    }

    if (intent === "generic") {
      return results.slice(0, maxCandidates);
    }

    const normalizedHaystack = normalizeText(question);
    const scoredEntries: Array<{ entry: MemoryEntry; score: number }> = [];

    for (const entry of entries) {
      const terms = entryTerms(entry)
        .map((term) => normalizeText(term))
        .filter(Boolean);
      if (terms.length === 0) {
        continue;
      }

      const matchedTerm = terms
        .filter((term) => normalizedHaystack.includes(term))
        .sort((a, b) => b.length - a.length)[0];

      if (!matchedTerm) {
        continue;
      }

      scoredEntries.push({
        entry,
        score: matchedTerm.length
      });
    }

    for (const item of scoredEntries.sort((a, b) => b.score - a.score)) {
      const answer = resolveAnswer(item.entry, intent);
      if (!answer) {
        continue;
      }

      pushResult({
        entryTitle: item.entry.title,
        answer,
        evidence: buildEvidence(item.entry),
        sourceUrls: collectSourceUrls(item.entry),
        strategy: "entity_intent",
        intent
      });
    }

    return results.slice(0, maxCandidates);
  }

  private async loadEntries(): Promise<MemoryEntry[]> {
    if (Date.now() < this.cacheExpiresAt) {
      return this.cacheEntries;
    }

    try {
      const raw = await readFile(this.filePath, "utf8");
      this.cacheEntries = parseMemoryMarkdown(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.cacheEntries = [];
      } else {
        throw error;
      }
    }

    this.cacheExpiresAt = Date.now() + this.cacheTtlMs;
    return this.cacheEntries;
  }
}

export class MarkdownMemoryStore {
  private readonly filePath: string;
  private readonly documentTitle: string;
  private readonly usageNotes: string[];
  private readonly defaultSectionTitle: string;

  constructor(options: MarkdownMemoryStoreOptions) {
    this.filePath = options.filePath;
    this.documentTitle = options.documentTitle;
    this.usageNotes = options.usageNotes;
    this.defaultSectionTitle = options.defaultSectionTitle;
  }

  async upsertEntry(draft: MemoryEntryDraft): Promise<void> {
    const entries = await this.loadEntries();
    const normalizedTitle = normalizeText(draft.title);
    const existingIndex = entries.findIndex((entry) => normalizeText(entry.title) === normalizedTitle);
    const merged = mergeEntry(existingIndex >= 0 ? entries[existingIndex] : undefined, draft, this.defaultSectionTitle);

    if (existingIndex >= 0) {
      entries[existingIndex] = merged;
    } else {
      entries.push(merged);
    }

    const rendered = renderMemoryMarkdownDocument({
      documentTitle: this.documentTitle,
      usageNotes: this.usageNotes,
      entries,
      defaultSectionTitle: this.defaultSectionTitle
    });
    await writeFile(this.filePath, rendered, "utf8");
  }

  private async loadEntries(): Promise<MemoryEntry[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return parseMemoryMarkdown(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }
}
