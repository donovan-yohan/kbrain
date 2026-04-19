import { SCHEMA_SQL } from './schema-embedded.ts';
import { PGLITE_SCHEMA_SQL } from './pglite-schema.ts';
import { resolveEmbeddingConfig } from './config.ts';

/**
 * Substitute {{EMBEDDING_DIM}} and {{EMBEDDING_MODEL}} placeholders in the
 * canonical schema with actual embedding config values.
 *
 * Defaults (1536 / text-embedding-3-large) preserve backward compatibility
 * with brains initialized before this substitution layer existed — existing
 * brains created with those values continue to work without migration.
 */
export function renderSchema(opts: { dimensions?: number; model?: string } = {}): string {
  return substitute(SCHEMA_SQL, opts);
}

export function renderPGLiteSchema(opts: { dimensions?: number; model?: string } = {}): string {
  return substitute(PGLITE_SCHEMA_SQL, opts);
}

function substitute(sql: string, opts: { dimensions?: number; model?: string }): string {
  const cfg = resolveEmbeddingConfig();
  const dim = opts.dimensions ?? cfg.dimensions;
  const model = opts.model ?? cfg.model;
  return sql
    .replace(/\{\{EMBEDDING_DIM\}\}/g, String(dim))
    .replace(/\{\{EMBEDDING_MODEL\}\}/g, model);
}
