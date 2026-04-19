import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { EngineConfig } from './types.ts';

// Lazy-evaluated to avoid calling homedir() at module scope (breaks in serverless/bundled environments)
function getConfigDir() { return join(homedir(), '.gbrain'); }
function getConfigPath() { return join(getConfigDir(), 'config.json'); }

export interface GBrainConfig {
  engine: 'postgres' | 'pglite';
  database_url?: string;
  database_path?: string;
  openai_api_key?: string;
  anthropic_api_key?: string;

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

  return {
    ...fileConfig,
    engine: inferredEngine,
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

// Embedding config resolution with defaults. Returns values the embedding client should use.
export function resolveEmbeddingConfig(): {
  baseURL: string | undefined;
  apiKey: string;
  model: string;
  dimensions: number;
} {
  const config = loadConfig();
  return {
    baseURL: config?.embedding_base_url,
    apiKey: config?.openai_api_key || process.env.OPENAI_API_KEY || 'sk-local',
    model: config?.embedding_model || 'text-embedding-3-large',
    dimensions: config?.embedding_dimensions || 1536,
  };
}
