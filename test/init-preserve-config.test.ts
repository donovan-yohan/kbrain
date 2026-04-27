import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

const CLI = join(__dirname, '..', 'src', 'cli.ts');

let tmp: string;

function run(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const env = { ...process.env, HOME: tmp } as Record<string, string | undefined>;
  delete env.DATABASE_URL;
  delete env.GBRAIN_DATABASE_URL;
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  delete env.EMBEDDING_BASE_URL;
  delete env.EMBEDDING_MODEL;
  delete env.EMBEDDING_DIMENSIONS;
  try {
    const stdout = execFileSync('bun', ['run', CLI, ...args], {
      env: env as Record<string, string>,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err: any) {
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout?.toString?.() ?? '',
      stderr: err.stderr?.toString?.() ?? '',
    };
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-init-preserve-config-test-'));
});

afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('gbrain init --pglite preserves provider configuration', () => {
  test('does not drop local embedding and expansion settings from existing config', () => {
    const gbrainDir = join(tmp, '.gbrain');
    mkdirSync(gbrainDir, { recursive: true });
    const dbPath = join(gbrainDir, 'brain.pglite');
    const configPath = join(gbrainDir, 'config.json');
    const originalConfig = {
      engine: 'pglite',
      database_path: dbPath,
      embedding_base_url: 'http://192.168.0.10:11434/v1',
      embedding_model: 'nomic-embed-text',
      embedding_dimensions: 768,
      expansion_provider: 'openai-compat',
      expansion_base_url: 'http://192.168.0.10:11434/v1',
      expansion_model: 'llama3.2:3b',
      expansion_api_key: 'ollama',
    };
    writeFileSync(configPath, JSON.stringify(originalConfig, null, 2) + '\n');

    const result = run(['init', '--pglite', '--json']);
    expect(result.exitCode).toBe(0);

    const preserved = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(preserved).toMatchObject(originalConfig);
  }, 30_000);
});
