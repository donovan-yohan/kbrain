/**
 * Subagent LLM-loop handler (v0.15).
 *
 * Runs one Anthropic Messages API conversation with tool use. The loop is
 * crash-resumable: subagent_messages + subagent_tool_executions together
 * are the single source of truth about where the conversation is. On
 * resume after a worker kill, we load all committed rows, trust any tool
 * execution marked 'complete' or 'failed', and re-run 'pending' ones only
 * for idempotent tools.
 *
 * Safety rails:
 *   - rate leases around every LLM call (acquire → call → release). Mid-
 *     call renewal with backoff. Persistent renewal failure aborts as a
 *     renewable error so the worker re-claims.
 *   - dual-signal abort wiring (ctx.signal + ctx.shutdownSignal) drains
 *     the in-flight call and commits whatever turns are already persisted.
 *   - Anthropic prompt cache markers on system + tools blocks.
 *   - token rollup via ctx.updateTokens per turn.
 *
 * NOT in v0.15: refusal detection, stop_reason=max_tokens partial
 * recovery, parallel tool-use dispatch (runs tools sequentially; the
 * Messages API allows parallel tool_use blocks and the replay tolerates
 * them, but v1 dispatches serially for simplicity). All three are tracked
 * as P2 items in the plan file.
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { MinionJobContext, MinionJob } from '../types.ts';
import type {
  ContentBlock,
  SubagentHandlerData,
  SubagentResult,
  SubagentStopReason,
  ToolDef,
} from '../types.ts';
import type { BrainEngine } from '../../engine.ts';
import type { GBrainConfig } from '../../config.ts';
import { loadConfig } from '../../config.ts';
import { buildBrainTools, filterAllowedTools } from '../tools/brain-allowlist.ts';
import {
  acquireLease,
  releaseLease,
  renewLeaseWithBackoff,
} from '../rate-leases.ts';
import {
  logSubagentSubmission,
  logSubagentHeartbeat,
} from './subagent-audit.ts';

// ── Defaults ────────────────────────────────────────────────

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_RATE_KEY = 'anthropic:messages';
const DEFAULT_MAX_CONCURRENT = Number(process.env.GBRAIN_ANTHROPIC_MAX_INFLIGHT ?? '8');
const DEFAULT_LEASE_TTL_MS = 120_000;
const DEFAULT_SYSTEM = 'You are a helpful assistant running as a gbrain subagent.';

// ── Injectable surfaces (for tests) ─────────────────────────

/**
 * Anthropic Messages client. The real Anthropic SDK implements this
 * structurally; tests can substitute a mock without the SDK import.
 */
export interface MessagesClient {
  create(params: Anthropic.MessageCreateParamsNonStreaming, opts?: { signal?: AbortSignal }): Promise<Anthropic.Message>;
}

export type SubagentProvider = 'anthropic' | 'openai-compat';

