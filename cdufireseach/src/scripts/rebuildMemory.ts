import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ArkChatClient } from "../llm/arkChatClient.js";
import { MemoryCurationService } from "../services/memoryCurationService.js";
import type { SiteAnswerResult } from "../types.js";

const cwd = process.cwd();
const localEnvPath = resolve(cwd, ".env");
if (typeof process.loadEnvFile === "function" && existsSync(localEnvPath)) {
  process.loadEnvFile(localEnvPath);
}

const apiBaseUrl = process.env.CDU_REBUILD_API_URL ?? "http://127.0.0.1:3100";
const formalMemoryFile =
  process.env.CDU_MEMORY_FILE_PATH ?? resolve(cwd, "../cdufireseach-memory.md");
const candidateMemoryFile =
  process.env.CDU_MEMORY_CANDIDATE_FILE_PATH ??
  resolve(cwd, "../cdufireseach-memory-candidates.md");
const backupDir = resolve(cwd, "../memory-backups");
const llmBaseUrl = process.env.CDU_LLM_BASE_URL ?? "";
const llmApiKey = process.env.CDU_LLM_API_KEY ?? "";
const llmModel = process.env.CDU_LLM_MODEL ?? "";
const llmTemperature = Number.parseFloat(process.env.CDU_LLM_TEMPERATURE ?? "0.2");

const seedQuestions = [
  "网络信息中心在哪里？",
  "网络信息中心的电话号码是多少？",
  "网络信息中心邮箱是多少？",
  "人事处人事科在哪里？",
  "人事处人事科电话是多少？"
];

function timestampForFile(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function buildFormalTemplate(): string {
  return [
    "# cdufireseach 长期记忆库",
    "",
    "## 使用说明",
    "",
    "- 本文件用于维护高频、稳定、人工核验或高置信度自动核验过的问答条目。",
    "- 当前优先覆盖：办公地点、电话、邮箱。",
    "- 高置信度且字段明确的条目可由系统自动写入。",
    ""
  ].join("\n");
}

function buildCandidateTemplate(): string {
  return [
    "# cdufireseach 候选记忆库",
    "",
    "## 使用说明",
    "",
    "- 本文件用于保存 LLM 根据实时抓取结果生成的候选记忆条目。",
    "- 中低置信度或字段边界不够稳定的条目会先写入这里，待人工审核后再进入正式记忆库。",
    "- 当前优先覆盖：办公地点、电话、邮箱。",
    "",
    "## 待审核候选条目",
    ""
  ].join("\n");
}

async function backupIfExists(path: string, targetName: string): Promise<void> {
  if (!existsSync(path)) {
    return;
  }
  const content = await readFile(path, "utf8");
  await writeFile(resolve(backupDir, targetName), content, "utf8");
}

async function ask(question: string): Promise<SiteAnswerResult> {
  const response = await fetch(`${apiBaseUrl}/api/ask`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ question })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ask failed (${response.status}): ${errorText.slice(0, 500)}`);
  }

  return (await response.json()) as SiteAnswerResult;
}

async function main(): Promise<void> {
  if (!llmBaseUrl || !llmApiKey || !llmModel) {
    throw new Error("Missing CDU_LLM_BASE_URL / CDU_LLM_API_KEY / CDU_LLM_MODEL in .env");
  }

  await mkdir(backupDir, { recursive: true });
  const stamp = timestampForFile();
  await backupIfExists(formalMemoryFile, `cdufireseach-memory.${stamp}.bak.md`);
  await backupIfExists(candidateMemoryFile, `cdufireseach-memory-candidates.${stamp}.bak.md`);

  await writeFile(formalMemoryFile, buildFormalTemplate(), "utf8");
  await writeFile(candidateMemoryFile, buildCandidateTemplate(), "utf8");

  const llmClient = new ArkChatClient({
    baseUrl: llmBaseUrl,
    apiKey: llmApiKey,
    model: llmModel,
    temperature: Number.isFinite(llmTemperature) ? llmTemperature : 0.2
  });

  const curationService = new MemoryCurationService(llmClient, {
    formalFilePath: formalMemoryFile,
    candidateFilePath: candidateMemoryFile,
    enabled: true
  });

  for (const question of seedQuestions) {
    const result = await ask(question);
    const persisted = await curationService.maybePersist(question, result);
    const summary = persisted
      ? `${persisted.target}:${persisted.confidence}:${persisted.title}`
      : "skipped";
    console.log(`[rebuild-memory] ${question} -> ${summary}`);
  }

  console.log("[rebuild-memory] completed");
}

main().catch((error) => {
  console.error("[rebuild-memory] failed:", error);
  process.exit(1);
});
