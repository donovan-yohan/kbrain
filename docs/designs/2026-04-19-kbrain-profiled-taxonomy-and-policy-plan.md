# KBrain Profiled Taxonomy And Policy Plan

> **For implementers:** preserve the current fork stance: Hermes-first, local-model-friendly, and explicit about privacy boundaries. The point of this plan is to add profile-specific ontology and automation without turning kbrain into an abstract schema platform.

**Goal:** Add profile-configurable taxonomy, frontmatter, and automation controls to kbrain so the same core can support `general-assistant`, `research-wiki`, and `private-finance` deployments without collapsing privacy policy into ontology or forcing a one-size-fits-all directory schema.

**Architecture:** Introduce a small built-in profile layer that selects from an explicit kbrain-owned ontology superset, plus a separate policy layer that controls automation, read/write scope, and external resolver behavior. Keep kbrain single-brain per instance; if Hermes needs a general/private split, route across two configured kbrain instances instead of multiplexing privacy domains inside one brain database.

**Tech Stack:** TypeScript, existing markdown/frontmatter pipeline, existing link-extraction + writer layers, existing config/init commands, Hermes integration contract.

---

## Current State

- `src/core/types.ts` hardcodes one `PageType` union and assumes a single global taxonomy.
- `src/core/markdown.ts` infers types from fixed directory names.
- `src/core/link-extraction.ts` knows a fixed set of frontmatter/link conventions and directory prefixes.
- `docs/GBRAIN_RECOMMENDED_SCHEMA.md` describes a broad personal-brain schema, but the executable surface is still mostly hardcoded.
- `src/core/config.ts` has provider/model settings but no explicit taxonomy profile or automation policy surface.
- The repo is Hermes-first and already carries local-model support, but it does not yet have a first-class story for private-vs-general knowledge boundaries.

## Decisions Locked In

### 1. Profiles are bundled packs, not a generic runtime schema engine

Phase 1 should ship **three built-in profiles only**:

- `general-assistant`
- `research-wiki`
- `private-finance`

Each profile is a typed manifest in repo code, not a user-authored DSL. That keeps the surface understandable, testable, and compatible with the compiled binary. We should not start with arbitrary end-user-defined taxonomies.

### 2. Taxonomy and policy are separate surfaces

Taxonomy answers:

- what page types exist
- which directories map to which types
- which frontmatter fields are valid for each type
- which frontmatter fields project into typed links

Policy answers:

- which automations are allowed
- which writes are auto-apply vs review-required
- which external resolvers may run
- whether a deployment can touch one brain or multiple brains

Policies may constrain taxonomy usage, but they must never define the ontology itself.

### 3. Support two brains at the Hermes layer, not inside one mixed brain

Recommendation: **yes, support two brains (`general`, `private`) at the Hermes layer**, but do not make kbrain core a multi-brain router in the first implementation.

Reasoning:

- the privacy boundary is clearer when each brain has its own config, DB, filesystem, and automation policy
- accidental leakage risk is materially lower
- migration is simpler because current kbrain assumes one engine/config/brain per process
- Hermes is already the host-level orchestrator and is the right place to choose which brain to query or write

Kbrain should expose the contract needed for this, but not absorb cross-brain routing logic in phase 1.

### 4. Frontmatter presence semantics are orthogonal

Do not encode "optional vs nullable vs required" as one overloaded flag. Use two axes:

- `required: boolean`
- `nullable: boolean`

Meaning:

- `required=false, nullable=false`: field may be absent; if present it must be non-null
- `required=false, nullable=true`: field may be absent; `null` means explicitly none / inapplicable / intentionally blank
- `required=true, nullable=false`: field must be present and non-null
- `required=true, nullable=true`: field must be present, but may be `null` when "known-none" is a legitimate state

Serialization rule:

- absence means "unknown / not asserted"
- `null` means "explicitly none / not applicable"
- empty string should not be used where `null` or absence is the real meaning

### 5. Expose ontology directly, not through meta-abstractions

