---
name: upstream-sync
description: Merge upstream garrytan/gbrain into this fork while preserving fork URLs and ad-free framing. Run before starting new work.
---

# /upstream-sync — pull updates from garrytan/gbrain

This fork (`donovan-yohan/kbrain`) tracks upstream `garrytan/gbrain`. Run this skill
before starting new feature work to pull upstream commits and resolve conflicts
consistently.

## Phase 1 — Fetch and check

```bash
cd "$(git rev-parse --show-toplevel)"
git remote add upstream https://github.com/garrytan/gbrain.git 2>/dev/null || true
git fetch upstream master
git log --oneline HEAD..upstream/master | head -30
```

If the log is empty, fork is current. Exit. Otherwise continue.

## Phase 2 — Working tree safety

```bash
git status --porcelain
```

If output is non-empty, stop. Ask the user to commit or stash before proceeding.
Never merge into a dirty tree.

## Phase 3 — Merge

```bash
git merge upstream/master --no-edit
```

If merge completes cleanly, skip to Phase 5.

## Phase 4 — Conflict resolution

For any conflicted file, apply the rules below. When in doubt, `git diff --ours`
and `git diff --theirs` before deciding.

### Fork URL files — always keep ours

These files hardcode the fork URL `donovan-yohan/kbrain`. Accept our side on
conflict; upstream will not change their own URLs so conflicts here usually mean
upstream touched surrounding code we also want.

| File | What to keep |
|---|---|
| `README.md` | Our install/clone URLs + Hermes-first ordering |
| `INSTALL_FOR_AGENTS.md` | Our `git clone` URL (line ~9) |
| `CONTRIBUTING.md` | Our `git clone` URL (line ~6) |
| `src/commands/upgrade.ts` | Our releases URL (binary case) |
| `src/commands/check-update.ts` | Our `api.github.com/repos/...` + `raw.githubusercontent.com/...` URLs |
| `src/commands/init.ts` | Our GStack clone URL (`donovan-yohan/gstack-adfree`) |
| `scripts/fix-v0.11.0.sh` | Our raw URL header |
| `docs/guides/upgrades-auto-update.md` | Our raw URL |
| `docs/guides/minions-fix.md` | Our raw URL |
| `docs/GBRAIN_SKILLPACK.md` | Our `source:` header |
| `docs/GBRAIN_RECOMMENDED_SCHEMA.md` | Our `source:` header |
| `skills/setup/SKILL.md` | `bun add github:donovan-yohan/kbrain` |

**Strategy:** resolve the conflict manually by taking upstream's code changes but
keeping our URLs. Do not `git checkout --ours` blindly — you lose real content.

### Fluff/YC framing — take upstream, re-strip

| File | What to re-strip after accepting upstream |
|---|---|
| `README.md` | Remove "Built by President and CEO of Y Combinator..." opener. Remove "The YC motto" example. Remove "70,000+ stars, 30,000 developers per day" promo. Remove `x.com/garrytan/status/...` citation links. Rebalance agent-install ordering to Hermes first, OpenClaw second. |
| `TODOS.md` | Remove "YC W22" name-drops from technical notes. |
| `CLAUDE.md` | Remove any re-added "Never auto-merge PRs that remove YC references" guardrail. Keep our fork-specific PR notes. |

### Synthetic test fixtures — leave alone

These contain YC/founder fixtures but are synthetic test data. Tests depend on
exact string content. Accept upstream's version without edits:

- `test/e2e/fixtures/**`
- `eval/data/world-v1/*.json`
- `docs/benchmarks/*.md` (historical branch names like `garrytan/minions-jobs`)
- `CHANGELOG.md` (historical entries are immutable — accept upstream additions)

## Phase 5 — Verify fork URL integrity

After any merge, confirm no fork URLs regressed:

```bash
grep -rn "garrytan/gbrain" \
  src/commands/ \
  INSTALL_FOR_AGENTS.md CONTRIBUTING.md README.md \
  scripts/fix-v0.11.0.sh \
  docs/guides/upgrades-auto-update.md docs/guides/minions-fix.md \
  docs/GBRAIN_SKILLPACK.md docs/GBRAIN_RECOMMENDED_SCHEMA.md \
  skills/setup/SKILL.md 2>/dev/null
```

Expected: no matches. If anything prints, fix the file (swap to
`donovan-yohan/kbrain`) before committing.

## Phase 6 — Run tests

```bash
bun install
bun test
```

If upstream touched the schema or migrations, also smoke test:

```bash
bun run build:schema 2>/dev/null || true
```

## Phase 7 — Commit and push

If the merge had no conflicts, `git merge` already created a merge commit. If you
resolved conflicts, finalize the merge commit:

```bash
git add -A
git commit --no-edit
git push origin master
```

Use `git commit --no-edit` so the default merge message is preserved. Do not
rewrite it with a custom message that hides the upstream merge.

## When not to run this skill

- In the middle of a feature branch. Merge upstream into `master` first, then
  rebase your feature branch on master.
- When the working tree is dirty. Commit or stash first.
- Immediately before `/ship`. Merge upstream earlier so tests and reviews reflect
  the merged state.
