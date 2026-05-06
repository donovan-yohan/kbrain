# Setting up kbrain with OpenCode Go

This guide installs the kbrain CLI on a Mac, points it at a Tailscale Postgres
backend, and routes chat-model calls through an **OpenCode Go** subscription via
the v0.27 AI Gateway. Embeddings stay on Ollama because OpenCode Go does not
serve embedding models.

End state per device:
- `gbrain` CLI on PATH
- all Macs share the same brain (Postgres over Tailscale = single source of truth)
- subagents and query expansion use OpenCode Go's OpenAI-compatible chat endpoint
  via the bundled `opencode-go` recipe in `src/core/ai/recipes/opencode-go.ts`
- embeddings use Ollama over Tailscale (`mxbai-embed-large`, 1024 dimensions)
- per-client secret: OpenCode Go API key (read by the recipe from
  `OPENCODE_GO_API_KEY`)

## Prerequisites

### On shared Tailscale hosts (one-time)

1. **Postgres >=14 with pgvector**
   ```bash
   apt install postgresql-17 postgresql-17-pgvector   # match your pg version
   sudo -u postgres createuser kbrain --pwprompt
   sudo -u postgres createdb -O kbrain kbrain
   sudo -u postgres psql -d kbrain -c "CREATE EXTENSION vector;"
   ```
   Bind Postgres to the Tailscale interface or firewall port 5432 to your
   tailnet only.

2. **Ollama with embedding model**
   ```bash
   docker run -d --name ollama -p 11434:11434 \
     -v /opt/ollama:/root/.ollama --restart unless-stopped \
     ollama/ollama
   docker exec ollama ollama pull mxbai-embed-large
   ```
   Bind Ollama to the Tailscale interface or firewall port 11434 to your
   tailnet only.

3. **Tailnet DNS names or Tailscale IPs** so clients can reach Postgres and
   Ollama from each Mac.

### Per-client (each Mac)

- `bun` on PATH — `curl -fsSL https://bun.sh/install | bash`
- `psql` on PATH — `brew install libpq && brew link --force libpq`
- `jq` on PATH — `brew install jq` (the installer writes file-plane gateway
  config via jq)
- Network reachability to Tailscale Postgres (5432) and Ollama (11434)
- An **OpenCode Go** subscription — sign up at https://opencode.ai/zen

## Per-client install

### 1. Clone this fork

```bash
git clone https://github.com/donovan-yohan/kbrain.git ~/kbrain
cd ~/kbrain
```

### 2. Configure env

```bash
cp .env.opencode-go.example .env
chmod 600 .env
```

Edit `.env` and fill in:

```bash
OPENCODE_GO_API_KEY=***
GBRAIN_DATABASE_URL=postgresql://kbrain:***@postgres.your-tailnet.ts.net:5432/kbrain?sslmode=disable
OLLAMA_BASE_URL=http://ollama.your-tailnet.ts.net:11434/v1
```

The v0.27 gateway picks each model via a `<recipe-id>:<model-id>` string. The
example file ships with a working OpenCode Go + Ollama selection:

```bash
GBRAIN_CHAT_MODEL=opencode-go:kimi-k2.6
GBRAIN_EXPANSION_MODEL=opencode-go:deepseek-v4-flash
GBRAIN_EMBEDDING_MODEL=ollama:mxbai-embed-large
GBRAIN_EMBEDDING_DIMENSIONS=1024
```

The `opencode-go` recipe is `tier: openai-compat` with chat + expansion
touchpoints declared. It defaults to `https://opencode.ai/zen/go/v1`; override
via `OPENCODE_GO_BASE_URL` only if you proxy the endpoint. Authentication is
read by the recipe from the `OPENCODE_GO_API_KEY` env snapshot.

`.env` is gitignored. Never commit it.

### 3. Run the installer

```bash
./scripts/install-opencode-go.sh
```

The script:
1. Verifies prereqs (`bun`, `psql`, `curl`, `python3`, `jq`)
2. Loads `.env` and validates that all gateway-relevant env vars are set
3. Probes Postgres + pgvector
4. Probes OpenCode Go with a real `/chat/completions` request using `x-api-key`
5. Probes Tailscale Ollama and verifies embedding dimensions
6. Builds the kbrain CLI (`bun install` + `bun run build` + `bun link`)
7. Runs `gbrain init --non-interactive` against Postgres
8. Writes the gateway selection (`chat_model`, `expansion_model`,
   `embedding_model`, `embedding_dimensions`, `provider_base_urls.ollama`) to
   `~/.gbrain/config.json` via jq
