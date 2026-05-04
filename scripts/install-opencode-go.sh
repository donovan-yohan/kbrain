#!/usr/bin/env bash
# install-opencode-go.sh — one-shot kbrain installer for OpenCode Go users.
#
# Reads .env (or path passed as $1) for OpenCode Go API key + Postgres URL,
# builds the kbrain CLI, runs `gbrain init`, applies model config keys, and
# verifies install with `gbrain doctor`.
#
# Usage:
#   ./scripts/install-opencode-go.sh                  # reads ./.env
#   ./scripts/install-opencode-go.sh path/to/.env     # reads custom path
#   ./scripts/install-opencode-go.sh --dry-run        # print actions, no execute
#
# Prereqs:
#   - bun on PATH
#   - psql on PATH
#   - curl on PATH
#   - .env file present with placeholders filled
#   - Tailscale Postgres reachable + pgvector available
#   - Tailscale Ollama reachable + embedding model pulled
#
# Exit codes:
#   0  — success
#   2  — prereq missing or bad arg
#   3  — env validation failed
#   4  — Tailscale/OpenCode service connectivity failed
#   5  — gbrain init / doctor failed

set -euo pipefail

# ── Colors ─────────────────────────────────────────────────────
if [ -t 1 ]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BLUE=$'\033[34m'; RESET=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; BLUE=""; RESET=""
fi

log()    { echo "${BLUE}==>${RESET} $*"; }
warn()   { echo "${YELLOW}warn:${RESET} $*" >&2; }
fail()   { echo "${RED}error:${RESET} $*" >&2; exit "${2:-1}"; }
pass()   { echo "${GREEN}ok${RESET} $*"; }

DRY_RUN=false
ENV_FILE="./.env"

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    --*) fail "unknown flag: $1" 2 ;;
    *) ENV_FILE="$1"; shift ;;
  esac
done

run() {
  if [ "$DRY_RUN" = "true" ]; then
    printf '  [dry-run]'
    for arg in "$@"; do
      display="$arg"
      if printf '%s' "$display" | grep -q 'postgresql://'; then
        display="$(redact_url "$display")"
      fi
      printf ' %q' "$display"
    done
    printf '\n'
  else
    "$@"
  fi
}

redact_url() {
  python3 - "$1" <<'PY'
import sys
s = sys.argv[1]
out = []
i = 0
while True:
    marker = s.find('://', i)
    if marker < 0:
        out.append(s[i:])
        break
    at = s.find('@', marker + 3)
    if at < 0:
        out.append(s[i:])
        break
    out.append(s[i:marker + 3])
    out.append('***:***@')
    i = at + 1
sys.stdout.write(''.join(out))
PY
}

strip_v1_suffix() {
  printf '%s' "$1" | sed -E 's|/v1/?$||'
}

# ── Step 1: prereqs ────────────────────────────────────────────
log "Checking prerequisites"
command -v bun  >/dev/null 2>&1 || fail "bun not on PATH. Install: curl -fsSL https://bun.sh/install | bash" 2
command -v psql >/dev/null 2>&1 || fail "psql not on PATH. Install postgresql-client (brew install libpq && brew link --force libpq)." 2
command -v curl >/dev/null 2>&1 || fail "curl not on PATH." 2
command -v python3 >/dev/null 2>&1 || fail "python3 not on PATH." 2
[ -f "$ENV_FILE" ] || fail ".env file not found at $ENV_FILE. Copy .env.opencode-go.example and fill in placeholders." 2
pass "bun + psql + curl + python3 present"

# ── Step 2: load env ───────────────────────────────────────────
log "Loading $ENV_FILE"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

# Required vars and placeholder guards.
[ -n "${OPENCODE_GO_API_KEY:-}" ] || fail "OPENCODE_GO_API_KEY is empty in $ENV_FILE" 3
case "$OPENCODE_GO_API_KEY" in
  REPLACE_*|*PLACEHOLDER*|*YOUR_*|""|*...*)
    fail "OPENCODE_GO_API_KEY still has placeholder value. Edit $ENV_FILE." 3 ;;
esac