export interface OpenAIChatCompletionsClient {
  create(params: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
}

export interface SubagentDeps {
  /** Engine for DB-backed ops (tools + message persistence + rate leases). */
  engine: BrainEngine;
  /** Anthropic client. Defaults to the SDK-constructed client. */
  client?: MessagesClient;
  /** OpenAI-compatible chat.completions client. Used when provider=openai-compat. */
  openaiClient?: OpenAIChatCompletionsClient;
  /** Provider for outbound subagent LLM calls. Defaults to GBRAIN_SUBAGENT_PROVIDER or anthropic. */
  provider?: SubagentProvider;
  /**
   * Anthropic SDK constructor. Defaults to `() => new Anthropic()`.
   * Overridable in tests so the factory default-client branch is
   * exercisable without an ANTHROPIC_API_KEY or a real API call.
   * When `deps.client` is provided, this is unused.
   */
  makeAnthropic?: () => Anthropic;
  /** OpenAI SDK constructor for provider=openai-compat. */
  makeOpenAI?: () => OpenAI;
  /** Config (MCP, brain, etc.). Defaults to loadConfig(). */
  config?: GBrainConfig;
  /** Rate-lease key. Defaults to `anthropic:messages`. */
  rateLeaseKey?: string;
  /** Max concurrent inflight calls on that key. Defaults to GBRAIN_ANTHROPIC_MAX_INFLIGHT or 8. */
  maxConcurrent?: number;
  /** Lease TTL. Defaults to 120s. */
  leaseTtlMs?: number;
  /**
   * Override tool registry. When omitted, buildBrainTools is called with
   * the caller's subagentId at dispatch time.
   */
  toolRegistry?: ToolDef[];
}

// ── Types for internal state ────────────────────────────────

interface PersistedMessage {
  message_idx: number;
  role: 'user' | 'assistant';
  content_blocks: ContentBlock[];
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cache_read: number | null;
  tokens_cache_create: number | null;
  model: string | null;
}

interface PersistedToolExec {
  message_idx: number;
  tool_use_id: string;
  tool_name: string;
  input: unknown;
  status: 'pending' | 'complete' | 'failed';
  output: unknown;
  error: string | null;
}

// ── Public handler factory ──────────────────────────────────

/**
 * Build a subagent handler bound to a specific engine. `registerBuiltin
 * Handlers` wires this up as `worker.register('subagent', handler)` at
 * worker startup. Always registered — `ANTHROPIC_API_KEY` is the natural
 * cost gate and `PROTECTED_JOB_NAMES` gates submission.
 */
export function makeSubagentHandler(deps: SubagentDeps) {
  const engine = deps.engine;
  // sdk.messages IS the MessagesClient-shaped object. The v0.16.0 bug was
  // casting new Anthropic() (top level) to MessagesClient, but .create()
  // lives at sdk.messages.create. Assigning sdk.messages directly gets the
  // right object; JS method-call semantics preserve `this` at the call
  // site (subagent.ts invokes client.create(...) with client === sdk.messages).
  const config = deps.config ?? loadConfig() ?? ({ engine: 'postgres' } as GBrainConfig);
  const provider = resolveSubagentProvider(deps.provider, config);
  const makeAnthropic = deps.makeAnthropic ?? (() => new Anthropic());
  const anthropicClient: MessagesClient | null = provider === 'anthropic'
    ? (deps.client ?? makeAnthropic().messages)
    : null;
  const makeOpenAI = deps.makeOpenAI ?? (() => {
    const apiKey = process.env.GBRAIN_SUBAGENT_API_KEY || process.env.OPENCODE_GO_API_KEY || process.env.OPENAI_API_KEY || 'sk-local';
    return new OpenAI({
      apiKey,
      ...(process.env.GBRAIN_SUBAGENT_BASE_URL ? { baseURL: process.env.GBRAIN_SUBAGENT_BASE_URL } : {}),
      ...(process.env.GBRAIN_SUBAGENT_API_KEY || process.env.OPENCODE_GO_API_KEY ? { defaultHeaders: { 'x-api-key': apiKey } } : {}),
    });
  });
  const openaiClient: OpenAIChatCompletionsClient | null = provider === 'openai-compat'
    ? (deps.openaiClient ?? (makeOpenAI().chat.completions as unknown as OpenAIChatCompletionsClient))
    : null;
  const rateLeaseKey = deps.rateLeaseKey ?? (provider === 'openai-compat' ? 'openai-compatible:chat' : DEFAULT_RATE_KEY);
  const maxConcurrent = deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const leaseTtlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;

  return async function subagentHandler(ctx: MinionJobContext): Promise<SubagentResult> {
    const data = (ctx.data ?? {}) as unknown as SubagentHandlerData;
    if (!data.prompt || typeof data.prompt !== 'string') {
      throw new Error('subagent job data.prompt is required (string)');
    }

    const model = data.model ?? resolveDefaultSubagentModel(provider, config);
    const maxTurns = data.max_turns ?? DEFAULT_MAX_TURNS;
    const systemPrompt = data.system ?? DEFAULT_SYSTEM;

    // Build the tool registry bound to THIS job as the owning subagent.
    // brain_id (per-call brain override; children inherit parent's unless
    // they set their own) and allowed_slug_prefixes (v0.23 trusted-workspace
    // allow-list — flows through buildBrainTools → the put_page schema
    // description AND the OperationContext, so the model's tool schema and
    // the server-side check stay in sync).
    const registry = deps.toolRegistry ?? buildBrainTools({
      subagentId: ctx.id,
      engine,
      config,
      brainId: data.brain_id,
      allowedSlugPrefixes: data.allowed_slug_prefixes,
    });
    const toolDefs = data.allowed_tools && data.allowed_tools.length > 0
      ? filterAllowedTools(registry, data.allowed_tools)
      : registry;

    logSubagentSubmission({
      caller: 'worker',
      remote: true,
      job_id: ctx.id,
      model,
      tools_count: toolDefs.length,
      allowed_tools: toolDefs.map(t => t.name),
    });

    // ── Load prior state (replay) ───────────────────────────
    const priorMessages = await loadPriorMessages(engine, ctx.id);
    const priorTools = await loadPriorTools(engine, ctx.id);
    const priorToolByUseId = new Map(priorTools.map(t => [t.tool_use_id, t]));

    // Rebuild the Anthropic messages array from persisted rows.
    const anthroMessages: Anthropic.MessageParam[] = priorMessages.length > 0
      ? priorMessages.map(m => ({ role: m.role, content: m.content_blocks as any }))
      : [{ role: 'user', content: data.prompt }];

    // If we had no prior messages, persist the seed user message.
    let nextMessageIdx = priorMessages.length;
    if (priorMessages.length === 0) {
      await persistMessage(engine, ctx.id, {
        message_idx: 0,
        role: 'user',
        content_blocks: [{ type: 'text', text: data.prompt }],
        tokens_in: null,
        tokens_out: null,
        tokens_cache_read: null,
        tokens_cache_create: null,
        model: null,
      });
      nextMessageIdx = 1;
    }

    // Token rollup.
    const tokenTotals = { in: 0, out: 0, cache_read: 0, cache_create: 0 };
    for (const m of priorMessages) {
      if (m.tokens_in) tokenTotals.in += m.tokens_in;
      if (m.tokens_out) tokenTotals.out += m.tokens_out;
      if (m.tokens_cache_read) tokenTotals.cache_read += m.tokens_cache_read;
      if (m.tokens_cache_create) tokenTotals.cache_create += m.tokens_cache_create;
    }

    // Count assistant messages already persisted toward max_turns.
    let assistantTurns = priorMessages.filter(m => m.role === 'assistant').length;

    // ── Replay reconciliation ───────────────────────────────
    //
    // If the last persisted message is an assistant with tool_use blocks
    // AND no subsequent user message has been synthesized yet, we crashed
    // mid-tool-dispatch. Finish those tools now so the next LLM call sees
    // a consistent conversation.
    const last = priorMessages[priorMessages.length - 1];
    if (last && last.role === 'assistant') {
      const pendingToolUses = last.content_blocks.filter(
        (b): b is { type: 'tool_use'; id: string; name: string; input: unknown } & Record<string, unknown> =>
          b.type === 'tool_use',
      );
      if (pendingToolUses.length > 0) {
        const synthesizedResults: ContentBlock[] = [];
        for (const use of pendingToolUses) {
          const prior = priorToolByUseId.get(use.id);
          if (prior?.status === 'complete') {
            synthesizedResults.push({
              type: 'tool_result',
              tool_use_id: use.id,
              content: asStringIfNotObject(prior.output),
            } as ContentBlock);
            continue;
          }
          if (prior?.status === 'failed') {
            synthesizedResults.push({
              type: 'tool_result',
              tool_use_id: use.id,
              content: prior.error ?? 'tool failed',
              is_error: true,
            } as ContentBlock);
            continue;
          }
          // pending or no row yet — try to dispatch.
          const toolDef = toolDefs.find(t => t.name === use.name);
          if (!toolDef) {
            await persistToolExecFailed(
              engine, ctx.id, last.message_idx, use.id, use.name, use.input,
              `tool "${use.name}" is not in the registry for this subagent`,
            );
            synthesizedResults.push({
              type: 'tool_result', tool_use_id: use.id,
              content: `tool "${use.name}" is not available`, is_error: true,
            } as ContentBlock);
            continue;
          }
          if (prior?.status === 'pending' && !toolDef.idempotent) {
            throw new Error(`non-idempotent tool "${use.name}" pending on resume; cannot safely re-run`);
          }
          await persistToolExecPending(engine, ctx.id, last.message_idx, use.id, use.name, use.input);
          try {
            const output = await toolDef.execute(use.input, {
              engine, jobId: ctx.id, remote: true, signal: ctx.signal,
            });
            await persistToolExecComplete(engine, ctx.id, use.id, output);
            synthesizedResults.push({
              type: 'tool_result', tool_use_id: use.id,
              content: asStringIfNotObject(output),
            } as ContentBlock);
          } catch (e) {
            const errText = e instanceof Error ? (e.stack ?? e.message) : String(e);
            await persistToolExecFailed(engine, ctx.id, last.message_idx, use.id, use.name, use.input, errText);
            synthesizedResults.push({
              type: 'tool_result', tool_use_id: use.id,
              content: errText, is_error: true,
            } as ContentBlock);
          }
        }
        // Persist the synthesized user turn so next-resume picks up here.
        const userIdx = nextMessageIdx++;
        await persistMessage(engine, ctx.id, {
          message_idx: userIdx,
          role: 'user',
          content_blocks: synthesizedResults,
          tokens_in: null, tokens_out: null, tokens_cache_read: null, tokens_cache_create: null, model: null,
        });
        anthroMessages.push({ role: 'user', content: synthesizedResults as any });
      }
    }

    // ── Main loop ───────────────────────────────────────────
    let stopReason: SubagentStopReason = 'error';
    let finalText = '';

    while (true) {
      if (assistantTurns >= maxTurns) {
        stopReason = 'max_turns';
        break;
      }
      if (ctx.signal.aborted || ctx.shutdownSignal.aborted) {
        stopReason = 'error';
        throw new Error('subagent aborted before turn');
      }

      // 1. Acquire rate lease for the outbound call.
      const lease = await acquireLease(engine, rateLeaseKey, ctx.id, maxConcurrent, { ttlMs: leaseTtlMs });
      if (!lease.acquired) {
        // No slots — treat as a renewable error so the worker re-claims
        // the job later. Don't fail terminally.
        throw new RateLeaseUnavailableError(rateLeaseKey, lease.activeCount, lease.maxConcurrent);
      }

      let assistantMsg: Anthropic.Message;
      const turnIdx = assistantTurns;
      const t0 = Date.now();
      logSubagentHeartbeat({ job_id: ctx.id, event: 'llm_call_started', turn_idx: turnIdx });

      // Renewal is short-lived; for single-call turns the initial TTL
      // covers the whole request. A mid-call renewal loop would add
      // complexity; for v0.15 we lean on the 120s TTL + abort-on-signal.
      try {
        const params: Anthropic.MessageCreateParamsNonStreaming = {
          model,
          max_tokens: 4096,
          system: [
            { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
          ] as any,
          messages: anthroMessages,
          ...(toolDefs.length > 0
            ? {
                tools: toolDefs.map((t, i) => {
                  const def: any = {
                    name: t.name,
                    description: t.description,
                    input_schema: t.input_schema,
                  };
                  // Cache only the last tool def — Anthropic treats cache_control
                  // as "cache everything up to and including this block".
                  if (i === toolDefs.length - 1) def.cache_control = { type: 'ephemeral' };
                  return def;
                }),
              }
            : {}),
        };

        const combinedSignal = mergeSignals(ctx.signal, ctx.shutdownSignal);
        assistantMsg = await createSubagentMessage({
          provider,
          anthropicClient,
          openaiClient,
          params,
          signal: combinedSignal,
        });
      } catch (err) {
        // Release lease eagerly on error so we don't starve capacity.
        await releaseLease(engine, lease.leaseId!).catch(() => {});
        throw err;
      }

      // 2. Release lease as soon as the call returns. Tool execution runs
      //    outside the lease — tool calls use their own capacity.
      await releaseLease(engine, lease.leaseId!).catch(() => {});

      const ms = Date.now() - t0;
      const inTokens = assistantMsg.usage?.input_tokens ?? 0;
      const outTokens = assistantMsg.usage?.output_tokens ?? 0;
      const cacheRead = (assistantMsg.usage as any)?.cache_read_input_tokens ?? 0;
      const cacheCreate = (assistantMsg.usage as any)?.cache_creation_input_tokens ?? 0;

      tokenTotals.in += inTokens;
      tokenTotals.out += outTokens;
      tokenTotals.cache_read += cacheRead;
      tokenTotals.cache_create += cacheCreate;

      logSubagentHeartbeat({
        job_id: ctx.id,
        event: 'llm_call_completed',
        turn_idx: turnIdx,
        ms_elapsed: ms,
        tokens: { in: inTokens, out: outTokens, cache_read: cacheRead, cache_create: cacheCreate },
      });

      // Update job-level token rollup (best-effort; may throw if lock lost).
      await ctx.updateTokens({
        input: inTokens,
        output: outTokens,
        cache_read: cacheRead,
      });

      const blocks = assistantMsg.content as ContentBlock[];

      // 3. Persist the assistant message BEFORE tool dispatch so replay
      //    sees a consistent state.
      const assistantIdx = nextMessageIdx++;
      await persistMessage(engine, ctx.id, {
        message_idx: assistantIdx,
        role: 'assistant',
        content_blocks: blocks,
        tokens_in: inTokens,
        tokens_out: outTokens,
        tokens_cache_read: cacheRead,
        tokens_cache_create: cacheCreate,
        model,
      });
      anthroMessages.push({ role: 'assistant', content: blocks as any });
      assistantTurns++;

      // 4. Collect tool_use blocks. If none, we're done.
      const toolUses = blocks.filter(
        (b): b is { type: 'tool_use'; id: string; name: string; input: unknown } & Record<string, unknown> =>
          b.type === 'tool_use',
      );
      if (toolUses.length === 0) {
        stopReason = 'end_turn';
        // Concatenate text blocks as the final answer.
        finalText = blocks
          .filter(b => b.type === 'text' && typeof b.text === 'string')
          .map(b => b.text as string)
          .join('\n');
        break;
      }

      // 5. Dispatch each tool_use. Two-phase persist (pending → complete/failed).
      const toolResults: ContentBlock[] = [];
      for (const use of toolUses) {
        if (ctx.signal.aborted || ctx.shutdownSignal.aborted) {
          throw new Error('subagent aborted during tool dispatch');
        }

        const toolName = use.name;
        const toolDef = toolDefs.find(t => t.name === toolName);
        if (!toolDef) {
          // Model called a tool we didn't expose. Mark execution failed
          // with a clear error and feed the error back in the next turn.
          await persistToolExecFailed(
            engine, ctx.id, assistantIdx, use.id, toolName, use.input,
            `tool "${toolName}" is not in the registry for this subagent`,
          );
          toolResults.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: `tool "${toolName}" is not available`,
            is_error: true,
          } as ContentBlock);
          logSubagentHeartbeat({
            job_id: ctx.id,
            event: 'tool_failed',
            turn_idx: turnIdx,
            tool_name: toolName,
            error: 'not in registry',
          });
          continue;
        }

        // Replay: if we already have a row for this tool_use_id, trust it
        // unless status='pending' and the tool is idempotent (re-run).
        const prior = priorToolByUseId.get(use.id);
        if (prior && prior.status === 'complete') {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: asStringIfNotObject(prior.output),
          } as ContentBlock);
          continue;
        }
        if (prior && prior.status === 'failed') {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: prior.error ?? 'tool failed',
            is_error: true,
          } as ContentBlock);
          continue;
        }
        if (prior && prior.status === 'pending' && !toolDef.idempotent) {
          // Non-idempotent and we don't know the outcome — fail the job.
          throw new Error(`non-idempotent tool "${toolName}" pending on resume; cannot safely re-run`);
        }

        // Fresh or idempotent-replay dispatch.
        await persistToolExecPending(engine, ctx.id, assistantIdx, use.id, toolName, use.input);
        logSubagentHeartbeat({ job_id: ctx.id, event: 'tool_called', turn_idx: turnIdx, tool_name: toolName });

        const toolStart = Date.now();
        try {
          const output = await toolDef.execute(use.input, {
            engine,
            jobId: ctx.id,
            remote: true,
            signal: ctx.signal,
          });
          await persistToolExecComplete(engine, ctx.id, use.id, output);
          logSubagentHeartbeat({
            job_id: ctx.id,
            event: 'tool_result',
            turn_idx: turnIdx,
            tool_name: toolName,
            ms_elapsed: Date.now() - toolStart,
          });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: asStringIfNotObject(output),
          } as ContentBlock);
        } catch (e) {
          const errText = e instanceof Error
            ? (e.stack ?? e.message)
            : String(e);
          await persistToolExecFailed(engine, ctx.id, assistantIdx, use.id, toolName, use.input, errText);
          logSubagentHeartbeat({
            job_id: ctx.id,
            event: 'tool_failed',
            turn_idx: turnIdx,
            tool_name: toolName,
            ms_elapsed: Date.now() - toolStart,
            error: errText,
          });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: errText,
            is_error: true,
          } as ContentBlock);
        }
      }

      // 6. Append the synthesized user turn (tool_result wrappers) to the
      //    conversation and persist it so replay picks it up.
      const userIdx = nextMessageIdx++;
      await persistMessage(engine, ctx.id, {
        message_idx: userIdx,
        role: 'user',
        content_blocks: toolResults,
        tokens_in: null,
        tokens_out: null,
        tokens_cache_read: null,
        tokens_cache_create: null,
        model: null,
      });
      anthroMessages.push({ role: 'user', content: toolResults as any });
    }

    return {
      result: finalText,
      turns_count: assistantTurns,
      stop_reason: stopReason,
      tokens: tokenTotals,
    };
  };
}

