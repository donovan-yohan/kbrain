import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { EngineConfig } from './types.ts';
import { DEFAULT_PROFILE_ID, resolveProfileId } from './profiles/catalog.ts';

/**
 * Where is the active DB URL coming from? Pure introspection, no connection
 * attempt. Used by `gbrain doctor --fast` so the user gets a precise message
 * instead of the misleading "No database configured" when GBRAIN_DATABASE_URL
 * (or DATABASE_URL) is actually set.
 *
 * Precedence matches loadConfig(): env vars win over config-file URL. Returns
 * null only when NO source provides a URL at all.
 */
export type DbUrlSource =
  | 'env:GBRAIN_DATABASE_URL'
  | 'env:DATABASE_URL'
  | 'config-file'
  | 'config-file-path' // PGLite: config file present, no URL but database_path set
  | null;

// Lazy-evaluated to avoid calling homedir() at module scope (breaks in serverless/bundled environments)
function getConfigDir() { return join(homedir(), '.gbrain'); }
function getConfigPath() { return join(getConfigDir(), 'config.json'); }

export interface GBrainConfig {
  engine: 'postgres' | 'pglite';
  database_url?: string;
  database_path?: string;
  profile_id?: 'general-assistant' | 'research-wiki' | 'private-finance';
  policy_id?: string;
  brain_scope?: 'general' | 'private';
  brain_routing_strategy?: 'single' | 'dual-hermes-routed';
  openai_api_key?: string;
  anthropic_api_key?: string;
  /**
   * Optional storage backend config (S3/Supabase/local). Shape matches
   * `StorageConfig` in `./storage.ts`. Typed as `unknown` here to avoid
   * a cyclic import; callers pass this through `createStorage()` which
   * validates the shape at runtime.
   */
  storage?: unknown;
  groq_api_key?: string;
  deepgram_api_key?: string;

  // Embedding provider (OpenAI-compatible)
  embedding_base_url?: string;
  embedding_model?: string;
  embedding_dimensions?: number;

  // Chat provider for query expansion
  // 'anthropic' (default) uses Anthropic SDK; 'openai-compat' uses OpenAI SDK with any compatible server
  expansion_provider?: 'anthropic' | 'openai-compat';
  expansion_base_url?: string;
  expansion_model?: string;
  expansion_api_key?: string;

  // Audio transcription (OpenAI-compatible Whisper endpoint)
  transcription_base_url?: string;
  transcription_model?: string;
  transcription_api_key?: string;
}

/**
 * Load config with credential precedence: env vars > config file.
 * Plugin config is handled by the plugin runtime injecting env vars.
 */
