# Plans

Implementation plans live here as markdown files and move one-directionally through
four states, one subdirectory each:

```
backlog → ready → in-progress → done
```

- **backlog/** — rough ideas, unscoped. Not ready to work on.
- **ready/** — fully specced. Anyone (human or agent) could pick it up.
- **in-progress/** — actively being implemented. Kept updated as decisions land.
- **done/** — shipped, with an accurate record of what was actually built.

Moving backwards is fine if scope changes or work pauses — just update `status` and
`updated`.

## Naming

Kebab-case filenames that describe the work: `add-oauth-login.md`,
`refactor-queue-consumer.md`. The name stays stable across the lifecycle; only the
directory changes.

## Frontmatter

Every plan starts with YAML frontmatter; `status` mirrors the directory:

```yaml
---
title: Add OAuth login
status: Ready         # Backlog | Ready | In Progress | Complete
created: 2026-07-01
updated: 2026-07-17
---
```

## Template

```markdown
---
title: <short title>
status: Ready
created: YYYY-MM-DD
updated: YYYY-MM-DD
---

# <Title>

## Goal
One or two sentences on what this plan achieves and why.

## Context
Background, constraints, links to related plans, issues, or discussions.

## Approach
The intended implementation — detail should match the risk of the work.

## Tasks
- [ ] High-level checklist of the work.

## Open questions
Anything unresolved. Resolve or delete these before moving to `ready/`.
```

## Finishing a plan

When done, move to `done/`, set `status: Complete`, and add **Overview** (what was
built, for a future reader) and **Architecture** (how the pieces fit, plus honest
deviations from the original approach and why).

## Managing plans

Driven by the `/planning` slash command (`--new`, `--prepare`, `--start`, `--finish`,
`--tidy`). This README is the source of truth for the workflow in this repo.
