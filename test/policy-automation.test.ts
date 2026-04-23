import { describe, expect, test } from 'bun:test';
import { getPolicy, resolvePolicyId } from '../src/core/policy.ts';

describe('policy catalog', () => {
  test('defaults general-assistant to review_required', () => {
    const policy = getPolicy('general-assistant');
    expect(policy.id).toBe(resolvePolicyId('general-assistant'));
    expect(policy.automation_mode).toBe('review_required');
    expect(policy.allow_auto_link).toBe(true);
    expect(policy.allow_external_resolvers).toBe(false);
  });

  test('defaults research-wiki to assisted_auto', () => {
    const policy = getPolicy('research-wiki');
    expect(policy.automation_mode).toBe('assisted_auto');
    expect(policy.allow_auto_link).toBe(true);
    expect(policy.allow_frontmatter_repairs).toBe(true);
  });

  test('defaults private-finance to manual with no external resolver egress', () => {
    const policy = getPolicy('private-finance');
    expect(policy.automation_mode).toBe('manual');
    expect(policy.allow_external_resolvers).toBe(false);
    expect(policy.default_brain_scope).toBe('private');
  });
});