[ -n "${GBRAIN_DATABASE_URL:-}" ] || fail "GBRAIN_DATABASE_URL is empty in $ENV_FILE" 3
case "$GBRAIN_DATABASE_URL" in
  *USER:PASSWORD*|*POSTGRES_TAILNET_HOST*|*...*)
    fail "GBRAIN_DATABASE_URL still has placeholders. Edit $ENV_FILE." 3 ;;
esac
export GBRAIN_DATABASE_URL

[ "${GBRAIN_SUBAGENT_PROVIDER:-}" = "openai-compat" ] || fail "GBRAIN_SUBAGENT_PROVIDER must be openai-compat for OpenCode Go." 3
[ -n "${GBRAIN_SUBAGENT_BASE_URL:-}" ] || fail "GBRAIN_SUBAGENT_BASE_URL is empty" 3
[ -n "${GBRAIN_SUBAGENT_API_KEY:-}" ] || fail "GBRAIN_SUBAGENT_API_KEY is empty (should expand from OPENCODE_GO_API_KEY)" 3
[ -n "${GBRAIN_SUBAGENT_MODEL:-}" ] || fail "GBRAIN_SUBAGENT_MODEL is empty" 3
case "$GBRAIN_SUBAGENT_MODEL" in
  opencode-go/*)
    fail "GBRAIN_SUBAGENT_MODEL must be a raw OpenCode Go model ID like kimi-k2.6, not opencode-go/*" 3 ;;
esac

[ "${EXPANSION_PROVIDER:-}" = "openai-compat" ] || fail "EXPANSION_PROVIDER must be openai-compat for OpenCode Go." 3
[ -n "${EXPANSION_BASE_URL:-}" ] || fail "EXPANSION_BASE_URL is empty" 3
[ -n "${EXPANSION_API_KEY:-}" ] || fail "EXPANSION_API_KEY is empty (should expand from OPENCODE_GO_API_KEY)" 3
[ -n "${EXPANSION_MODEL:-}" ] || fail "EXPANSION_MODEL is empty" 3
case "$EXPANSION_MODEL" in
  opencode-go/*)
    fail "EXPANSION_MODEL must be a raw OpenCode Go model ID like deepseek-v4-flash, not opencode-go/*" 3 ;;
esac

[ -n "${EMBEDDING_BASE_URL:-}" ] || fail "EMBEDDING_BASE_URL is empty" 3
[ -n "${EMBEDDING_MODEL:-}" ] || fail "EMBEDDING_MODEL is empty" 3
[ "${EMBEDDING_MODEL:-}" = "mxbai-embed-large" ] || warn "EMBEDDING_MODEL is $EMBEDDING_MODEL; expected mxbai-embed-large for this setup."
[ "${EMBEDDING_DIMENSIONS:-}" = "1024" ] || fail "EMBEDDING_DIMENSIONS must be 1024 for mxbai-embed-large." 3
pass "env loaded — Go key + Postgres URL + OpenCode + embedding config all set"

# ── Step 3: connectivity probes ────────────────────────────────
log "Probing Postgres + pgvector"
if [ "$DRY_RUN" = "true" ]; then
  echo "  [dry-run] psql \"\$GBRAIN_DATABASE_URL\" -c \"SELECT 1;\""
  echo "  [dry-run] psql \"\$GBRAIN_DATABASE_URL\" -tAc \"SELECT extversion FROM pg_extension WHERE extname='vector';\""
else
  if ! psql "$GBRAIN_DATABASE_URL" -c "SELECT 1;" >/dev/null 2>&1; then
    fail "Cannot connect to Postgres at $(redact_url "$GBRAIN_DATABASE_URL"). Check host, credentials, firewall." 4
  fi
  if ! psql "$GBRAIN_DATABASE_URL" -tAc "SELECT extversion FROM pg_extension WHERE extname='vector';" | grep -Eq '[0-9]'; then
    fail "pgvector extension is not installed in the target database." 4
  fi
  pass "Postgres reachable + pgvector installed"
fi

log "Probing OpenCode Go chat completions"
GO_CHAT_URL="${GBRAIN_SUBAGENT_BASE_URL%/}/chat/completions"
GO_TEST_BODY='{"model":"'"${GBRAIN_SUBAGENT_MODEL}"'","max_tokens":16,"messages":[{"role":"user","content":"ping"}]}'
if [ "$DRY_RUN" = "true" ]; then
  echo "  [dry-run] curl -H \"x-api-key: [REDACTED]\" \"$GO_CHAT_URL\""
else
  GO_PROBE_FILE="/tmp/go-probe.$$"
  GO_PROBE_STATUS=$(curl -s -o "$GO_PROBE_FILE" -w '%{http_code}' \
    -H "x-api-key: $GBRAIN_SUBAGENT_API_KEY" \
    -H "Content-Type: application/json" \
    "$GO_CHAT_URL" \
    -d "$GO_TEST_BODY" || echo "000")
  if [ "$GO_PROBE_STATUS" != "200" ]; then
    echo "Response body:" >&2
    sed -E 's/(api[_-]?key|token|secret|password)[^[:space:]"]*/\1=[REDACTED]/Ig' "$GO_PROBE_FILE" >&2 || true
    rm -f "$GO_PROBE_FILE"
    fail "OpenCode Go probe returned HTTP $GO_PROBE_STATUS (expected 200). Check API key, model name, and GBRAIN_SUBAGENT_BASE_URL." 4
  fi
  rm -f "$GO_PROBE_FILE"
  pass "OpenCode Go reachable + key valid + $GBRAIN_SUBAGENT_MODEL responding"