// ── Internal: persistence ───────────────────────────────────

async function loadPriorMessages(engine: BrainEngine, jobId: number): Promise<PersistedMessage[]> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT message_idx, role, content_blocks, tokens_in, tokens_out,
            tokens_cache_read, tokens_cache_create, model
       FROM subagent_messages
      WHERE job_id = $1
      ORDER BY message_idx ASC`,
    [jobId],
  );
  return rows.map(r => ({
    message_idx: r.message_idx as number,
    role: r.role as 'user' | 'assistant',
    content_blocks: (typeof r.content_blocks === 'string'
      ? JSON.parse(r.content_blocks as string)
      : r.content_blocks) as ContentBlock[],
    tokens_in: (r.tokens_in as number) ?? null,
    tokens_out: (r.tokens_out as number) ?? null,
    tokens_cache_read: (r.tokens_cache_read as number) ?? null,
    tokens_cache_create: (r.tokens_cache_create as number) ?? null,
    model: (r.model as string) ?? null,
  }));
}

async function loadPriorTools(engine: BrainEngine, jobId: number): Promise<PersistedToolExec[]> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT message_idx, tool_use_id, tool_name, input, status, output, error
       FROM subagent_tool_executions
      WHERE job_id = $1`,
    [jobId],
  );
  return rows.map(r => ({
    message_idx: r.message_idx as number,
    tool_use_id: r.tool_use_id as string,
    tool_name: r.tool_name as string,
    input: typeof r.input === 'string' ? JSON.parse(r.input) : r.input,
    status: r.status as 'pending' | 'complete' | 'failed',
    output: r.output == null
      ? null
      : (typeof r.output === 'string' ? JSON.parse(r.output) : r.output),
    error: (r.error as string) ?? null,
  }));
}

