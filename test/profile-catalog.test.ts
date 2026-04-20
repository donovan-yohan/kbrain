import { describe, test, expect } from 'bun:test';
import {
  DEFAULT_PROFILE_ID,
  PROFILE_IDS,
  getProfile,
  inferTypeFromPath,
  resolveProfileId,
} from '../src/core/profiles/catalog.ts';

describe('profile catalog', () => {
  test('exposes the built-in curated profile ids only', () => {
    expect(PROFILE_IDS).toEqual(['general-assistant', 'research-wiki', 'private-finance']);
    expect(DEFAULT_PROFILE_ID).toBe('general-assistant');
  });

  test('resolves missing or unknown profile ids to general-assistant', () => {
    expect(resolveProfileId(undefined)).toBe('general-assistant');
    expect(resolveProfileId('bogus-profile')).toBe('general-assistant');
    expect(resolveProfileId('research-wiki')).toBe('research-wiki');
  });

  test('general-assistant preserves the legacy directory inference', () => {
    expect(inferTypeFromPath('people/alice-chen.md', 'general-assistant')).toBe('person');
    expect(inferTypeFromPath('companies/acme.md', 'general-assistant')).toBe('company');
    expect(inferTypeFromPath('tech/wiki/analysis/agi.md', 'general-assistant')).toBe('analysis');
  });

  test('research-wiki favors knowledge artifacts over CRM defaults', () => {
    expect(inferTypeFromPath('notes/attention-residency.md', 'research-wiki')).toBe('note');
    expect(inferTypeFromPath('papers/transformers.md', 'research-wiki')).toBe('paper');
    expect(inferTypeFromPath('datasets/openwebtext.md', 'research-wiki')).toBe('dataset');
    expect(inferTypeFromPath('experiments/retrieval-run-12.md', 'research-wiki')).toBe('experiment');
  });

  test('private-finance exposes finance-native directories', () => {
    expect(inferTypeFromPath('accounts/checking.md', 'private-finance')).toBe('account');
    expect(inferTypeFromPath('positions/vti-taxable.md', 'private-finance')).toBe('position');
    expect(inferTypeFromPath('transactions/2026-04-15-payroll.md', 'private-finance')).toBe('transaction');
    expect(inferTypeFromPath('plans/q3-cash-plan.md', 'private-finance')).toBe('plan');
  });

  test('getProfile returns profile metadata and allowed page types', () => {
    const profile = getProfile('private-finance');
    expect(profile.id).toBe('private-finance');
    expect(profile.displayName).toContain('Private');
    expect(profile.pageTypes).toContain('transaction');
    expect(profile.pageTypes).not.toContain('deal');
  });
});
