import { describe, expect, test } from 'bun:test';
import { getBrainIdentity } from '../src/core/config.ts';

describe('getBrainIdentity', () => {
  test('defaults private-finance to Hermes-routed private scope', () => {
    const identity = getBrainIdentity({
      engine: 'pglite',
      database_path: '/tmp/brain.pglite',
      profile_id: 'private-finance',
      policy_id: 'private-finance',
    });

    expect(identity?.profile_id).toBe('private-finance');
    expect(identity?.default_brain_scope).toBe('private');
    expect(identity?.brain_routing_strategy).toBe('dual-hermes-routed');
  });

  test('defaults general-assistant to single-brain general scope', () => {
    const identity = getBrainIdentity({
      engine: 'pglite',
      database_path: '/tmp/brain.pglite',
      profile_id: 'general-assistant',
      policy_id: 'general-assistant',
    });

    expect(identity?.default_brain_scope).toBe('general');
    expect(identity?.brain_routing_strategy).toBe('single');
  });
});
