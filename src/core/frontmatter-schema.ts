import type { PageType } from './types.ts';
import { resolveProfileId } from './profiles/catalog.ts';
import type { ProfileId } from './profiles/types.ts';

export interface FrontmatterFieldSchema {
  type: 'string' | 'number' | 'string[]';
  required: boolean;
  nullable: boolean;
}

export interface FrontmatterValidationOptions {
  profileId?: ProfileId;
}

export interface FrontmatterValidationResult {
  valid: boolean;
  errors: string[];
}

const PROFILE_SCHEMAS: Partial<Record<ProfileId, Partial<Record<PageType, Record<string, FrontmatterFieldSchema>>>>> = {
  'general-assistant': {
    person: {
      company: { type: 'string', required: false, nullable: false },
      assistant: { type: 'string', required: false, nullable: true },
    },
  },
  'research-wiki': {
    paper: {
      authors: { type: 'string[]', required: true, nullable: false },
      venue: { type: 'string', required: false, nullable: false },
      doi: { type: 'string', required: false, nullable: false },
    },
  },
  'private-finance': {
    account: {
      institution: { type: 'string', required: true, nullable: false },
      closed_at: { type: 'string', required: true, nullable: true },
    },
    transaction: {
      date: { type: 'string', required: true, nullable: false },
      account: { type: 'string', required: true, nullable: false },
      amount: { type: 'number', required: true, nullable: false },
      settled_at: { type: 'string', required: false, nullable: true },
    },
  },
};

export function validateFrontmatter(
  pageType: PageType,
  frontmatter: Record<string, unknown>,
  options: FrontmatterValidationOptions = {},
): FrontmatterValidationResult {
  const profileId = resolveProfileId(options.profileId);
  const schema = PROFILE_SCHEMAS[profileId]?.[pageType];
  if (!schema) return { valid: true, errors: [] };

  const errors: string[] = [];
  const isDraft = frontmatter.draft === true;

  for (const [field, definition] of Object.entries(schema)) {
    const hasField = Object.prototype.hasOwnProperty.call(frontmatter, field);
    const value = frontmatter[field];

    if (definition.required && !isDraft && !hasField) {
      errors.push(`Field "${field}" is required for ${profileId}/${pageType}.`);
      continue;
    }

    if (!hasField) continue;

    if (value === null) {
      if (!definition.nullable) {
        errors.push(`Field "${field}" does not allow null for ${profileId}/${pageType}.`);
      }
      continue;
    }

    if (!matchesType(value, definition.type)) {
      errors.push(`Field "${field}" must be ${definition.type} for ${profileId}/${pageType}.`);
    }
  }

  return { valid: errors.length === 0, errors };
}

function matchesType(value: unknown, type: FrontmatterFieldSchema['type']): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string' && value.trim().length > 0;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'string[]':
      return Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && item.trim().length > 0);
    default:
      return false;
  }
}