The profile layer should expose explicit first-class concepts:

- directories
- page types
- frontmatter fields
- link emitters

Do not replace these with a generic graph-node system, arbitrary schema registry, or plugin-style ontology language in phase 1. The implementation should stay close to the current mental model of "markdown pages in known directories with typed frontmatter and typed links."

## Proposed Shape

### Profile Catalog

Add a built-in profile catalog:

- `general-assistant`: close to the current recommended schema; broad people/company/project/deal/meeting coverage
- `research-wiki`: concept-heavy, source-heavy, flatter people/company emphasis, more support for notes/papers/datasets/experiments
- `private-finance`: account/transaction/position/tax/planning-oriented, stricter privacy defaults, minimal external enrichment

Profiles should define:

- `id`
- `displayName`
- `description`
- enabled page types
- directory-to-type inference rules
- per-type frontmatter schema
- per-type scaffold defaults
- link ontology emitters for frontmatter-driven edges
- docs/resolver template metadata

### Taxonomy Surface

Add an explicit ontology superset owned by kbrain. Example categories:

- Existing: `person`, `company`, `deal`, `project`, `concept`, `source`, `media`, `writing`, `analysis`, `guide`, `hardware`, `architecture`
- Research additions: `paper`, `dataset`, `experiment`, `note`
- Private-finance additions: `account`, `position`, `transaction`, `budget`, `tax-lot`, `plan`

Profiles select subsets of that superset. This avoids phase-1 arbitrary type creation while still supporting different deployments.

### Policy Surface

Add a separate policy manifest/config surface with controls like:

- `automation_mode`: `manual` | `review_required` | `assisted_auto` | `full_auto`
- `allow_external_resolvers`
- `allow_background_enrichment`
- `allow_auto_link`
- `allow_auto_timeline`
- `allow_frontmatter_repairs`
- `allow_cross_brain_reads` (Hermes-level contract, default false)
- `default_brain_scope`: `general` | `private`
- `brain_routing_strategy`: `single` | `dual-hermes-routed`

Gradual opt-in automation should be policy-controlled, not embedded in taxonomy definitions.

## File Map

### New Core Files

- `src/core/profiles/types.ts`
  - `ProfileId`, `TaxonomyProfile`, `PolicyProfile`, `FrontmatterFieldSchema`, `LinkEmitterSpec`
- `src/core/profiles/catalog.ts`
  - built-in profile registry and lookup helpers
- `src/core/profiles/general-assistant.ts`
- `src/core/profiles/research-wiki.ts`
- `src/core/profiles/private-finance.ts`
- `src/core/frontmatter-schema.ts`
  - runtime validation and presence semantics
- `src/core/policy.ts`
  - automation policy evaluation helpers

### Existing Files To Modify

- `src/core/types.ts`
  - widen from one hardcoded worldview to a kbrain-owned ontology superset plus profile-aware helpers
- `src/core/config.ts`
  - add `profile_id`, `policy_id`, and optional Hermes routing metadata
- `src/core/markdown.ts`
  - replace fixed `inferType()` directory logic with profile-driven mapping
- `src/core/link-extraction.ts`
  - drive frontmatter-derived link extraction from profile ontology definitions
- `src/core/output/scaffold.ts`
  - profile-aware scaffolding and required-field checks
- `src/core/output/writer.ts`
  - enforce frontmatter presence semantics and profile validation gates
- `src/commands/init.ts`
  - select profile + policy during init, generate profile-appropriate resolver docs
- `src/commands/config.ts`
  - inspect/change active profile and policy
- `README.md` and profile-specific docs

### Tests

- `test/profile-catalog.test.ts`
- `test/frontmatter-schema.test.ts`
- `test/markdown-profile.test.ts`
- `test/link-extraction-profile.test.ts`
- `test/policy-automation.test.ts`
- `test/init-profile.test.ts`
- Hermes-side integration contract test in the downstream Hermes repo

## Implementation Phases

### Phase 1: Profile Foundation

