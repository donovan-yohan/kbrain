import { resolveProfileId } from './profiles/catalog.ts';
import type { ProfileId } from './profiles/types.ts';

export interface PolicyProfile {
  id: ProfileId;
  automation_mode: 'manual' | 'review_required' | 'assisted_auto' | 'full_auto';
  allow_external_resolvers: boolean;
  allow_background_enrichment: boolean;
  allow_auto_link: boolean;
  allow_auto_timeline: boolean;
  allow_frontmatter_repairs: boolean;
  allow_cross_brain_reads: boolean;
  default_brain_scope: 'general' | 'private';
  brain_routing_strategy: 'single' | 'dual-hermes-routed';
}

const POLICIES: Record<ProfileId, PolicyProfile> = {
  'general-assistant': {
    id: 'general-assistant',
    automation_mode: 'review_required',
    allow_external_resolvers: false,
    allow_background_enrichment: false,
    allow_auto_link: true,
    allow_auto_timeline: true,
    allow_frontmatter_repairs: false,
    allow_cross_brain_reads: false,
    default_brain_scope: 'general',
    brain_routing_strategy: 'single',
  },
  'research-wiki': {
    id: 'research-wiki',
    automation_mode: 'assisted_auto',
    allow_external_resolvers: false,
    allow_background_enrichment: true,
    allow_auto_link: true,
    allow_auto_timeline: true,
    allow_frontmatter_repairs: true,
    allow_cross_brain_reads: false,
    default_brain_scope: 'general',
    brain_routing_strategy: 'single',
  },
  'private-finance': {
    id: 'private-finance',
    automation_mode: 'manual',
    allow_external_resolvers: false,
    allow_background_enrichment: false,
    allow_auto_link: false,
    allow_auto_timeline: false,
    allow_frontmatter_repairs: false,
    allow_cross_brain_reads: false,
    default_brain_scope: 'private',
    brain_routing_strategy: 'dual-hermes-routed',
  },
};

export function resolvePolicyId(profileId?: string | null): ProfileId {
  return resolveProfileId(profileId);
}

export function getPolicy(profileId?: string | null): PolicyProfile {
  return POLICIES[resolvePolicyId(profileId)];
}
