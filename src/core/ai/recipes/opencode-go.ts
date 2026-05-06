import type { Recipe } from '../types.ts';

/**
 * OpenCode Go (https://opencode.ai/zen) — OpenAI-compatible chat + expansion
 * proxy fronting kimi/deepseek/qwen models. Embeddings not provided; pair with
 * Ollama or another embedding-capable recipe.
 *
 * Configure via `provider_base_urls.opencode-go` and `OPENCODE_GO_API_KEY`.
 * See `docs/guides/opencode-go-setup.md`.
 */
export const opencodeGo: Recipe = {
  id: 'opencode-go',
  name: 'OpenCode Go',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://opencode.ai/zen/go/v1',
  auth_env: {
    required: ['OPENCODE_GO_API_KEY'],
    setup_url: 'https://opencode.ai/zen',
  },
  touchpoints: {
    chat: {
      // Empty model list lets the gateway accept arbitrary ids the proxy exposes
      // (kimi-k2.6, deepseek-v4-flash, qwen3.6-plus, etc.). openai-compat tier
      // skips the strict membership check.
      models: [],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      cost_per_1m_input_usd: undefined,
      cost_per_1m_output_usd: undefined,
      price_last_verified: '2026-05-06',
    },
    expansion: {
      models: [],
      cost_per_1m_tokens_usd: undefined,
      price_last_verified: '2026-05-06',
    },
  },
  setup_hint: 'Subscribe at https://opencode.ai/zen, set OPENCODE_GO_API_KEY, and use chat models like opencode-go:kimi-k2.6.',
};
