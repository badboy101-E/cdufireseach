# cdufireseach

`cdufireseach` is a minimal TypeScript MCP Server MVP for Chengdu University (`cdu.edu.cn`) site queries.

This server now runs in Firecrawl-first mode:
- Answers are generated from live Firecrawl retrieval by default
- Markdown long-term memory is currently disabled by default to avoid stale or over-matched answers
- HTTP Streamable transport is available for remote MCP hosts
- A LangGraph workflow now acts as the internal ask orchestration layer
- When LLM config is provided, the runtime enables:
  - LLM-assisted site resolution
  - LLM-assisted final answer refinement
  - optional LLM-assisted long-term memory curation when memory is explicitly enabled

## Tool

- `ask_cdu`

The primary workflow is:
- discover secondary sites from `组织机构` and `院系设置`
- infer the most relevant target subsite from the user question
- pass through a LangGraph-based internal workflow
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
- `CDU_MEMORY_ENABLED`: enable Markdown long-term memory matching, default `false`
- `CDU_MEMORY_FILE_PATH`: Markdown long-term memory path, default `../cdufireseach-memory.md`
- `CDU_MEMORY_CANDIDATE_FILE_PATH`: candidate memory path, default `../cdufireseach-memory-candidates.md`
- `CDU_MEMORY_CACHE_TTL_MS`: long-term memory file parse cache TTL, default `300000` ms
- `CDU_MEMORY_AUTO_WRITE_ENABLED`: whether high-confidence answers can be auto-curated into memory, default `false`; only works when `CDU_MEMORY_ENABLED=true`
- `CDU_LLM_BASE_URL`: OpenAI-compatible model base URL, for example `https://ark.cn-beijing.volces.com/api/coding/v3`
- `CDU_LLM_API_KEY`: model API key
- `CDU_LLM_MODEL`: model name, for example `glm-5.1`
- `CDU_LLM_TEMPERATURE`: generation temperature, default `0.2`
- `CDU_LLM_TIMEOUT_MS`: timeout for one LLM request, default `20000` ms

For Volcengine ARK, a typical local `.env` looks like:

```env
CDU_LLM_BASE_URL=https://ark.cn-beijing.volces.com/api/coding/v3
CDU_LLM_API_KEY=your-api-key
CDU_LLM_MODEL=glm-5.1
CDU_LLM_TEMPERATURE=0.2
CDU_LLM_TIMEOUT_MS=20000
```

To rebuild memory from scratch after clearing old entries:

```bash
npm run rebuild:memory
```

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

## REST API

The same internal QA service is also exposed as REST:

```text
POST http://<your-host>:3100/api/ask
Content-Type: application/json
```

Example request:

```json
{
  "question": "人事处人事科在哪里？"
}
```

Optional debug-oriented override:

```json
{
  "question": "信息网络中心在哪里？",
  "siteName": "信息网络中心"
}
```

Typical response fields:

- `answered`
- `answer`
- `evidence`
- `analysis_steps`
- `matched_site`
- `source_urls`
- `fetched_at`

### HiAgent integration suggestion

For HiAgent or any low-code agent platform, the simplest integration is:

- expose one REST tool
- point it to `POST /api/ask`
- pass only one required user-facing field: `question`

That keeps the low-code layer stable while the internal runtime can evolve from
heuristics to LangGraph-based orchestration without changing the external tool contract.

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
  memory/markdownMemory.ts  # Markdown long-term memory parser and matcher
  langchain/tools/*         # LangChain tools wrapping internal capabilities
  langchain/workflows/*     # LangGraph workflow orchestration
  services/cduQaService.ts  # Unified QA service entry
  services/catalogService.ts # Catalog orchestration (org/dept/site catalog/site match)
  services/pageQaService.ts  # Page QA/discovery orchestration
  firecrawl/adapter.ts      # Firecrawl adapter interface
  firecrawl/apiAdapter.ts   # Live Firecrawl-backed implementation

../cdufireseach-memory.md   # Human-maintained long-term memory content
```

## Optional Long-Term Memory Maintenance

The file [../cdufireseach-memory.md](../cdufireseach-memory.md) is intended to
store stable, high-frequency answers such as:

- department location
- office phone
- office email

Recommended maintenance rule:

- if the answer is stable and repeatedly asked, add it to the Markdown memory file
- if the answer is volatile or page-structure-dependent, keep it in live crawling mode

Long-term memory is disabled by default. To enable it:

```env
CDU_MEMORY_ENABLED=true
CDU_MEMORY_AUTO_WRITE_ENABLED=false
```

When enabled, the runtime order is:

1. check Markdown memory
2. if missed, run live Firecrawl + LangGraph workflow

## Automatic Memory Curation

Automatic memory curation is also disabled by default. When both LLM and memory
auto-write are enabled, the runtime can perform a second-step memory curation
after live answers are produced:

- high confidence + clear field + explicit source
  - automatically upsert into [../cdufireseach-memory.md](../cdufireseach-memory.md)
- medium or low confidence
  - write into [../cdufireseach-memory-candidates.md](../cdufireseach-memory-candidates.md) for review

This keeps production memory more accurate:

- real-time crawling discovers the current answer
- LLM validates whether that answer is suitable for long-term reuse
- only then does the answer enter formal memory or candidate memory

The rebuild script will:

1. back up the current formal and candidate memory files
2. clear both memory files
3. call the local `/api/ask` service with seed questions
4. repopulate formal or candidate memory according to LLM confidence

## Current LLM Role

Once `CDU_LLM_BASE_URL`, `CDU_LLM_API_KEY`, and `CDU_LLM_MODEL` are configured,
LLM currently participates in:

- site resolution within the LangGraph workflow
- final answer refinement and cleanup

Deep page crawling and recursive same-site discovery still remain deterministic
and Firecrawl-backed, which keeps the retrieval path stable while allowing the
model to improve semantic matching and user-facing answer quality.

## TODO

1. Expand parser coverage and harden focused-field extraction against future CDU page structure changes.
2. Add persistent cache or storage for stable responses and lower crawl cost.
3. Add tests for parser logic, tool behavior, and recursive discovery controls.
