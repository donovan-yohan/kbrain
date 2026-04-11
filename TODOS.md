# TODOS

## P1

### Batch embedding queue across files
**What:** Shared embedding queue that collects chunks from all parallel import workers and flushes to OpenAI in batches of 100, instead of each worker batching independently.

**Why:** With 4 workers importing files that average 5 chunks each, you get 4 concurrent OpenAI API calls with small batches (5-10 chunks). A shared queue would batch 100 chunks across workers into one API call, cutting embedding cost and latency roughly in half.

**Pros:** Fewer API calls (500 chunks = 5 calls instead of ~100), lower cost, faster embedding.

**Cons:** Adds coordination complexity: backpressure when queue is full, error attribution back to source file, worker pausing. Medium implementation effort.

**Context:** Deferred during eng review because per-worker embedding is simpler and the parallel workers themselves are the bigger speed win (network round-trips). Revisit after profiling real import workloads to confirm embedding is actually the bottleneck. If most imports use `--no-embed`, this matters less.

**Implementation sketch:** `src/core/embedding-queue.ts` with a Promise-based semaphore. Workers `await queue.submit(chunks)` which resolves when the queue has room. Queue flushes to OpenAI in batches of 100 with max 2-3 concurrent API calls. Track source file per chunk for error propagation.

**Depends on:** Part 5 (parallel import with per-worker engines) -- already shipped.

## P0

### Fix `bun build --compile` WASM embedding for PGLite
**What:** Submit PR to oven-sh/bun fixing WASM file embedding in `bun build --compile` (issue oven-sh/bun#15032).

**Why:** PGLite's WASM files (~3MB) can't be embedded in the compiled binary. Users who install via `bun install -g gbrain` are fine (WASM resolves from node_modules), but the compiled binary can't use PGLite. Jarred Sumner (Bun founder, YC W22) would likely be receptive.

**Pros:** Single-binary distribution includes PGLite. No sidecar files needed.

**Cons:** Requires understanding Bun's bundler internals. May be a large PR.

**Context:** Issue has been open since Nov 2024. The root cause is that `bun build --compile` generates virtual filesystem paths (`/$bunfs/root/...`) that PGLite can't resolve. Multiple users have reported this. A fix would benefit any WASM-dependent package, not just PGLite.

**Depends on:** PGLite engine shipping (to have a real use case for the PR).

### ChatGPT MCP support (OAuth 2.1)
**What:** Add OAuth 2.1 with Dynamic Client Registration to the Edge Function so ChatGPT can connect.

**Why:** ChatGPT requires OAuth 2.1 for MCP connectors. Bearer token auth is NOT supported. This is the only major AI client that can't use GBrain remotely.

**Pros:** Completes the "every AI client" promise. ChatGPT has the largest user base.

**Cons:** OAuth 2.1 is a significant implementation: authorization endpoint, token endpoint, PKCE flow, dynamic client registration. Estimated CC: ~3-4 hours.

**Context:** Discovered during DX review (2026-04-10). All other clients (Claude Desktop/Code/Cowork, Perplexity) work with bearer tokens. See `docs/mcp/CHATGPT.md` for current status.

**Depends on:** v0.6.0 remote MCP server (shipped).

## P2

### Fly.io HTTP server as alternative deployment
**What:** Add `gbrain serve --http` and a Dockerfile/fly.toml for users who prefer a traditional server over Edge Functions.

**Why:** Avoids the Deno bundling seam. Bun runs natively. No 60s timeout. No cold start. Codex flagged the bundle strategy as "permanent maintenance tax."

**Pros:** Simpler code path, no edge-entry.ts needed, no Deno compat concerns. Supports sync_brain and file_upload remotely.

**Cons:** Users need a Fly.io account. Not zero-infra.

**Context:** From CEO review (2026-04-10). Edge Functions are the primary path. Fly.io is for power users who want full operation support remotely.

**Depends on:** v0.6.0 remote MCP server (shipped).

## Completed

### Implement AWS Signature V4 for S3 storage backend
**Completed:** v0.6.0 (2026-04-10) — replaced with @aws-sdk/client-s3 for proper SigV4 signing.
