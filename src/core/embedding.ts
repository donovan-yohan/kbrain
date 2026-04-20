/**
 * Embedding Service
 *
 * OpenAI-compatible embedding client. Supports cloud OpenAI, Ollama,
 * text-embeddings-inference, LM Studio, vLLM, llama.cpp server, or any
 * other server that speaks the OpenAI embeddings API shape.
 *
 * Configure via env vars or ~/.gbrain/config.json:
 *   EMBEDDING_BASE_URL     e.g. http://localhost:8080/v1
 *   EMBEDDING_MODEL        e.g. mixedbread-ai/mxbai-embed-large-v1
 *   EMBEDDING_DIMENSIONS   e.g. 1024
 *
 * Retry with exponential backoff (4s base, 120s cap, 5 retries).
 * 8000 character input truncation.
 */

import OpenAI from 'openai';
import { resolveEmbeddingConfig } from './config.ts';

const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

let client: OpenAI | null = null;
let cachedModel: string | null = null;
let cachedDimensions: number | null = null;
let cachedBaseURL: string | undefined;
let cachedIsCloudOpenAI = true;

function getClient(): { client: OpenAI; model: string; dimensions: number; isCloudOpenAI: boolean } {
  const cfg = resolveEmbeddingConfig();
  // Recreate the client if the baseURL changed so the request shape (dimensions
  // param is cloud-only) and endpoint stay consistent with the cached flags.
  if (!client || cfg.baseURL !== cachedBaseURL) {
    client = new OpenAI({
      apiKey: cfg.apiKey,
      ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
    });
    cachedBaseURL = cfg.baseURL;
    cachedIsCloudOpenAI = !cfg.baseURL;
    cachedModel = cfg.model;
    cachedDimensions = cfg.dimensions;
  }
  return {
    client,
    model: cachedModel!,
    dimensions: cachedDimensions!,
    isCloudOpenAI: cachedIsCloudOpenAI,
  };
}

export async function embed(text: string): Promise<Float32Array> {
  const truncated = text.slice(0, MAX_CHARS);
  const result = await embedBatch([truncated]);
  return result[0];
}

export interface EmbedBatchOptions {
  /**
   * Optional callback fired after each 100-item sub-batch completes.
   * CLI wrappers tick a reporter; Minion handlers can call
   * job.updateProgress here instead of hooking the per-page callback.
   */
  onBatchComplete?: (done: number, total: number) => void;
}

export async function embedBatch(
  texts: string[],
  options: EmbedBatchOptions = {},
): Promise<Float32Array[]> {
  const truncated = texts.map(t => t.slice(0, MAX_CHARS));
  const results: Float32Array[] = [];

  for (let i = 0; i < truncated.length; i += BATCH_SIZE) {
    const batch = truncated.slice(i, i + BATCH_SIZE);
    const batchResults = await embedBatchWithRetry(batch);
    results.push(...batchResults);
    options.onBatchComplete?.(results.length, truncated.length);
  }

  return results;
}

async function embedBatchWithRetry(texts: string[]): Promise<Float32Array[]> {
  const { client: openai, model, dimensions, isCloudOpenAI } = getClient();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const request: {
        model: string;
        input: string[];
        dimensions?: number;
      } = {
        model,
        input: texts,
      };
      // Only send `dimensions` to cloud OpenAI — local servers emit native dim.
      if (isCloudOpenAI) request.dimensions = dimensions;

      const response = await openai.embeddings.create(request);

      // Validate dimension matches expectation
      const actualDim = response.data[0]?.embedding.length;
      if (actualDim && actualDim !== dimensions) {
        throw new Error(
          `Embedding dimension mismatch: model "${model}" emitted ${actualDim} dim, ` +
          `but config expects ${dimensions}. Update EMBEDDING_DIMENSIONS or pick a different model.`
        );
      }

      const sorted = response.data.sort((a, b) => a.index - b.index);
      return sorted.map(d => new Float32Array(d.embedding));
    } catch (e: unknown) {
      if (attempt === MAX_RETRIES - 1) throw e;

      // Don't retry dimension mismatch — user config error, not transient
      if (e instanceof Error && e.message.includes('Embedding dimension mismatch')) throw e;

      let delay = exponentialDelay(attempt);
      if (e instanceof OpenAI.APIError && e.status === 429) {
        const retryAfter = e.headers?.['retry-after'];
        if (retryAfter) {
          const parsed = parseInt(retryAfter, 10);
          if (!isNaN(parsed)) delay = parsed * 1000;
        }
      }
      await sleep(delay);
    }
  }

  throw new Error('Embedding failed after all retries');
}

function exponentialDelay(attempt: number): number {
  const delay = BASE_DELAY_MS * Math.pow(2, attempt);
  return Math.min(delay, MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Runtime-resolved model + dim for callers that inspect current config
export function getEmbeddingModel(): string {
  return resolveEmbeddingConfig().model;
}

export function getEmbeddingDimensions(): number {
  return resolveEmbeddingConfig().dimensions;
}

// Backward-compat named exports. Treat these as hints for old callers — the real
// values come from resolveEmbeddingConfig() at runtime.
export const EMBEDDING_MODEL = 'text-embedding-3-large';
export const EMBEDDING_DIMENSIONS = 1536;

// Reset client (useful for tests that mutate env between runs)
export function resetEmbeddingClient(): void {
  client = null;
  cachedModel = null;
  cachedDimensions = null;
  cachedBaseURL = undefined;
  cachedIsCloudOpenAI = true;
}
