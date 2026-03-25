# Codex CLI Proxy — CLAUDE.md

## Project Overview
OpenAI Chat Completions–compatible HTTP proxy that routes inference through the Codex CLI `app-server` WebSocket interface.

## Architecture
- **Port 3460**: HTTP proxy (Express)
- **Port 3461**: Codex app-server (WebSocket, managed by PM2)

## Key Invariants (NEVER violate)
1. `nextId` NEVER resets across WebSocket reconnects (module-level, process lifetime)
2. `cleanupDone` guard on ALL completion paths — first caller executes, rest are no-ops
3. Register `threadId` in `inFlightRequests` BEFORE sending `turn/start` (race prevention)
4. Reject ALL pending JSON-RPC promises on WebSocket disconnect
5. `sweepInProgress` cleared in `finally` block
6. Archive try/catch/finally: steps 4+5 (remove from map + release slot) always execute
7. `process.send('ready')` only AFTER WS connected AND model/list populated
8. `thread/start` failure routes through cleanup function (not inline release)
9. Use `Model.model` (NOT `Model.id`) for `/v1/models` id field
10. `sourceKinds: ["custom"]` on `thread/list` for orphan reconciliation
11. The proxy evaluates CLI-native tool execution requests against a policy config. Commands and file writes are approved/denied per policy rules. MCP/dynamic tools remain denied.

## Forbidden Patterns
- No reverse-engineering private APIs (no direct chatgpt.com calls)
- No credential extraction or impersonation
- No thread reuse across requests
- No OpenClaw tool mapping injection
- No MCP/dynamic tool execution. CLI-native tools are policy-gated — see `tool-policy.json`. Override: `CODEX_TOOL_APPROVAL=deny` disables all approvals.

## Environment Variables
- `CODEX_PROXY_PORT` (default 3460)
- `CODEX_APP_SERVER_URL` (default ws://127.0.0.1:3461)
- `CODEX_PROXY_API_KEY` (required)
- `CODEX_DEFAULT_MODEL` (default gpt-4o)
- `CODEX_DEFAULT_EFFORT` (default medium)
- `CODEX_MAX_CONCURRENT` (default 5)
- `CODEX_MAX_QUEUE_DEPTH` (default 20)
- `CODEX_QUEUE_TIMEOUT_MS` (default 120000)
- `CODEX_PROXY_TIMEOUT_MS` (default 900000)
- `CODEX_PROXY_RATE_LIMIT` (default 60)
- `CODEX_ORPHAN_SWEEP_INTERVAL_MS` (default 900000)
- `CODEX_DEGRADATION_THRESHOLD` (default 5)
- `CODEX_MAX_RESPONSE_SIZE` (default 5242880)
- `CODEX_TOOL_APPROVAL` — set to `deny` to revert all tool approvals to blanket denial (v1.0 behavior)
- `CODEX_TOOL_POLICY_PATH` — override path to `tool-policy.json` (default `~/codex-proxy/tool-policy.json`)

## PM2 Management
```
cd ~/codex-proxy && pm2 start ecosystem.config.cjs && pm2 save
```
Note: ecosystem config uses `.cjs` extension because `package.json` has `"type": "module"`.

## Manual Re-auth Procedure
1. `codex login --device-auth` on gpu1
2. Complete browser OAuth
3. `pm2 restart codex-app-server`
4. Verify via `/health` endpoint
