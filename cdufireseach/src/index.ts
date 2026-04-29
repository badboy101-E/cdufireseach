import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { FirecrawlApiAdapter } from "./firecrawl/apiAdapter.js";
import type { FirecrawlAdapter } from "./firecrawl/adapter.js";
import { ArkChatClient } from "./llm/arkChatClient.js";
import { registerAskRoute } from "./routes/askRoute.js";
import { CduQaService } from "./services/cduQaService.js";
import { MemoryCurationService } from "./services/memoryCurationService.js";
import { registerTools } from "./tools.js";

const SERVER_NAME = "cdufireseach";
const SERVER_VERSION = "0.1.0";
const localEnvPath = resolve(process.cwd(), ".env");

if (typeof process.loadEnvFile === "function" && existsSync(localEnvPath)) {
  process.loadEnvFile(localEnvPath);
}

const transportMode = process.env.MCP_TRANSPORT?.trim().toLowerCase() ?? "http";
const host = process.env.MCP_HOST ?? "0.0.0.0";
const port = Number.parseInt(process.env.MCP_PORT ?? "3100", 10);
const firecrawlApiUrl = process.env.FIRECRAWL_API_URL ?? "http://localhost:3002";
const firecrawlApiKey = process.env.FIRECRAWL_API_KEY;
const firecrawlCacheTtlMs = Number.parseInt(
  process.env.FIRECRAWL_CACHE_TTL_MS ?? "1800000",
  10
);
const firecrawlMaxDiscoveryDepth = Number.parseInt(
  process.env.FIRECRAWL_MAX_DISCOVERY_DEPTH ?? "2",
  10
);
const firecrawlMaxDiscoveryPages = Number.parseInt(
  process.env.FIRECRAWL_MAX_DISCOVERY_PAGES ?? "8",
  10
);
const memoryFilePath =
  process.env.CDU_MEMORY_FILE_PATH ??
  resolve(process.cwd(), "../cdufireseach-memory.md");
const memoryCandidateFilePath =
  process.env.CDU_MEMORY_CANDIDATE_FILE_PATH ??
  resolve(process.cwd(), "../cdufireseach-memory-candidates.md");
const memoryCacheTtlMs = Number.parseInt(
  process.env.CDU_MEMORY_CACHE_TTL_MS ?? "300000",
  10
);
const memoryEnabled =
  (process.env.CDU_MEMORY_ENABLED ?? "false").trim().toLowerCase() === "true";
const memoryAutoWriteEnabled =
  memoryEnabled &&
  (process.env.CDU_MEMORY_AUTO_WRITE_ENABLED ?? "false").trim().toLowerCase() === "true";
const llmBaseUrl =
  process.env.CDU_LLM_BASE_URL ?? process.env.ARK_BASE_URL ?? "";
const llmApiKey =
  process.env.CDU_LLM_API_KEY ?? process.env.ARK_API_KEY ?? "";
const llmModel =
  process.env.CDU_LLM_MODEL ?? process.env.ARK_MODEL ?? "";
const llmTemperature = Number.parseFloat(
  process.env.CDU_LLM_TEMPERATURE ?? "0.2"
);
const llmTimeoutMs = Number.parseInt(
  process.env.CDU_LLM_TIMEOUT_MS ?? "20000",
  10
);

function createAdapter(): FirecrawlAdapter {
  console.log(
    `[cdufireseach] firecrawl mode; api: ${firecrawlApiUrl}; max-depth: ${firecrawlMaxDiscoveryDepth}; max-pages: ${firecrawlMaxDiscoveryPages}; memory-enabled: ${memoryEnabled}`
  );

  return new FirecrawlApiAdapter({
    baseUrl: firecrawlApiUrl,
    apiKey: firecrawlApiKey,
    cacheTtlMs: Number.isFinite(firecrawlCacheTtlMs) ? firecrawlCacheTtlMs : undefined,
    maxDiscoveryDepth: Number.isFinite(firecrawlMaxDiscoveryDepth)
      ? firecrawlMaxDiscoveryDepth
      : undefined,
    maxDiscoveryPages: Number.isFinite(firecrawlMaxDiscoveryPages)
      ? firecrawlMaxDiscoveryPages
      : undefined,
    memoryFilePath: memoryEnabled ? memoryFilePath : undefined,
    memoryCacheTtlMs: Number.isFinite(memoryCacheTtlMs)
      ? memoryCacheTtlMs
      : undefined
  });
}

const adapter = createAdapter();

function createLlmClient(): ArkChatClient | undefined {
  if (!llmBaseUrl.trim() || !llmApiKey.trim() || !llmModel.trim()) {
    console.log("[cdufireseach] LLM runtime disabled; missing base URL, API key, or model");
    return undefined;
  }

  console.log(
    `[cdufireseach] LLM runtime enabled; base: ${llmBaseUrl}; model: ${llmModel}`
  );

  return new ArkChatClient({
    baseUrl: llmBaseUrl,
    apiKey: llmApiKey,
    model: llmModel,
    temperature: Number.isFinite(llmTemperature) ? llmTemperature : 0.2,
    timeoutMs: Number.isFinite(llmTimeoutMs) ? llmTimeoutMs : 20_000
  });
}

const llmClient = createLlmClient();
const memoryCurationService =
  llmClient && memoryAutoWriteEnabled
    ? new MemoryCurationService(llmClient, {
        formalFilePath: memoryFilePath,
        candidateFilePath: memoryCandidateFilePath,
        enabled: true
      })
    : undefined;
const qaService = new CduQaService(adapter, llmClient, memoryCurationService);

function createServer(): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION
    },
    {
      capabilities: {
        logging: {}
      }
    }
  );

  registerTools(server, qaService);
  return server;
}

async function startStdioServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function startHttpServer(): Promise<void> {
  const app = express();
  app.use(express.json());

  const transports: Record<string, StreamableHTTPServerTransport> = {};
  registerAskRoute(app, qaService);

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      name: SERVER_NAME,
      version: SERVER_VERSION,
      transport: "http",
      data_mode: "firecrawl",
      firecrawl_api_url: firecrawlApiUrl,
      firecrawl_max_discovery_depth: firecrawlMaxDiscoveryDepth,
      firecrawl_max_discovery_pages: firecrawlMaxDiscoveryPages,
      memory_enabled: memoryEnabled,
      memory_file_path: memoryFilePath,
      memory_candidate_file_path: memoryCandidateFilePath,
      memory_auto_write_enabled: memoryAutoWriteEnabled,
      qa_runtime: "langgraph",
      llm_enabled: Boolean(llmClient),
      llm_base_url: llmClient?.baseUrl ?? null,
      llm_model: llmClient?.model ?? null
    });
  });

  const handleMcpRequest = async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    try {
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
        await transport.handleRequest(req, res, req.body);
        return;
      }

      if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            transports[newSessionId] = transport;
          }
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            delete transports[transport.sessionId];
          }
        };

        const server = createServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: missing valid MCP session"
        },
        id: null
      });
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message:
              error instanceof Error ? error.message : "Internal server error"
          },
          id: null
        });
      }
    }
  };

  app.post("/mcp", handleMcpRequest);

  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    const httpServer = app.listen(port, host, () => {
      console.log(
        `${SERVER_NAME} MCP Streamable HTTP listening on http://${host}:${port}/mcp`
      );
      resolve();
    });
    httpServer.on("error", reject);
  });
}

async function main(): Promise<void> {
  if (transportMode === "stdio") {
    await startStdioServer();
    return;
  }

  await startHttpServer();
}

main().catch((error) => {
  console.error("Failed to start cdufireseach MCP server:", error);
  process.exit(1);
});