async function persistMessage(engine: BrainEngine, jobId: number, msg: PersistedMessage): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO subagent_messages (job_id, message_idx, role, content_blocks,
        tokens_in, tokens_out, tokens_cache_read, tokens_cache_create, model)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)
     ON CONFLICT (job_id, message_idx) DO NOTHING`,
    [
      jobId,
      msg.message_idx,
      msg.role,
      JSON.stringify(msg.content_blocks),
      msg.tokens_in,
      msg.tokens_out,
      msg.tokens_cache_read,
      msg.tokens_cache_create,
      msg.model,
    ],
  );
}

async function persistToolExecPending(
  engine: BrainEngine,
  jobId: number,
  messageIdx: number,
  toolUseId: string,
  toolName: string,
  input: unknown,
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO subagent_tool_executions (job_id, message_idx, tool_use_id, tool_name, input, status)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'pending')
     ON CONFLICT (job_id, tool_use_id) DO NOTHING`,
    [jobId, messageIdx, toolUseId, toolName, JSON.stringify(input)],
  );
}

async function persistToolExecComplete(
  engine: BrainEngine,
  jobId: number,
  toolUseId: string,
  output: unknown,
): Promise<void> {
  await engine.executeRaw(
    `UPDATE subagent_tool_executions
        SET status = 'complete', output = $3::jsonb, ended_at = now()
      WHERE job_id = $1 AND tool_use_id = $2`,
    [jobId, toolUseId, JSON.stringify(output)],
  );
}

