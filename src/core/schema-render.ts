import { SCHEMA_SQL } from './schema-embedded.ts';
import { getPGLiteSchema } from './pglite-schema.ts';

const DEFAULT_DIMS = 1536;
const DEFAULT_MODEL = 'text-embedding-3-large';

/**
 * Substitute embedding dim + model into the canonical Postgres schema SQL.
 *
 * Upstream's pattern: literal `vector(1536)` + `'text-embedding-3-large'` in the
 * source schema, replaced at render time. Defaults preserve backward compat with
 * brains initialized before this layer existed.
 */
export function renderSchema(opts: { dimensions?: number; model?: string } = {}): string {
  const { dim, model } = resolve(opts);
  return SCHEMA_SQL
    .replace(/vector\(1536\)/g, `vector(${dim})`)
    .replace(/'text-embedding-3-large'/g, `'${model.replace(/'/g, "''")}'`);
}

/** PGLite path delegates to upstream's substitution helper. */
export function renderPGLiteSchema(opts: { dimensions?: number; model?: string } = {}): string {
  const { dim, model } = resolve(opts);
  return getPGLiteSchema(dim, model);
}

function resolve(opts: { dimensions?: number; model?: string }): { dim: number; model: string } {
  let dim = opts.dimensions ?? DEFAULT_DIMS;
  let model = opts.model ?? DEFAULT_MODEL;
  if (opts.dimensions === undefined || opts.model === undefined) {
    try {
      const gw = require('./ai/gateway.ts');
      if (opts.dimensions === undefined) dim = gw.getEmbeddingDimensions();
      if (opts.model === undefined) {
        const m = gw.getEmbeddingModel();
        model = m.split(':').slice(1).join(':') || m;
      }
    } catch {
      // Gateway not configured (e.g. tests, init pre-config) — defaults.
    }
  }
  if (!Number.isInteger(dim) || dim <= 0 || dim > 16000) {
    throw new Error(
      `Invalid embedding dimensions: ${dim}. Must be a positive integer (pgvector caps at 16000).`,
    );
  }
  return { dim, model };
}