fi

log "Probing Tailscale Ollama embeddings"
OLLAMA_ROOT="$(strip_v1_suffix "$EMBEDDING_BASE_URL")"
if [ "$DRY_RUN" = "true" ]; then
  echo "  [dry-run] curl \"$OLLAMA_ROOT/api/tags\""
  echo "  [dry-run] curl \"$EMBEDDING_BASE_URL/embeddings\""
else
  if ! curl -fsS -m 10 "$OLLAMA_ROOT/api/tags" >/dev/null 2>&1 \
     && ! curl -fsS -m 10 "${EMBEDDING_BASE_URL%/}/models" >/dev/null 2>&1; then
    warn "Ollama at $EMBEDDING_BASE_URL not reachable. Embeddings will fail until you fix this. Continuing anyway."
  else
    EMBED_FILE="/tmp/embed-probe.$$"
    EMBED_STATUS=$(curl -s -o "$EMBED_FILE" -w '%{http_code}' \
      -H 'Content-Type: application/json' \
      -d '{"model":"'"$EMBEDDING_MODEL"'","input":"ping"}' \
      "${EMBEDDING_BASE_URL%/}/embeddings" || echo "000")
    if [ "$EMBED_STATUS" = "200" ]; then
      EMBED_DIMS=$(python3 - "$EMBED_FILE" <<'PY'
import json, sys
body = json.load(open(sys.argv[1]))
print(len(body["data"][0]["embedding"]))
PY
)
      [ "$EMBED_DIMS" = "$EMBEDDING_DIMENSIONS" ] || fail "Embedding dimension mismatch: got $EMBED_DIMS, expected $EMBEDDING_DIMENSIONS" 4
      pass "Ollama reachable + $EMBEDDING_MODEL returns ${EMBED_DIMS}d embeddings"
    else
      warn "Ollama embedding probe returned HTTP $EMBED_STATUS. Continuing, but embedding may fail."
    fi
    rm -f "$EMBED_FILE"
  fi
fi

# ── Step 4: build kbrain CLI ───────────────────────────────────
log "Building kbrain CLI"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [ "$DRY_RUN" = "true" ]; then
  run bun install --frozen-lockfile
  run bun run build
  run bun link
  echo "  [dry-run] command -v gbrain"
  pass "kbrain CLI build/link would run"
else
  bun install --frozen-lockfile 2>&1 | tail -5
  bun run build 2>&1 | tail -10 || warn "build script may not be defined; falling back to bun link"
  bun link

  if ! command -v gbrain >/dev/null 2>&1; then
    fail "gbrain not on PATH after bun link. Add ~/.bun/bin to PATH and re-run." 5
  fi
  pass "gbrain CLI: $(which gbrain) ($(gbrain --version 2>/dev/null || echo 'version unknown'))"
fi

# ── Step 5: gbrain init ────────────────────────────────────────
log "Running gbrain init (postgres engine, schema migration)"
if [ "$DRY_RUN" = "true" ]; then
  run gbrain init --non-interactive --url "$GBRAIN_DATABASE_URL"
else
  gbrain init --non-interactive --url "$GBRAIN_DATABASE_URL"
