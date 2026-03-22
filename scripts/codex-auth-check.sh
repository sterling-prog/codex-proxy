#!/usr/bin/env bash
# Codex auth health check — reads ~/.codex/auth.json, decodes JWT exp claim,
# alerts via Discord #infra-agent-swarm (1475832162648461316) if expiry within 48 hours.
# Schedule: every 1 hour via OpenClaw cron.

set -euo pipefail

AUTH_FILE="${HOME}/.codex/auth.json"
ALERT_CHANNEL="1475832162648461316"
WARN_SECONDS=$((48 * 3600))  # 48 hours

# ─── Read auth.json ───────────────────────────────────────────────────────────

if [[ ! -f "${AUTH_FILE}" ]]; then
  echo "[codex-auth-check] ERROR: ${AUTH_FILE} not found" >&2
  openclaw message send --account max --channel discord --target "${ALERT_CHANNEL}" \
    -m "⚠️ [codex-auth-check] auth.json not found at ${AUTH_FILE} — Codex auth may be unconfigured"
  exit 1
fi

# ─── Extract access token ─────────────────────────────────────────────────────

ACCESS_TOKEN=$(python3 -c "
import json, sys
try:
    data = json.load(open('${AUTH_FILE}'))
    token = data.get('accessToken') or data.get('access_token') or data.get('token')
    if not token:
        print('', end='')
    else:
        print(token, end='')
except Exception as e:
    print('', end='')
    sys.stderr.write(str(e) + '\n')
")

if [[ -z "${ACCESS_TOKEN}" ]]; then
  echo "[codex-auth-check] ERROR: Could not extract access token from auth.json" >&2
  openclaw message send --account max --channel discord --target "${ALERT_CHANNEL}" \
    -m "⚠️ [codex-auth-check] Could not extract access token from ${AUTH_FILE} — manual inspection required"
  exit 1
fi

# ─── Decode JWT exp claim ─────────────────────────────────────────────────────

EXP=$(python3 -c "
import base64, json, sys

token = '${ACCESS_TOKEN}'
parts = token.split('.')
if len(parts) != 3:
    print(-1)
    sys.exit(0)

# Base64url decode the payload (part 2)
payload_b64 = parts[1]
# Add padding
padding = 4 - len(payload_b64) % 4
if padding != 4:
    payload_b64 += '=' * padding

try:
    payload = json.loads(base64.urlsafe_b64decode(payload_b64))
    print(payload.get('exp', -1))
except Exception as e:
    sys.stderr.write(str(e) + '\n')
    print(-1)
")

if [[ "${EXP}" == "-1" ]]; then
  echo "[codex-auth-check] WARNING: Could not decode JWT exp claim" >&2
  openclaw message send --account max --channel discord --target "${ALERT_CHANNEL}" \
    -m "⚠️ [codex-auth-check] Could not decode JWT exp claim — token format may have changed"
  exit 0
fi

# ─── Check expiry ─────────────────────────────────────────────────────────────

NOW=$(date +%s)
SECONDS_REMAINING=$(( EXP - NOW ))

if [[ ${SECONDS_REMAINING} -le 0 ]]; then
  EXPIRED_AGO=$(( -SECONDS_REMAINING ))
  HOURS_AGO=$(( EXPIRED_AGO / 3600 ))
  echo "[codex-auth-check] CRITICAL: Codex auth token EXPIRED ${HOURS_AGO}h ago" >&2
  openclaw message send --account max --channel discord --target "${ALERT_CHANNEL}" \
    -m "🚨 [codex-auth-check] Codex auth token EXPIRED ${HOURS_AGO}h ago — run: codex login --device-auth && pm2 restart codex-app-server"
  exit 0
fi

HOURS_REMAINING=$(( SECONDS_REMAINING / 3600 ))

if [[ ${SECONDS_REMAINING} -le ${WARN_SECONDS} ]]; then
  echo "[codex-auth-check] WARNING: Codex auth token expires in ${HOURS_REMAINING}h" >&2
  openclaw message send --account max --channel discord --target "${ALERT_CHANNEL}" \
    -m "⚠️ [codex-auth-check] Codex auth token expires in ${HOURS_REMAINING}h — run: codex login --device-auth && pm2 restart codex-app-server"
else
  echo "[codex-auth-check] OK: Codex auth token valid for ${HOURS_REMAINING}h"
fi
