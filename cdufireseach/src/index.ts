import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { FirecrawlApiAdapter } from "./firecrawl/apiAdapter.js";
import type { FirecrawlAdapter } from "./firecrawl/adapter.js";
import { registerTools } from "./tools.js";

const SERVER_NAME = "cdufireseach";
const SERVER_VERSION = "0.1.0";
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

function createAdapter(): FirecrawlAdapter {
  console.log(
    `[cdufireseach] firecrawl-only mode; api: ${firecrawlApiUrl}; max-depth: ${firecrawlMaxDiscoveryDepth}; max-pages: ${firecrawlMaxDiscoveryPages}`
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
      : undefined
  });
}

const adapter = createAdapter();

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

  registerTools(server, adapter);
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

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      name: SERVER_NAME,
      version: SERVER_VERSION,
      transport: "http",
      data_mode: "firecrawl",
      firecrawl_api_url: firecrawlApiUrl,
      firecrawl_max_discovery_depth: firecrawlMaxDiscoveryDepth,
      firecrawl_max_discovery_pages: firecrawlMaxDiscoveryPages
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
