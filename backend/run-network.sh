#!/usr/bin/env bash
# Backend over TLS (https + wss) for LAN/phone use. Binds all interfaces so the
# phone can reach it, and serves wss so the live terminal works from the HTTPS
# frontend. Pair with `npm run dev:network` in ../frontend.
# One-time per device: open https://<host>:8000 in the browser and accept the
# self-signed cert, otherwise the wss terminal connection is silently blocked.
#
# SECURITY: this binds 0.0.0.0, so the backend is reachable from every device on
# the LAN. You MUST have a VC_AUTH_TOKEN in your config file first — `yapcode up`
# generates one, or set it by hand (see .env.example) — without it the backend
# refuses all non-loopback requests. Open the app on your devices once as
# https://<host>:3000/#vc_token=<the token>  to register the secret.
set -euo pipefail
cd "$(dirname "$0")"

# The backend doesn't auto-load VC_AUTH_TOKEN from a file (it's opt-in per run
# mode). Network mode opts in: read it from the config file and export it. An
# env value already set wins.
#
# The candidate list and its ORDER mirror config.py's precedence chain exactly
# -- the out-of-tree config dir (Homebrew only, YAPCODE_CONFIG_DIR), then
# $YURI_HOME/config/.env, then the in-tree backend/.env -- so this script and
# the backend never disagree about which file is in charge. The middle one is
# the file `yapcode up`'s wizard now writes and the Setup screen saves to; it
# used to be missing here, which meant a fresh clone reached the fail-closed
# branch below and was pointed at a file nothing writes.
_yuri_home="${YURI_HOME:-$HOME/Yuri}"
_yuri_home="${_yuri_home/#\~/$HOME}"  # a literal `~/Yuri` arrives unexpanded
# The file the wizard WRITES -- same rule as bin/yapcode's CONF_DIR and
# setup_store.target_dir(). Only used to name a file in the error below; the
# read loop still walks the whole precedence chain.
if [ -n "${YAPCODE_CONFIG_DIR:-}" ]; then
  _conf_env="$YAPCODE_CONFIG_DIR/.env"
else
  _conf_env="$_yuri_home/config/.env"
fi
if [ -z "${VC_AUTH_TOKEN:-}" ]; then
  for _f in "${YAPCODE_CONFIG_DIR:+$YAPCODE_CONFIG_DIR/.env}" \
            "$_yuri_home/config/.env" .env; do
    [ -n "$_f" ] && [ -f "$_f" ] || continue
    _line="$(grep -E '^[[:space:]]*VC_AUTH_TOKEN=' "$_f" | tail -1)"
    if [ -n "$_line" ]; then
      _val="${_line#*=}"; _val="${_val#\"}"; _val="${_val%\"}"  # strip one quote layer
      _val="${_val#\'}"; _val="${_val%\'}"
      [ -n "$_val" ] && { export VC_AUTH_TOKEN="$_val"; break; }
    fi
  done
fi

# Fail closed with a clear message: binding 0.0.0.0 without VC_AUTH_TOKEN leaves
# the backend refusing every remote request (loopback-only), i.e. a non-functional
# LAN app. Require the secret to be configured before exposing the port.
if [ -z "${VC_AUTH_TOKEN:-}" ]; then
  echo "ERROR: run-network.sh binds 0.0.0.0 but VC_AUTH_TOKEN is not set." >&2
  echo "Set VC_AUTH_TOKEN in $_conf_env (the file \`yapcode up\`'s" >&2
  echo "wizard writes and \`yapcode config\` edits) so remote/phone requests can" >&2
  echo "authenticate; otherwise all non-loopback requests are refused." >&2
  exit 1
fi

# --reload: hot-reload on backend code changes. With detach-on-shutdown the
# reload preserves running CLI sessions (they're rehydrated on the restart).
# --reload-dir . limits the watcher to backend/ so the session store under the
# project root (rapidly-written events.jsonl) never triggers reloads.
# --timeout-graceful-shutdown: long-lived SSE/poll/terminal-WS connections
# never drain on their own, so a reload (or stop) would hang on "Waiting for
# connections to close". 3s lets an in-flight request finish, then force-closes.
exec .venv/bin/python -m uvicorn main:app \
  --host 0.0.0.0 --port 8000 \
  --ssl-keyfile ../frontend/.certs/dev-key.pem \
  --ssl-certfile ../frontend/.certs/dev-cert.pem \
  --log-level info \
  --reload --reload-dir . --timeout-graceful-shutdown 3