export function loadConfig(): GBrainConfig | null {
  let fileConfig: GBrainConfig | null = null;
  try {
    const raw = readFileSync(getConfigPath(), 'utf-8');
    fileConfig = JSON.parse(raw) as GBrainConfig;
  } catch { /* no config file */ }

  const dbUrl = process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL;

  if (!fileConfig && !dbUrl) return null;

  const inferredEngine: 'postgres' | 'pglite' = fileConfig?.engine
    || (fileConfig?.database_path ? 'pglite' : 'postgres');

  // Env vars override config file
  const envOverrides: Partial<GBrainConfig> = {};
  if (dbUrl) envOverrides.database_url = dbUrl;
  if (process.env.OPENAI_API_KEY) envOverrides.openai_api_key = process.env.OPENAI_API_KEY;
  if (process.env.ANTHROPIC_API_KEY) envOverrides.anthropic_api_key = process.env.ANTHROPIC_API_KEY;
  if (process.env.GROQ_API_KEY) envOverrides.groq_api_key = process.env.GROQ_API_KEY;
  if (process.env.DEEPGRAM_API_KEY) envOverrides.deepgram_api_key = process.env.DEEPGRAM_API_KEY;
  if (process.env.OPENAI_BASE_URL) envOverrides.embedding_base_url = process.env.OPENAI_BASE_URL;
  if (process.env.EMBEDDING_BASE_URL) envOverrides.embedding_base_url = process.env.EMBEDDING_BASE_URL;
  if (process.env.EMBEDDING_MODEL) envOverrides.embedding_model = process.env.EMBEDDING_MODEL;
  if (process.env.EMBEDDING_DIMENSIONS) {
    const n = parseInt(process.env.EMBEDDING_DIMENSIONS, 10);
    if (!isNaN(n) && n > 0) envOverrides.embedding_dimensions = n;
  }
  if (process.env.EXPANSION_PROVIDER === 'anthropic' || process.env.EXPANSION_PROVIDER === 'openai-compat') {
    envOverrides.expansion_provider = process.env.EXPANSION_PROVIDER;
  }
  if (process.env.EXPANSION_BASE_URL) envOverrides.expansion_base_url = process.env.EXPANSION_BASE_URL;
  if (process.env.EXPANSION_MODEL) envOverrides.expansion_model = process.env.EXPANSION_MODEL;
  if (process.env.EXPANSION_API_KEY) envOverrides.expansion_api_key = process.env.EXPANSION_API_KEY;
  if (process.env.TRANSCRIPTION_BASE_URL) envOverrides.transcription_base_url = process.env.TRANSCRIPTION_BASE_URL;
  if (process.env.TRANSCRIPTION_MODEL) envOverrides.transcription_model = process.env.TRANSCRIPTION_MODEL;
  if (process.env.TRANSCRIPTION_API_KEY) envOverrides.transcription_api_key = process.env.TRANSCRIPTION_API_KEY;
  if (process.env.GBRAIN_PROFILE_ID) envOverrides.profile_id = resolveProfileId(process.env.GBRAIN_PROFILE_ID);

  return {
    ...fileConfig,
    engine: inferredEngine,
    profile_id: resolveProfileId(fileConfig?.profile_id || envOverrides.profile_id || DEFAULT_PROFILE_ID),
    ...envOverrides,
  } as GBrainConfig;
}

export function saveConfig(config: GBrainConfig): void {
  mkdirSync(getConfigDir(), { recursive: true });
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(getConfigPath(), 0o600);
  } catch {
    // chmod may fail on some platforms
  }
}

export function toEngineConfig(config: GBrainConfig): EngineConfig {
  return {
    engine: config.engine,
    database_url: config.database_url,
    database_path: config.database_path,
  };
}

export function configDir(): string {
  return join(homedir(), '.gbrain');
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}

/**
 * Introspect where the active DB URL would come from if we tried to connect.
 * Never throws, never connects. Env vars take precedence (matches loadConfig).
 */
export function getDbUrlSource(): DbUrlSource {
  if (process.env.GBRAIN_DATABASE_URL) return 'env:GBRAIN_DATABASE_URL';
  if (process.env.DATABASE_URL) return 'env:DATABASE_URL';
  if (!existsSync(configPath())) return null;
  try {
    const raw = readFileSync(configPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<GBrainConfig>;
    if (parsed.database_url) return 'config-file';
    if (parsed.database_path) return 'config-file-path';
    return null;
  } catch {
    // Config file exists but is unreadable/malformed — treat as null source.
    return null;
  }
}

// Embedding config resolution with defaults. Returns values the embedding client should use.
//
// Reads env vars directly (not only through loadConfig) so that first-run
// workflows work correctly — gbrain init calls initSchema() before any config
// file exists, and loadConfig() returns null when there's no config file and
// no DATABASE_URL. Without this direct read, EMBEDDING_DIMENSIONS would be
// ignored on first init and the pgvector column would be created with the
// default 1536 dimensions even when the user requested something else.
export function resolveEmbeddingConfig(): {
  baseURL: string | undefined;
  apiKey: string;
  model: string;
  dimensions: number;
} {
  const config = loadConfig();
  const envBaseURL = process.env.EMBEDDING_BASE_URL || process.env.OPENAI_BASE_URL;
  const envModel = process.env.EMBEDDING_MODEL;
  let envDim: number | undefined;
  if (process.env.EMBEDDING_DIMENSIONS) {
    const n = parseInt(process.env.EMBEDDING_DIMENSIONS, 10);
    if (!isNaN(n) && n > 0) envDim = n;
  }
  return {
    baseURL: config?.embedding_base_url || envBaseURL,
    apiKey: config?.openai_api_key || process.env.OPENAI_API_KEY || 'sk-local',
    model: config?.embedding_model || envModel || 'text-embedding-3-large',
    dimensions: config?.embedding_dimensions || envDim || 1536,
  };
}