**Outcome:** kbrain can load one of three built-in profiles and use it to infer directories and allowed types.

- Introduce the built-in profile registry in `src/core/profiles/`.
- Move directory-to-type inference out of hardcoded `inferType()` branches and into profile manifests.
- Keep the DB `pages.type` column as text; do not add a migration for enum storage.
- Ensure the default profile for existing installs is `general-assistant`.
- Preserve backward compatibility by mapping the current directory layout exactly under `general-assistant`.

### Phase 2: Frontmatter Schema And Semantics

**Outcome:** frontmatter is validated per type/profile with explicit required/nullability behavior.

- Add runtime frontmatter schemas per page type.
- Validate on `put_page`, import, and writer-driven scaffold operations.
- Distinguish:
  - absent field = unknown/unset
  - `null` = explicit none/not-applicable
  - empty array = known empty collection
  - empty string = usually invalid unless field schema explicitly allows it
- Add a "draft vs canonical" rule:
  - drafts may omit some required fields
  - promotion to canonical page requires all required non-draft fields

Recommendation: use a small profile-native validator, not a large schema dependency.

### Phase 3: Profile-Driven Link Ontology

**Outcome:** frontmatter-to-link projection becomes profile-aware instead of globally hardcoded.

- Define link emitters in profile manifests.
- Examples:
  - `general-assistant.company -> works_at`
  - `research-wiki.related_papers -> cites`
  - `private-finance.accounts -> held_at`
- Keep the existing typed-link engine model.
- Do not introduce arbitrary user-written link logic in phase 1.
- Preserve current v0.13 frontmatter-link behavior for `general-assistant`.

### Phase 4: Policy-Controlled Gradual Automation

**Outcome:** automation rollout is controlled by policy mode and scope, not by ad hoc flags.

- Consolidate existing config switches (`auto_link`, `auto_timeline`, validator lint, enrichment knobs) into a policy evaluator.
- Add explicit automation stages:
  - `manual`: suggestions only, no auto-writes
  - `review_required`: prepare patches/findings, require approval before writes
  - `assisted_auto`: low-risk deterministic writes auto-apply; higher-risk writes require review
  - `full_auto`: allowed only for deployments that explicitly opt in
- Suggested defaults:
  - `general-assistant`: `review_required`
  - `research-wiki`: `assisted_auto`
  - `private-finance`: `manual` or `review_required`
- Separate external egress from local deterministic work:
  - local link extraction may be allowed while external enrichment remains blocked

### Phase 5: Hermes Dual-Brain Contract

**Outcome:** Hermes can route between `general` and `private` brains without requiring kbrain core to become multi-tenant.

Recommended contract:

- Hermes holds two named kbrain configs:
  - `general`
  - `private`
- Each kbrain instance has its own:
  - config file
  - DB path/URL
  - repo root
  - profile
  - policy
- Hermes chooses target brain by:
  - explicit user override
  - message source/channel
  - skill intent
  - policy classification

Kbrain-side work for this phase:

- expose profile/policy metadata through config inspection
- expose a machine-readable "brain identity" descriptor
- document how Hermes should decide routing and how to avoid cross-brain writes

Non-goal for phase 1:

- one kbrain process querying multiple brains
- cross-brain joins in the core search engine
- mixed private/general pages in one DB with row-level policy logic

## Profile Recommendations

### `general-assistant`

Best for:

- personal CRM
- meetings, people, companies, projects
- Hermes daily operator workflows

Taxonomy stance:

- keep current directory model close to `docs/GBRAIN_RECOMMENDED_SCHEMA.md`
- preserve people/company/deal/project/meeting centric workflows
- keep current frontmatter-link extraction defaults

Automation stance:

- deterministic low-risk writes okay after review layer proves stable
- external enrichment opt-in

### `research-wiki`

Best for:

- literature reviews
- technical notes
- long-lived knowledge base without much CRM

Taxonomy stance:

- prioritize `concept`, `note`, `paper`, `dataset`, `experiment`, `source`
- downplay person/company/deal assumptions
- directory inference should favor knowledge artifacts over relationship CRM

