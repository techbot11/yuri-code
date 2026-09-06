#!/usr/bin/env bash
# Registers the OpenCode session running in this directory with the local Yuri
# backend. Invoked by the /voice-handoff command as: handoff.sh [session-id]
#
# OpenCode gives a command no session id, so the id is optional: normally Yuri
# resolves the session from this directory, and the id is only needed when more
# than one session is open here.
#
# Always exits 0 and prints JSON; failures are reported in an "error" field.
set -u

url="${YURI_URL:-${YAPCODE_URL:-http://localhost:8000}}"
sid="${1:-}"

json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  printf '%s' "$s"
}

args=(-s -X POST "$url/session/handoff/opencode" -H "Content-Type: application/json")
token="${YURI_TOKEN:-${YAPCODE_TOKEN:-}}"
if [ -n "$token" ]; then
  args+=(-H "X-VC-Token: ${token}")
fi

if [ -n "$sid" ]; then
  payload="$(printf '{"cwd":"%s","session_id":"%s"}' \
    "$(json_escape "$(pwd)")" "$(json_escape "$sid")")"
else
  payload="$(printf '{"cwd":"%s"}' "$(json_escape "$(pwd)")")"
fi

out="$(curl "${args[@]}" -d "$payload" 2>/dev/null)"
if [ -z "$out" ]; then
  printf '{"error":"the Yuri backend is not answering at %s — is it running?"}\n' "$url"
  exit 0
fi
printf '%s\n' "$out"
exit 0