async function persistToolExecFailed(
  engine: BrainEngine,
  jobId: number,
  messageIdx: number,
  toolUseId: string,
  toolName: string,
  input: unknown,
  error: string,
): Promise<void> {
  // INSERT-or-UPDATE to failed — covers both "no pending row yet" (tool
  // rejected upfront) and "pending row exists" (tool threw mid-execute).
  await engine.executeRaw(
    `INSERT INTO subagent_tool_executions (job_id, message_idx, tool_use_id, tool_name, input, status, error, ended_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'failed', $6, now())
     ON CONFLICT (job_id, tool_use_id) DO UPDATE
       SET status = 'failed', error = EXCLUDED.error, ended_at = now()`,
    [jobId, messageIdx, toolUseId, toolName, JSON.stringify(input), error],
  );
}

// ── Internal: provider adapters ──────────────────────────────

function resolveSubagentProvider(explicit: SubagentProvider | undefined, config: GBrainConfig): SubagentProvider {
  if (explicit) return explicit;
  const env = process.env.GBRAIN_SUBAGENT_PROVIDER;
  if (env === 'anthropic' || env === 'openai-compat') return env;
  const cfgProvider = (config as unknown as { subagent_provider?: string }).subagent_provider;
  if (cfgProvider === 'anthropic' || cfgProvider === 'openai-compat') return cfgProvider;
  return 'anthropic';
}

