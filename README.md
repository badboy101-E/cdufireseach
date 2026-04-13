# cdufireseach

`cdufireseach` is a Chengdu University (`cdu.edu.cn`) MCP project built on top
of a self-hosted Firecrawl stack.

This repository has two layers:

- a self-hosted Firecrawl backend deployment
- a custom TypeScript MCP service focused on Chengdu University secondary sites

The target scenario is a low-code platform or AI agent platform that can
connect to MCP over `Streamable HTTP` and ask questions such as:

- `信息网络中心在哪里？`
- `计算机学院首页有哪些主要栏目？`
- `成都大学有哪些院系二级网站？`

## What It Does

This project is designed to:

- discover Chengdu University secondary websites from `组织机构` and `院系设置`
- locate the most relevant secondary site from a natural-language question
- scrape the matched site through self-hosted Firecrawl
- return either:
  - a direct answer when the page contains one
  - or a clear `没有找到` style response with analysis steps explaining why

The current implementation already supports:

- secondary site catalog discovery
- site lookup by organization or department name
- homepage content extraction
- site question answering with lightweight analysis traces

## Repository Structure

Key paths:

- [cdufireseach/](./cdufireseach): custom MCP server
- [docker-compose.yml](./docker-compose.yml): self-hosted Firecrawl deployment
- [CDU_MCP_DESIGN.md](./CDU_MCP_DESIGN.md): initial design draft
- [.env.example](./.env.example): root deployment environment template

The custom MCP service lives under [cdufireseach/](./cdufireseach) and provides these MCP tools:

- `get_cdu_site_catalog`
- `find_cdu_site`
- `get_cdu_site_content`
- `ask_cdu_site`
- `get_org_structure`
- `get_departments`
- `find_department_site`
- `get_department_profile`

## Architecture

The runtime flow is:

```text
Low-code platform / MCP client
  -> cdufireseach MCP service
  -> self-hosted Firecrawl API
  -> Chengdu University main site and secondary sites
```

Ports used by default:

- `3100`: custom MCP service `cdufireseach`
- `3002`: self-hosted Firecrawl API
- `3000`: generic Firecrawl MCP adapter from the official Firecrawl stack

For this repository, the main integration target is usually:

- `http://<host>:3100/mcp`

## Quick Start

### 1. Start the self-hosted Firecrawl backend

```bash
cp .env.example .env
docker compose up -d
```

Useful checks:

```bash
docker compose ps
docker compose logs --tail=200 firecrawl-api
docker compose logs --tail=200 firecrawl-mcp
```

### 2. Start the custom MCP service

```bash
cd cdufireseach
cp .env.example .env
npm install
npm run build
npm start
```

Health check:

```bash
curl http://127.0.0.1:3100/healthz
```

### 3. Connect your MCP client

Use:

- Transport: `HTTP Streamable`
- URL: `http://127.0.0.1:3100/mcp`

If your platform supports a JSON config entry, it will typically look like:

```json
{
  "mcpServers": {
    "cdufireseach": {
      "transport": "streamable-http",
      "url": "http://127.0.0.1:3100/mcp"
    }
  }
}
```

## Example Questions

These are representative questions the MCP service is built to handle:

- `信息网络中心在哪里？`
- `网络信息中心在哪里？`
- `信息网络中心的联系电话是什么？`
- `成都大学有哪些院系二级网站？`
- `计算机学院官网是什么？`
- `计算机学院首页有哪些主要栏目？`

## Local Test Script

The repository includes a local smoke-test script:

- [cdufireseach/scripts/test-mcp.sh](./cdufireseach/scripts/test-mcp.sh)

Example:

```bash
QUESTION="网络信息中心在哪里？" ./cdufireseach/scripts/test-mcp.sh
```

If you want to force a specific site during debugging:

```bash
SITE_NAME="信息网络中心" QUESTION="信息网络中心在哪里？" ./cdufireseach/scripts/test-mcp.sh
```

## Firecrawl Notes

This repository uses self-hosted Firecrawl rather than Firecrawl Cloud.

In this environment, an important deployment detail was:

- `ALLOW_LOCAL_WEBHOOKS=true`

That was needed because the target site resolved to a reserved address range in
the container network, and Firecrawl's default safe-fetch protection blocked the
requests.

## Current Status

Current state of the project:

- self-hosted Firecrawl backend is up
- custom MCP service is running in Firecrawl-only mode
- stub fallback has been removed from the runtime path
- natural-language question to site matching is working
- address / phone / email style questions now use direct text extraction in
  addition to model-based analysis

## Next Improvements

- improve secondary-site matching for more aliases and wording variations
- clean extracted answers further so footer text is even tidier
- add persistent cache or storage for lower scrape cost and more stable answers
- add focused tests for parser and extraction logic

## References

- [Firecrawl Repository](https://github.com/firecrawl/firecrawl)
- [Firecrawl MCP Repository](https://github.com/firecrawl/firecrawl-mcp-server)
- [Firecrawl MCP Docs](https://docs.firecrawl.dev/mcp-server)
- [Self-Hosting Guide](https://docs.firecrawl.dev/contributing/self-host)
