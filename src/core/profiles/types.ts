import type { PageType } from '../types.ts';

export type ProfileId = 'general-assistant' | 'research-wiki' | 'private-finance';

export interface DirectoryRule {
  matchers: string[];
  type: PageType;
}

export interface TaxonomyProfile {
  id: ProfileId;
  displayName: string;
  description: string;
  pageTypes: PageType[];
  directoryRules: DirectoryRule[];
  defaultType: PageType;
}
