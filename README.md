# cdufireseach

This folder contains the initial deployment assets for `cdufireseach`.

At this stage it includes:

- a root Docker Compose deployment for the self-hosted Firecrawl backend
- a generic self-hosted Firecrawl MCP adapter
- a separate `cdufireseach/` TypeScript MCP service skeleton for Chengdu University queries

The target use case is a low-code platform that can connect to a remote MCP
endpoint over HTTP and query Chengdu University website content through a
specialized MCP service.

## Project layout

- root deployment files: self-hosted Firecrawl backend and generic MCP adapter
- `cdufireseach/`: TypeScript MCP service for Chengdu University website queries
- `CDU_MCP_DESIGN.md`: domain design draft and tool contract

## Root deployment stack

- `firecrawl-api`: main Firecrawl API
- `playwright-service`: browser rendering service used by Firecrawl
- `redis`: queue and rate-limit backing store
- `rabbitmq`: worker queue broker
- `nuq-postgres`: internal PostgreSQL used by Firecrawl
- `firecrawl-mcp`: MCP adapter that points at the self-hosted Firecrawl API

## Custom MCP service

The custom Chengdu University MCP service lives in:

- `cdufireseach/`

It currently provides a runnable MCP skeleton with HTTP Streamable and stdio
transports, plus stubbed tools for:

- organization structure
- department list
- department site lookup
- department profile

The next implementation step is to replace the stub adapter with a real
Firecrawl-backed adapter.

## Before you start

You need:

- Docker with Compose v2
- enough host resources for browser workloads
  - recommended starting point: 4 CPU cores, 8 GB RAM
- optional: an OpenAI-compatible API key if you want structured extraction or
  JSON scrape formats powered by an LLM

## Quick start

1. Create your environment file:

```bash
cp .env.example .env
```

2. Edit `.env` and set at least:

- `BULL_AUTH_KEY`
- `POSTGRES_PASSWORD`
- `OPENAI_API_KEY` if you want AI extraction features

3. Start the stack:

```bash
docker compose up -d
```

4. Follow logs during first boot:

```bash
docker compose logs -f firecrawl-api firecrawl-mcp
```

## Endpoints

- Firecrawl API: `http://<host>:3002`
- Firecrawl queue admin: `http://<host>:3002/admin/<BULL_AUTH_KEY>/queues`
- MCP endpoint: `http://<host>:3000/v2/mcp`

Some Firecrawl MCP documentation and older README snippets still reference
`/mcp` for local mode. If your client gets a 404 on `/v2/mcp`, test
`http://<host>:3000/mcp` before assuming the service is down.

## Low-code platform MCP configuration

Use:

- Transport: `HTTP Streamable`
- URL: `http://<your-host>:3000/v2/mcp`
- Authentication: `None`

If your platform requires an auth layer in front of MCP, place Nginx, Caddy, or
your API gateway in front of port `3000` and enforce auth there.

## Firecrawl API smoke tests

Scrape a page:

```bash
curl -X POST http://localhost:3002/v2/scrape \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://firecrawl.dev",
    "formats": ["markdown"]
  }'
```

Search the web:

```bash
curl -X POST http://localhost:3002/v2/search \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "firecrawl",
    "limit": 3
  }'
```

## MCP smoke test

Your low-code platform is the real MCP client, but operationally you mainly
need to verify that the MCP container is listening and that the Firecrawl API is
reachable behind it.

Useful checks:

```bash
docker compose ps
docker compose logs --tail=200 firecrawl-mcp
docker compose logs --tail=200 firecrawl-api
```

## Production notes

- Put both `3000` and `3002` behind HTTPS before exposing them outside a trusted
  network.
- Keep PostgreSQL internal only. This compose file does not publish it.
- Change `BULL_AUTH_KEY` immediately if the deployment is reachable by others.
- Self-hosted Firecrawl does not include Firecrawl cloud's advanced anti-bot
  capabilities. Tougher targets may require your own proxy setup.
- Official self-host docs note that self-hosted `/search` uses Google by
  default. In restricted or private environments, set `SEARXNG_ENDPOINT` to
  your own SearXNG instance instead.
- Firecrawl MCP docs say `FIRECRAWL_API_KEY` is optional in self-hosted mode,
  but some versions have been reported to behave better when the variable is
  still set to a non-empty placeholder. This stack keeps a local value for that
  reason.

## Useful commands

Restart just the MCP layer:

```bash
docker compose restart firecrawl-mcp
```

Update images:

```bash
docker compose pull
docker compose up -d
```

Stop everything:

```bash
docker compose down
```

Stop everything and remove database data:

```bash
docker compose down -v
```

## Source references

- Firecrawl self-hosting guide: https://docs.firecrawl.dev/contributing/self-host
- Firecrawl MCP guide: https://docs.firecrawl.dev/mcp-server
- Firecrawl repository: https://github.com/firecrawl/firecrawl
- Firecrawl MCP repository: https://github.com/firecrawl/firecrawl-mcp-server
