# Hermes Dual-Brain Contract for kbrain

## Stance

kbrain remains **single-brain per instance**.

For mixed privacy domains, Hermes should route across two separately configured kbrain instances:

- `general`
- `private`

This keeps the privacy boundary at the filesystem / DB / config level instead of trying to multiplex policy domains inside one database.

## Required kbrain identity surface

Each kbrain instance should expose, at minimum, a machine-readable identity descriptor with:

- `profile_id`
- `policy_id`
- `default_brain_scope`
- `brain_routing_strategy`

Current implementation surface:

- `gbrain config show --json`
- `getBrainIdentity()` in `src/core/config.ts`

## Recommended Hermes routing rules

Hermes should prefer explicit routing in this order:

1. explicit user override
2. channel / account privacy classification
3. skill intent
4. policy fallback (`default_brain_scope`)

## Non-goals

- one kbrain instance serving both private and general writes into the same DB
- cross-brain joins in kbrain core
- mixed row-level privacy policy inside a single brain engine
