import { afterEach, describe, expect, test } from 'bun:test';
import {
  validateFrontmatter,
  type FrontmatterValidationOptions,
} from '../src/core/frontmatter-schema.ts';

const withProfile = (profileId: FrontmatterValidationOptions['profileId']) => ({ profileId });

afterEach(() => {
  delete process.env.GBRAIN_PROFILE_ID;
});

describe('validateFrontmatter', () => {
  test('allows absent optional non-nullable fields', () => {
    const result = validateFrontmatter('person', {}, withProfile('general-assistant'));
    expect(result.valid).toBe(true);
  });

  test('rejects null for optional-but-non-nullable fields', () => {
    const result = validateFrontmatter('person', { company: null }, withProfile('general-assistant'));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('company');
    expect(result.errors[0]).toContain('null');
  });

  test('allows explicit null for nullable fields', () => {
    const result = validateFrontmatter('person', { assistant: null }, withProfile('general-assistant'));
    expect(result.valid).toBe(true);
  });

  test('requires configured private-finance fields on canonical pages', () => {
    const result = validateFrontmatter('transaction', { amount: 42 }, withProfile('private-finance'));
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('date');
    expect(result.errors.join('\n')).toContain('account');
  });

  test('draft pages may omit otherwise-required fields', () => {
    const result = validateFrontmatter('transaction', { draft: true, amount: 42 }, withProfile('private-finance'));
    expect(result.valid).toBe(true);
  });

  test('required nullable fields must be present even when null', () => {
    const result = validateFrontmatter('account', { institution: 'Fidelity' }, withProfile('private-finance'));
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('closed_at');

    const ok = validateFrontmatter('account', { institution: 'Fidelity', closed_at: null }, withProfile('private-finance'));
    expect(ok.valid).toBe(true);
  });

  test('validates research-wiki paper schema', () => {
    const result = validateFrontmatter('paper', { venue: 'NeurIPS' }, withProfile('research-wiki'));
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('authors');

    const ok = validateFrontmatter('paper', { authors: ['Alice', 'Bob'], venue: 'NeurIPS' }, withProfile('research-wiki'));
    expect(ok.valid).toBe(true);
  });
});
