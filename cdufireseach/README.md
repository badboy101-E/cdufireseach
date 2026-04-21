# cdufireseach

`cdufireseach` is a minimal TypeScript MCP Server MVP for Chengdu University (`cdu.edu.cn`) site queries.

This server now runs in Firecrawl-only mode:
- All site catalog, content, and Q&A results come from the live Firecrawl backend
- No local stub or automatic fallback remains in the runtime path
- HTTP Streamable transport is available for remote MCP hosts

## Tool

- `ask_cdu`

The primary workflow is:
- discover secondary sites from `组织机构` and `院系设置`
- infer the most relevant target subsite from the user question
- recursively inspect that subsite within a controlled depth/page budget
- prefer focused section-level fields such as `办公地点 / 联系电话 / 邮箱`
- fall back to generic page-level or footer contact information only when needed
- answer from discovered page content, or return `没有` with analysis steps

## Quick Start

```bash
cp .env.example .env
npm install
npm run build
npm start
```

By default the server starts in HTTP mode on `http://0.0.0.0:3100/mcp`.

For development:

```bash
npm run dev
```

To run in stdio mode instead:

```bash
npm run start:stdio
```

## Environment Variables

- `MCP_TRANSPORT`: `http` or `stdio`
- `MCP_HOST`: HTTP bind host, default `0.0.0.0`
- `MCP_PORT`: HTTP bind port, default `3100`
- `FIRECRAWL_API_URL`: self-hosted Firecrawl API base URL, default `http://localhost:3002`
- `FIRECRAWL_API_KEY`: Firecrawl API key or local placeholder for self-hosted mode
- `FIRECRAWL_CACHE_TTL_MS`: in-memory cache TTL for MCP responses
- `FIRECRAWL_MAX_DISCOVERY_DEPTH`: recursive link depth for `ask_cdu`, default `2`
- `FIRECRAWL_MAX_DISCOVERY_PAGES`: max pages checked per question, default `8`

## MCP Integration

### Remote MCP host / low-code platform

Use Streamable HTTP:

```text
URL: http://<your-host>:3100/mcp
Transport: HTTP Streamable
```

Docker build:

```bash
docker build -t cdufireseach .
docker run --rm -p 3100:3100 --env-file .env cdufireseach
```

Health check:

```text
GET http://<your-host>:3100/healthz
```

Typical `ask_cdu` response includes:

- `answered`
- `answer`
- `evidence`
- `analysis_steps`
- `matched_site`
- `source_urls`

### Local stdio host

Example command:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/cdufireseach/dist/index.js"],
  "env": {
    "MCP_TRANSPORT": "stdio"
  }
}
```

## Project Structure

```text
src/
  index.ts                  # MCP server entry (HTTP or stdio)
  tools.ts                  # Tool registration
  types.ts                  # Domain types
  firecrawl/adapter.ts      # Firecrawl adapter interface
  firecrawl/apiAdapter.ts   # Live Firecrawl-backed implementation
```

## TODO

1. Expand parser coverage and harden focused-field extraction against future CDU page structure changes.
2. Add persistent cache or storage for stable responses and lower crawl cost.
3. Add tests for parser logic, tool behavior, and recursive discovery controls.