function resolveDefaultSubagentModel(provider: SubagentProvider, config: GBrainConfig): string {
  if (provider === 'openai-compat') {
    const cfgModel = (config as unknown as { subagent_model?: string }).subagent_model;
    return process.env.GBRAIN_SUBAGENT_MODEL || cfgModel || 'gpt-4o-mini';
  }
  return DEFAULT_MODEL;
}

async function createSubagentMessage(opts: {
  provider: SubagentProvider;
  anthropicClient: MessagesClient | null;
  openaiClient: OpenAIChatCompletionsClient | null;
  params: Anthropic.MessageCreateParamsNonStreaming;
  signal: AbortSignal;
}): Promise<Anthropic.Message> {
  if (opts.provider === 'anthropic') {
    if (!opts.anthropicClient) throw new Error('anthropic subagent provider selected but no Anthropic client is configured');
    return opts.anthropicClient.create(opts.params, { signal: opts.signal });
  }

  if (!opts.openaiClient) throw new Error('openai-compatible subagent provider selected but no chat client is configured');
  const response = await opts.openaiClient.create(toOpenAIChatParams(opts.params), { signal: opts.signal });
  return fromOpenAIChatCompletion(response, opts.params.model);
}

function toOpenAIChatParams(params: Anthropic.MessageCreateParamsNonStreaming): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  const systemText = anthropicSystemToText(params.system);
  if (systemText) messages.push({ role: 'system', content: systemText });

  for (const msg of params.messages) {
    messages.push(...anthropicMessageToOpenAI(msg as Anthropic.MessageParam));
  }

  return {
    model: params.model,
    max_tokens: params.max_tokens,
    messages,
    ...(params.tools && params.tools.length > 0
      ? { tools: params.tools.map(toolToOpenAI), tool_choice: 'auto' }
      : {}),
  };
}