Automation stance:

- allow more aggressive auto-linking, citation normalization, and structural cleanup
- keep external fetches explicit or reviewable

### `private-finance`

Best for:

- net worth tracking
- account/position/transaction planning
- tax-sensitive or family-private material

Taxonomy stance:

- add finance-native page types
- support folders and schemas for institutions, accounts, positions, transactions, plans
- avoid inheriting unnecessary CRM ontology

Automation stance:

- strictest policy defaults
- no external resolver egress by default
- manual/review-first for writes that change numeric or account-state data

## Frontmatter Semantics In Detail

### Required

Use for fields that make the page type operationally valid.

Examples:

- `private-finance/account.institution`
- `private-finance/transaction.date`
- `research-wiki/paper.title`

### Optional

Use for fields that are useful but not necessary for a valid page.

Examples:

- `person.x_handle`
- `company.valuation`
- `paper.doi`

### Nullable

Use only when explicit "none/inapplicable" is different from "unknown".

Examples:

- `person.assistant = null` means confirmed no assistant
- `account.closed_at = null` means explicitly still open
- `transaction.settled_at = null` means known pending

Do not use `null` as a generic placeholder for ignorance.

## Migration Strategy

### Existing installs

- default all existing brains to `general-assistant`
- infer `profile_id=general-assistant` when config lacks a profile
- keep existing directory inference behavior unchanged under the default profile

### Existing frontmatter

- do not rewrite all pages immediately
- validate lazily on write/import/readiness checks
- add a diagnostic command to report profile/schema mismatches before attempting mass repair

### Existing links

- preserve the current `general-assistant` frontmatter-link map so v0.13 behavior does not regress
- only emit new link types when a non-default profile is explicitly selected

## Verification Plan

- `bun run build`
- `HOME=/tmp/kbrain-test-home bun run test`
- new profile tests should cover:
  - directory inference for all three profiles
  - frontmatter presence semantics
  - frontmatter-to-link projection by profile
  - init/config selection of profile + policy
  - backward compatibility for existing default brains
- Hermes integration verification should prove:
  - explicit routing to `general` vs `private`
  - no accidental cross-brain writes
  - policy blocks private-finance external enrichment by default

## Risks And Mitigations

- **Risk:** widening the type system too early makes the core mushy.
  - Mitigation: keep a finite built-in ontology superset and three bundled profiles only.

- **Risk:** policy logic leaks into taxonomy and creates untestable special cases.
  - Mitigation: separate files, separate config keys, separate tests.

- **Risk:** `private-finance` becomes a half-private mode inside one DB and leaks.
  - Mitigation: route at Hermes across two brains; do not implement mixed-mode storage first.

- **Risk:** required-field enforcement breaks current ingestion flows.
  - Mitigation: add draft/promote semantics and lazy diagnostics before hard enforcement.

## Recommended Order Of Work

1. Profile foundation + default `general-assistant` compatibility.
2. Frontmatter schema semantics.
3. Profile-driven link ontology.
4. Policy-controlled automation rollout.
5. Hermes dual-brain contract and downstream integration.

## Open Questions

- Should `research-wiki` reuse `concept` heavily, or add a dedicated `note` type immediately?
- For `private-finance`, do we want transaction pages as markdown entities, or keep transactions mostly ledger-like with generated summaries?
- Should draft-vs-canonical be a universal field (for all profiles) or a writer-layer concept not serialized into page frontmatter?
- How much of the Hermes routing contract belongs in this repo versus a downstream Hermes design doc?

## Success Criteria

- A new install can choose `general-assistant`, `research-wiki`, or `private-finance` during `gbrain init`.
- Existing brains continue to behave identically under the default `general-assistant` profile.
- Frontmatter validation distinguishes absent vs null vs required without brittle string conventions.
- Automation rollout is policy-driven and profile-agnostic.
- Hermes can operate with separate `general` and `private` brains without kbrain core becoming multi-tenant.
