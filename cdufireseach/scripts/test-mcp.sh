#!/usr/bin/env bash

set -uo pipefail

MCP_BASE_URL="${MCP_BASE_URL:-http://127.0.0.1:3100}"
MCP_ENDPOINT="${MCP_ENDPOINT:-$MCP_BASE_URL/mcp}"
HEALTH_URL="${HEALTH_URL:-$MCP_BASE_URL/healthz}"
FIRECRAWL_API_URL="${FIRECRAWL_API_URL:-http://127.0.0.1:3002}"
SITE_NAME="${SITE_NAME:-}"
QUESTION="${QUESTION:-信息网络中心在哪？}"

TMP_DIR="$(mktemp -d)"
SESSION_ID=""
FAILURES=0

cleanup() {
  rm -rf "$TMP_DIR"
}

trap cleanup EXIT

section() {
  printf '\n== %s ==\n' "$1"
}

info() {
  printf '%s\n' "$1"
}

warn() {
  printf 'WARN: %s\n' "$1" >&2
}

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  FAILURES=$((FAILURES + 1))
}

have_jq() {
  command -v jq >/dev/null 2>&1
}

pretty_json() {
  local file="$1"
  if have_jq; then
    jq . "$file" 2>/dev/null || cat "$file"
  else
    cat "$file"
  fi
}

pretty_sse() {
  local file="$1"
  local extracted="$TMP_DIR/extracted.json"
  sed -n 's/^data: //p' "$file" >"$extracted"
  if [[ -s "$extracted" ]]; then
    pretty_json "$extracted"
  else
    cat "$file"
  fi
}

ensure_not_tool_error() {
  local file="$1"
  local extracted="$TMP_DIR/tool-check.json"
  sed -n 's/^data: //p' "$file" >"$extracted"

  if [[ -s "$extracted" ]]; then
    if have_jq && jq -e '.result.isError == true' "$extracted" >/dev/null 2>&1; then
      return 1
    fi
  else
    if have_jq && jq -e '.result.isError == true' "$file" >/dev/null 2>&1; then
      return 1
    fi
  fi
  return 0
}

extract_session_id() {
  local headers_file="$1"
  grep -i '^mcp-session-id:' "$headers_file" | head -n 1 | awk '{print $2}' | tr -d '\r'
}

post_json() {
  local url="$1"
  local body="$2"
  local outfile="$3"
  shift 3

  curl -sS "$url" \
    -H 'Content-Type: application/json' \
    "$@" \
    -X POST \
    -d "$body" >"$outfile"
}

section "Configuration"
info "MCP endpoint: $MCP_ENDPOINT"
info "Health URL:    $HEALTH_URL"
info "Firecrawl URL: $FIRECRAWL_API_URL"
info "Site name:     ${SITE_NAME:-<auto infer from question>}"
info "Question:      $QUESTION"

section "Health Check"
HEALTH_OUT="$TMP_DIR/health.json"
if curl -sS "$HEALTH_URL" >"$HEALTH_OUT"; then
  pretty_json "$HEALTH_OUT"
else
  fail "MCP health check failed at $HEALTH_URL"
fi

section "Firecrawl Direct Check"
SCRAPE_OUT="$TMP_DIR/firecrawl-scrape.json"
SCRAPE_BODY=$(cat <<JSON
{
  "url": "https://nic.cdu.edu.cn/",
  "formats": ["markdown"]
}
JSON
)

if post_json "$FIRECRAWL_API_URL/v2/scrape" "$SCRAPE_BODY" "$SCRAPE_OUT"; then
  pretty_json "$SCRAPE_OUT"
else
  warn "Direct Firecrawl scrape failed."
  FAILURES=$((FAILURES + 1))
fi

section "MCP Initialize"
INIT_HEADERS="$TMP_DIR/init.headers"
INIT_OUT="$TMP_DIR/init.out"
INIT_BODY=$(cat <<JSON
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-03-26",
    "capabilities": {},
    "clientInfo": {
      "name": "cdufireseach-test-script",
      "version": "0.1.0"
    }
  }
}
JSON
)

if curl -sS -D "$INIT_HEADERS" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -X POST "$MCP_ENDPOINT" \
  -d "$INIT_BODY" >"$INIT_OUT"; then
  cat "$INIT_OUT"
  SESSION_ID="$(extract_session_id "$INIT_HEADERS")"
  if [[ -z "$SESSION_ID" ]]; then
    fail "Initialize succeeded but no mcp-session-id was returned."
    info "Response headers:"
    cat "$INIT_HEADERS"
  else
    info "Session ID: $SESSION_ID"
  fi
else
  fail "MCP initialize failed."
fi

if [[ -n "$SESSION_ID" ]]; then
  section "MCP Initialized Notification"
  NOTIFY_OUT="$TMP_DIR/notify.out"
  NOTIFY_BODY='{"jsonrpc":"2.0","method":"notifications/initialized"}'
  if post_json "$MCP_ENDPOINT" "$NOTIFY_BODY" "$NOTIFY_OUT" \
    -H 'Accept: application/json, text/event-stream' \
    -H "mcp-session-id: $SESSION_ID"; then
    if [[ -s "$NOTIFY_OUT" ]]; then
      cat "$NOTIFY_OUT"
    else
      info "initialized notification sent"
    fi
  else
    fail "notifications/initialized failed."
  fi

  section "Tools List"
  TOOLS_OUT="$TMP_DIR/tools.out"
  TOOLS_BODY='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
  if post_json "$MCP_ENDPOINT" "$TOOLS_BODY" "$TOOLS_OUT" \
    -H 'Accept: application/json, text/event-stream' \
    -H "mcp-session-id: $SESSION_ID"; then
    pretty_sse "$TOOLS_OUT"
  else
    fail "tools/list failed."
  fi

  section "ask_cdu"
  ASK_OUT="$TMP_DIR/ask.out"
  if [[ -n "$SITE_NAME" ]]; then
    ASK_BODY=$(cat <<JSON
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ask_cdu","arguments":{"question":"$QUESTION","siteName":"$SITE_NAME"}}}
JSON
)
  else
    ASK_BODY=$(cat <<JSON
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ask_cdu","arguments":{"question":"$QUESTION"}}}
JSON
)
  fi
  if post_json "$MCP_ENDPOINT" "$ASK_BODY" "$ASK_OUT" \
    -H 'Accept: application/json, text/event-stream' \
    -H "mcp-session-id: $SESSION_ID"; then
    pretty_sse "$ASK_OUT"
    ensure_not_tool_error "$ASK_OUT" || fail "ask_cdu returned an MCP tool error."
  else
    fail "ask_cdu failed."
  fi
fi

section "Summary"
if [[ "$FAILURES" -eq 0 ]]; then
  info "All checks completed successfully."
else
  warn "$FAILURES check(s) failed. See output above for details."
  exit 1
fi