function anthropicSystemToText(system: Anthropic.MessageCreateParamsNonStreaming['system']): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .map((block: any) => block?.type === 'text' && typeof block.text === 'string' ? block.text : '')
      .filter(Boolean)
      .join('\n');
  }
  return String(system);
}

function anthropicMessageToOpenAI(msg: Anthropic.MessageParam): Record<string, unknown>[] {
  const content = msg.content as any;
  if (typeof content === 'string') return [{ role: msg.role, content }];
  if (!Array.isArray(content)) return [{ role: msg.role, content: asStringIfNotObject(content) }];

  if (msg.role === 'user') {
    const out: Record<string, unknown>[] = [];
    const text = content
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('\n');
    if (text) out.push({ role: 'user', content: text });
    for (const block of content) {
      if (block?.type === 'tool_result') {
        out.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: asStringIfNotObject(block.content ?? ''),
        });
      }
    }
    return out.length > 0 ? out : [{ role: 'user', content: '' }];
  }

  const text = content
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('\n');
  const toolCalls = content
    .filter((b: any) => b?.type === 'tool_use')
    .map((b: any) => ({
      id: b.id,
      type: 'function',
      function: { name: b.name, arguments: asStringIfNotObject(b.input ?? {}) },
    }));
  return [{
    role: 'assistant',
    content: text || null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }];
}

