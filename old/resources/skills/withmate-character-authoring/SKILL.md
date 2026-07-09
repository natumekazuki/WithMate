---
name: withmate-character-authoring
description: Author or improve WithMate V5 character definition files inside a WithMate-created character-authoring workspace. Use when the workspace contains AUTHORING_PROMPT.md, input.json, character.md, character-notes.md, and the withmate-character-authoring skill under the provider skill directory; update only the workspace files, not app database or packaged resources.
---

# WithMate Character Authoring

## Role

Work inside the current WithMate character-authoring workspace.

WithMate has already prepared the workspace, copied this skill, and seeded:

- `AUTHORING_PROMPT.md`
- `input.json`
- `character.md`
- `character-notes.md`

Do not create a new outer pack directory. Edit the files in the workspace root.

## First Steps

1. Read `AUTHORING_PROMPT.md`.
2. Read `input.json`.
3. Inspect `character.md` and `character-notes.md`.
4. Decide whether the run is `create` or `improve`.
5. Update only the workspace files needed for the request.

## Boundaries

- Do not edit app database files, packaged app resources, or files outside the workspace.
- Do not assume Skill picker, agent picker, or user-selected authoring skills exist.
- Do not use Grow From Conversations.
- Do not infer from session, companion, or chat history unless the user explicitly placed that material in the workspace or prompt.
- Do not remove `character.md` frontmatter.
- Do not zip artifacts unless the user explicitly asks.
- When done, report which workspace files changed and any validation concerns.

## Target Files

### `character.md`

This is the runtime definition. Keep it person-first and useful for visible responses.

Required frontmatter:

```yaml
---
schema: withmate-character-v5
name: "Display Name"
description: "Short description"
---
```

Recommended body shape:

```md
# Profile

## Experience Goal
## Core Presence
## User Relationship
## Default Response Style
## Work / Response Separation
## Natural Reactions
## Situation Styles
## Voice Rules
## Emotional Texture
## Signature Phrases
## Presence Priority
## Minimal Reliability
## Examples
```

Write the body as behavior that affects what the user sees. Keep authoring notes out of this file.

### `character-notes.md`

Use for source notes, interpretation, revision logs, do-not-reintroduce decisions, rejected ideas, uncertainty, and future improvement ideas.

## Writing Rules

For `character.md`:

- Treat the subject as a person, not as a constructed role.
- Prefer terms like 本人, その人, 相手, らしさ, 口調, 距離感.
- Avoid describing the subject as `Character`, `persona`, キャラクター, ロールプレイ, or 作られた役 in the body.
- Do not include WithMate implementation details.
- Do not explain prompt injection, provider sync, source policy, notes, reports, or this workflow.
- Keep reliability guidance short and concrete.
- Keep long evidence, rights notes, and uncertainty in `character-notes.md`.

For improve mode:

- Preserve useful existing structure and voice.
- Prefer focused edits over full rewrite.
- Record meaningful changes and rationale in `character-notes.md`.
- When removing or replacing wording because it produced bad behavior, update `Revision Log` and `Do Not Reintroduce` with the old pattern, observed problem, and replacement guardrail.

For create mode:

- Fill the seeded structure enough that the result is usable.
- Leave explicit blanks only when the user has not supplied enough information.
- Record assumptions and missing inputs in `character-notes.md`.

## Final Response

Reply with:

- files changed
- what changed
- checks performed
- unresolved questions or missing source material

Do not return a Zip link unless a Zip was explicitly requested and actually created.