9. Sets dream model config keys to the same `<recipe>:<model>` strings via
   `gbrain config set` (DB plane, separate from the gateway file plane)
10. Runs `gbrain doctor --json` to verify health
11. Registers the gbrain MCP server with Claude Code and Codex if their CLIs
    are on PATH

Use `--dry-run` to preview without executing.

### 4. Persist env

The installer prints the line to add to `~/.zshrc`. Add it so every shell
inherits the OpenCode Go credentials and tailnet config:

```bash
echo "set -a; . $HOME/kbrain/.env; set +a" >> ~/.zshrc
```

Reload your shell or `source ~/.zshrc`. Verify:

```bash
echo $GBRAIN_CHAT_MODEL            # -> opencode-go:kimi-k2.6
echo $GBRAIN_EMBEDDING_MODEL       # -> ollama:mxbai-embed-large
gbrain doctor                       # -> status: ok, or only known warnings
```

## What got configured

| Surface | Recipe | Model |
|---|---|---|
| Subagent (Minions handler, signal-detector) | `opencode-go` | `kimi-k2.6` |
| Search expansion | `opencode-go` | `deepseek-v4-flash` |
| Dream synthesize | `opencode-go` | `kimi-k2.6` |
| Dream verdict | `opencode-go` | `deepseek-v4-flash` |
| Dream patterns | `opencode-go` | `kimi-k2.6` |
| Embeddings | `ollama` | `mxbai-embed-large` (1024d) |

The gateway resolves recipes from `src/core/ai/recipes/`. Adding another
OpenAI-compatible provider is a one-file recipe + a registration entry in
`src/core/ai/recipes/index.ts`.

## Verifying multi-device sync

After installing on Mac B with the same shared Postgres/Ollama values:

```bash
# On Mac A
echo "hello from A" | gbrain put sync-test --tag sync-test

# On Mac B
gbrain query "hello from A"
```

Mac B should return the page Mac A wrote. Vector search works across both
because the Tailscale Postgres backend stores the shared embeddings.

## Switching models

Pick a different OpenCode Go model:

```bash
gbrain config set dream.synthesize.model         opencode-go:deepseek-v4
gbrain config set dream.synthesize.verdict_model opencode-go:qwen3.6-plus
```

Or override per shell (env wins over file plane):

```bash
export GBRAIN_CHAT_MODEL=opencode-go:glm-5.1
gbrain agent run "summarize my last 10 pages"
```

Available models change over time. See https://opencode.ai/docs/go for the
current list and per-model rate budgets.

## Switching back to direct Anthropic

If you cancel Go or want to A/B against Sonnet for a session:

```bash
unset GBRAIN_CHAT_MODEL GBRAIN_EXPANSION_MODEL
export ANTHROPIC_API_KEY=***

# Reset config keys to upstream defaults
gbrain config set dream.synthesize.model         anthropic:claude-sonnet-4-6
gbrain config set dream.synthesize.verdict_model anthropic:claude-haiku-4-5-20251001
gbrain config set dream.patterns.model           anthropic:claude-sonnet-4-6
```

To swap the gateway file-plane defaults too, edit `~/.gbrain/config.json` (or
re-run the installer with new `.env` values).

## Troubleshooting

### `gbrain doctor` reports warnings

Treat warnings as yellow, not red. Run `gbrain doctor --json` and inspect the
specific checks. For a freshly migrated shared brain, graph/timeline coverage may
be zero until extraction has been run.

### OpenCode Go probe returns 401

API key is wrong or revoked. Regenerate it at https://opencode.ai/zen and update
`.env`.

### OpenCode Go probe returns 400 with "model not found"

Go renamed or removed the model. Check https://opencode.ai/docs/go for the
current model list and update `GBRAIN_CHAT_MODEL` / `GBRAIN_EXPANSION_MODEL`.

### Embedding calls fail with "connection refused"

Ollama is not reachable from this Mac. Verify:

```bash
curl http://ollama.your-tailnet.ts.net:11434/api/tags
```

Check the tailnet firewall, DNS, and that Ollama is bound to the Tailscale
interface or `0.0.0.0:11434`, not only `127.0.0.1`.

### Embedding dimension mismatch

This setup uses `mxbai-embed-large` with `GBRAIN_EMBEDDING_DIMENSIONS=1024`. If
you change embedding models, update the dimension and rebuild/re-embed a fresh
pgvector column; one vector column cannot mix dimensions.

## Next steps

- Repeat this on each Mac that should use the shared brain
- Run `gbrain autopilot --install` to enable continuous brain-maintenance loops
- Read `docs/guides/multi-source-brains.md` to register additional source repos