function toolToOpenAI(tool: any): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  };
}

function fromOpenAIChatCompletion(response: Record<string, unknown>, model: string): Anthropic.Message {
  const choices = response.choices as any[] | undefined;
  const choice = choices?.[0] ?? {};
  const message = choice.message ?? {};
  const blocks: ContentBlock[] = [];

  if (typeof message.content === 'string' && message.content.length > 0) {
    blocks.push({ type: 'text', text: message.content } as ContentBlock);
  }
  for (const call of message.tool_calls ?? []) {
    blocks.push({
      type: 'tool_use',
      id: call.id,
      name: call.function?.name,
      input: parseToolArguments(call.function?.arguments),
    } as ContentBlock);
  }

  const usage = (response.usage ?? {}) as Record<string, number>;
  return {
    id: String(response.id ?? 'chatcmpl_openai_compat'),
    type: 'message',
    role: 'assistant',
    model: String(response.model ?? model),
    stop_reason: blocks.some((b: any) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    content: blocks as Anthropic.Message['content'],
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    } as any,
  } as Anthropic.Message;
}

function parseToolArguments(args: unknown): unknown {
  if (typeof args !== 'string') return args ?? {};
  try {
    return JSON.parse(args);
  } catch {
    return { raw: args };
  }
}

// ── Internal: helpers ───────────────────────────────────────

function asStringIfNotObject(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Merge two AbortSignals into one. Fires when either source aborts. No-op
 * polyfill when AbortSignal.any isn't available yet (Node ≥ 20 has it).
 */
function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyFn = (AbortSignal as any).any;
  if (typeof anyFn === 'function') return anyFn([a, b]) as AbortSignal;
  // Manual merge.
  const ac = new AbortController();
  if (a.aborted || b.aborted) ac.abort();
  else {
    a.addEventListener('abort', () => ac.abort(), { once: true });
    b.addEventListener('abort', () => ac.abort(), { once: true });
  }
  return ac.signal;
}

/**
 * Error thrown when acquireLease returns acquired=false. The worker
 * treats this as a renewable error — job goes back to waiting with
 * backoff, no terminal fail.
 */
export class RateLeaseUnavailableError extends Error {
  constructor(public key: string, public active: number, public max: number) {
    super(`rate lease "${key}" full (${active}/${max})`);
    this.name = 'RateLeaseUnavailableError';
  }
}

// ── Testing surface ─────────────────────────────────────────

export const __testing = {
  loadPriorMessages,
  loadPriorTools,
  persistMessage,
  persistToolExecPending,
  persistToolExecComplete,
  persistToolExecFailed,
  asStringIfNotObject,
  DEFAULT_MODEL,
};