fi
pass "kbrain initialized at $(redact_url "$GBRAIN_DATABASE_URL")"

# ── Step 6: apply non-secret config ────────────────────────────
log "Applying model config"
run env GBRAIN_DATABASE_URL="$GBRAIN_DATABASE_URL" gbrain config set expansion_provider "$EXPANSION_PROVIDER"
run env GBRAIN_DATABASE_URL="$GBRAIN_DATABASE_URL" gbrain config set expansion_base_url "$EXPANSION_BASE_URL"
run env GBRAIN_DATABASE_URL="$GBRAIN_DATABASE_URL" gbrain config set expansion_model "$EXPANSION_MODEL"
run env GBRAIN_DATABASE_URL="$GBRAIN_DATABASE_URL" gbrain config set dream.synthesize.model "$GBRAIN_SUBAGENT_MODEL"
run env GBRAIN_DATABASE_URL="$GBRAIN_DATABASE_URL" gbrain config set dream.synthesize.verdict_model "$EXPANSION_MODEL"
run env GBRAIN_DATABASE_URL="$GBRAIN_DATABASE_URL" gbrain config set dream.patterns.model "$GBRAIN_SUBAGENT_MODEL"
pass "model config keys applied; API keys stay in local .env"

# ── Step 7: doctor ─────────────────────────────────────────────
log "Running gbrain doctor"
if [ "$DRY_RUN" = "true" ]; then
  run env GBRAIN_DATABASE_URL="$GBRAIN_DATABASE_URL" gbrain doctor --json
else
  DOCTOR_FILE="/tmp/doctor.$$"
  if ! GBRAIN_DATABASE_URL="$GBRAIN_DATABASE_URL" gbrain doctor --json | tee "$DOCTOR_FILE" | grep -qE '"status":\s*"ok"'; then
    warn "Doctor status NOT ok. Output:"
    redact_url "$(cat "$DOCTOR_FILE")" >&2
    rm -f "$DOCTOR_FILE"
    fail "Resolve the warnings/errors above. Re-run this script after fixing." 5
  fi
  rm -f "$DOCTOR_FILE"
fi
pass "doctor: ok"

# ── Step 8: optional MCP register ──────────────────────────────
register_claude_mcp() {
  if ! command -v claude >/dev/null 2>&1; then
    warn "claude CLI not found — skipping Claude Code MCP registration"
    return 0
  fi

  log "Registering gbrain MCP server with Claude Code"
  if claude mcp get gbrain >/dev/null 2>&1; then
    pass "Claude Code MCP server already registered"
    return 0
  fi

  run claude mcp add gbrain -- gbrain serve || warn "Claude Code MCP registration failed; run manually later: claude mcp add gbrain -- gbrain serve"
}

register_codex_mcp() {
  if ! command -v codex >/dev/null 2>&1; then
    warn "codex CLI not found — skipping Codex MCP registration"
    return 0
  fi

  log "Registering gbrain MCP server with Codex"
  if codex mcp get gbrain >/dev/null 2>&1; then
    pass "Codex MCP server already registered"
    return 0
  fi

  run codex mcp add gbrain -- gbrain serve || warn "Codex MCP registration failed; run manually later: codex mcp add gbrain -- gbrain serve"
}

register_claude_mcp
register_codex_mcp

# ── Done ───────────────────────────────────────────────────────
cat <<EOF

${GREEN}━━━ kbrain + OpenCode Go install complete ━━━${RESET}

Active config:
  Engine:           postgres (Tailscale)
  Subagent model:   $GBRAIN_SUBAGENT_MODEL via $GBRAIN_SUBAGENT_PROVIDER
  Expansion model:  $EXPANSION_MODEL via $EXPANSION_PROVIDER
  Embedding model:  ${EMBEDDING_MODEL} @ ${EMBEDDING_BASE_URL}

Source the env in your shell rc to make this permanent:
  echo "set -a; . $REPO_ROOT/.env; set +a" >> ~/.zshrc

Try it:
  gbrain put_page --title "Hello" --tags "test" <<<"first page"
  gbrain query "hello"

Next steps:
  - Repeat this on each Mac (only OPENCODE_GO_API_KEY differs per Mac)
  - Run: gbrain autopilot --install
EOF
