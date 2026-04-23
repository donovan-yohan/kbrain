---
name: agent-bridge
version: 1.0.0
description: |
  Zero-overhead agent integration for gbrain via SSH. Use when the user shares
  articles, repos, or asks questions that require brain knowledge. Replaces the
  full MCP suite with a ~80-token system prompt.
triggers:
  - shares a link or URL
  - "read this"
  - "save this"
  - "what do we know about"
  - "tell me about"
  - "look up"
tools:
  - ssh
  - gbrain
mutating: true
---

# Agent Bridge — SSH Prompt

Copy and paste the block below into any agent's system prompt (Claude, Codex,
Hermes, etc). It costs ~80 tokens and replaces the full MCP tool suite.

## System Prompt (copy-paste)

```
You have a knowledge brain accessible via ssh kbrain.
Search: ssh kbrain "gbrain query 'Q'".
Read: ssh kbrain "gbrain get SLUG".
Write: echo "markdown" | ssh kbrain "gbrain put SLUG".
When user shares articles/repos, write a page with analysis.
When user asks questions, search first, then read top 3 pages.
Cite sources as [Source: slug].
After batch writes, run: ssh kbrain "gbrain sync && gbrain embed --stale".
```

## Full Command Reference

| Task | Command |
|------|---------|
| Hybrid search | `ssh kbrain "gbrain query 'question'"` |
| Keyword search | `ssh kbrain "gbrain search 'term'"` |
| Read page | `ssh kbrain "gbrain get concepts/slug"` |
| Write page | `printf '%s' "$markdown" \| ssh kbrain "gbrain put concepts/slug"` |
| List pages | `ssh kbrain "gbrain list --type concept"` |
| Graph query | `ssh kbrain "gbrain graph-query companies/acme --type works_at --direction in"` |
| Backlinks | `ssh kbrain "gbrain backlinks people/alice"` |
| Timeline | `ssh kbrain "gbrain timeline people/alice"` |
| Sync repo | `ssh kbrain "gbrain sync"` |
| Embed stale | `ssh kbrain "gbrain embed --stale"` |
| Health check | `ssh kbrain "gbrain doctor --json"` |

## Page Format

When writing pages via `put`, use YAML frontmatter:

```markdown
---
title: "Page Title"
type: concept
tags: [ai, infra]
---

## Summary
Brief summary here.

## Key Data / Claims
- Fact with [Source: url]

## Analysis
Connect to existing brain knowledge. What's new, what contradicts.
```

## Notes

- `kbrain` must be configured in `~/.ssh/config` pointing at your LXC.
- The `gbrain put` command reads markdown from stdin.
- Use `printf '%s' "$content" \| ssh ...` instead of `echo` to avoid escaping
  issues with newlines and special characters.
- Run `gbrain sync` after batch writes to update the search index.
- Run `gbrain embed --stale` after sync to generate missing embeddings.
