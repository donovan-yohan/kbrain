import type { PageType } from '../types.ts';
import type { ProfileId, TaxonomyProfile } from './types.ts';

export const DEFAULT_PROFILE_ID: ProfileId = 'general-assistant';
export const PROFILE_IDS: ProfileId[] = ['general-assistant', 'research-wiki', 'private-finance'];

const LEGACY_DIRECTORY_RULES: TaxonomyProfile['directoryRules'] = [
  { matchers: ['/writing/'], type: 'writing' },
  { matchers: ['/wiki/analysis/'], type: 'analysis' },
  { matchers: ['/wiki/guides/', '/wiki/guide/'], type: 'guide' },
  { matchers: ['/wiki/hardware/'], type: 'hardware' },
  { matchers: ['/wiki/architecture/'], type: 'architecture' },
  { matchers: ['/wiki/concepts/', '/wiki/concept/'], type: 'concept' },
  { matchers: ['/people/', '/person/'], type: 'person' },
  { matchers: ['/companies/', '/company/'], type: 'company' },
  { matchers: ['/deals/', '/deal/'], type: 'deal' },
  { matchers: ['/yc/'], type: 'yc' },
  { matchers: ['/civic/'], type: 'civic' },
  { matchers: ['/projects/', '/project/'], type: 'project' },
  { matchers: ['/sources/', '/source/'], type: 'source' },
  { matchers: ['/media/'], type: 'media' },
];

const PROFILES: Record<ProfileId, TaxonomyProfile> = {
  'general-assistant': {
    id: 'general-assistant',
    displayName: 'General Assistant',
    description: 'Legacy CRM-and-knowledge profile for Hermes-style general assistant brains.',
    pageTypes: ['person', 'company', 'deal', 'yc', 'civic', 'project', 'concept', 'source', 'media', 'writing', 'analysis', 'guide', 'hardware', 'architecture'],
    directoryRules: LEGACY_DIRECTORY_RULES,
    defaultType: 'concept',
  },
  'research-wiki': {
    id: 'research-wiki',
    displayName: 'Research Wiki',
    description: 'Concept-heavy research profile with explicit notes, papers, datasets, and experiments.',
    pageTypes: ['concept', 'note', 'paper', 'dataset', 'experiment', 'source', 'analysis', 'guide', 'architecture', 'media', 'writing', 'person', 'company'],
    directoryRules: [
      { matchers: ['/papers/', '/paper/'], type: 'paper' },
      { matchers: ['/datasets/', '/dataset/'], type: 'dataset' },
      { matchers: ['/experiments/', '/experiment/'], type: 'experiment' },
      { matchers: ['/notes/', '/note/'], type: 'note' },
      ...LEGACY_DIRECTORY_RULES,
    ],
    defaultType: 'concept',
  },
  'private-finance': {
    id: 'private-finance',
    displayName: 'Private Finance',
    description: 'Finance-native profile for accounts, positions, transactions, budgets, tax lots, and plans.',
    pageTypes: ['account', 'position', 'transaction', 'budget', 'tax-lot', 'plan', 'analysis', 'source', 'concept', 'note'],
    directoryRules: [
      { matchers: ['/accounts/', '/account/'], type: 'account' },
      { matchers: ['/positions/', '/position/'], type: 'position' },
      { matchers: ['/transactions/', '/transaction/'], type: 'transaction' },
      { matchers: ['/budgets/', '/budget/'], type: 'budget' },
      { matchers: ['/tax-lots/', '/tax-lot/'], type: 'tax-lot' },
      { matchers: ['/plans/', '/plan/'], type: 'plan' },
      { matchers: ['/notes/', '/note/'], type: 'note' },
      { matchers: ['/analysis/'], type: 'analysis' },
      { matchers: ['/sources/', '/source/'], type: 'source' },
      { matchers: ['/concepts/', '/concept/'], type: 'concept' },
    ],
    defaultType: 'concept',
  },
};

export function resolveProfileId(profileId?: string | null): ProfileId {
  return PROFILE_IDS.includes(profileId as ProfileId) ? (profileId as ProfileId) : DEFAULT_PROFILE_ID;
}

export function getProfile(profileId?: string | null): TaxonomyProfile {
  return PROFILES[resolveProfileId(profileId)];
}

export function inferTypeFromPath(filePath: string | undefined, profileId?: string | null): PageType {
  const profile = getProfile(profileId);
  if (!filePath) return profile.defaultType;

  const normalizedPath = filePath.replace(/\\/g, '/');
  const lower = ('/' + normalizedPath).toLowerCase();
  for (const rule of profile.directoryRules) {
    if (rule.matchers.some(matcher => lower.includes(matcher))) {
      return rule.type;
    }
  }
  return profile.defaultType;
}

export function isKnownPageType(type: string): type is PageType {
  const allTypes = new Set<PageType>(Object.values(PROFILES).flatMap(profile => profile.pageTypes));
  return allTypes.has(type as PageType);
}
