---
name: withmate-memory
description: Search, append, inspect, and forget WithMate V6 Memory through the installed WithMate Memory CLI when durable project context or cross-session Character continuity, including explicit relationship preferences, conversational distance, recurring topics, and memorable exchanges, could affect the task or conversation. After a command, test, build, tool, or environment failure, use it only when stored failure patterns, constraints, or workarounds could change the next action; do not trigger on a non-zero exit alone or for a deterministic correction supported by current evidence.
---

# WithMate Memory

Use this skill when a task or conversation may depend on reusable WithMate Memory, or when the user asks to remember, forget, reuse, or inspect stored project or Character context.

## When To Use

Use Memory before making a durable project or character-sensitive decision when the task mentions or implies:

- previous decisions, past agreements, remembered context, preferences, conventions, or constraints
- past conversations, relationship preferences, conversational distance, recurring topics, preferred ways of interacting, or memorable exchanges with a Character
- provider behavior, approval/sandbox/model/reasoning policy, session lifecycle, Memory, database, migration, privacy, or docs source-of-truth questions
- "remember", "forget", "do not use this anymore", "what did we discuss before?", "use the same policy as before", or similar user intent
- a design or implementation review where prior repo-specific direction may matter

Use Memory after an unexpected command, test, build, tool invocation, or environment check failure only when a known failure pattern, tooling trap, environment constraint, or workaround could affect the next action.

A non-zero exit code alone is not a Memory trigger. Skip Memory search when current evidence fully explains the failure and determines a safe corrected action.

Do not search Memory on every turn. Skip it for trivial local edits or conversations where the current files and user message fully determine the answer.

## Principles

- Use the installed `withmate-memory` CLI instead of reading WithMate database files directly.
- Prefer `withmate-memory ...` commands. If the command is not on `PATH` and this managed skill includes `bin/withmate-memory.mjs`, use `node bin/withmate-memory.mjs ...` as a temporary bundled-helper fallback.
- Project, user-global, character, and character+project Memory are available from external Codex or shell sessions while WithMate is running; use explicit targets.
- Keep repository-owned current state, expected behavior, executable contracts, and decision rationale in repository sources of truth. Memory may point to those sources but must not replace them.
- Do not exclude context merely because it is repository-specific. Put reusable project background, preferences, investigation context, and workarounds in project Memory when they do not belong in a maintained repository artifact.
- Keep unfinished state, unexecuted validation, and the next action in a handoff rather than Memory.
- Search before relying on remembered project or Character decisions.
- Use `get-entry` only for search hits whose exact body matters.
- Append only future-useful decisions, constraints, conventions, preferences, context, or Character observations that will matter across sessions.
- Correct or forget entries only when the user asks to remove, correct, or stop using remembered information.
- Treat missing or unavailable Memory as non-blocking unless the user explicitly made Memory access the task.

## Character Memory

Treat Character Memory as an observation record for natural conversation continuity across sessions, not as a person profile or proof of facts.

Save explicit relationship preferences, conversational distance, recurring topics, and memorable exchanges when they are likely to improve a future conversation. Preferred names, light inside jokes, interaction styles, and topics the user wants to continue are also candidates. The user does not need to say `remember` when the content is explicit, within the current conversation's scope, and clearly reusable across sessions.

Do not save every conversation, temporary emotions, one-off acknowledgements, routine small talk, raw transcripts, or details with no likely future value. Keep explicit user statements separate from agent inference. Write observations as attributed context such as "The user said they prefer..." rather than converting them into unqualified facts.

Do not infer romance, exclusivity, real-world relationships, attributes, or feelings from stored interactions. The current user message and current Character Definition take precedence over Memory. Never use Memory to overwrite or amend the Character Definition.

Search Character Memory when the user asks about the past, or when a prior relationship preference, ongoing topic, or conversation episode could naturally improve the current response. Do not perform Character recall on every turn. If no relevant hit exists, do not invent one. If old Memory conflicts with the current user message, follow the current message and use the correction or forget flow when the user asks to change future behavior.

## Workflow

1. Search first with an explicit target.
2. Inspect only relevant hits with `get-entry` when exact wording or rationale matters.
3. Use retrieved Memory as supporting context, not as a replacement for reading current repo files and source-of-truth docs.
4. After a failure, diagnose it from current evidence first. Search Memory before retrying when the cause or safe next action remains uncertain, the same failure signature recurs, or the next attempt changes scope, subsystem, strategy, permissions, or environment assumptions. Skip search for a deterministic correction supported by current evidence.
5. Append only future-useful facts, decisions, preferences, or attributed Character observations that pass Append Safety. Keep title and preview short, body precise, and tags reusable.
6. If a failure reveals a reusable pattern or reliable workaround that is likely to matter in future sessions, append a concise Memory entry describing the failure signature, likely cause, and next-time guidance.
7. Correct or forget entries when the user explicitly requests removal, correction, privacy cleanup, or no-longer-use semantics.
8. If Memory is unavailable, continue the task unless Memory access itself is the requested task.

## User-Facing Memory Behavior

Treat routine Memory search/read as background recall. Do not announce MemorySkill or CLI usage to the user just because a routine search/read happened.

Use retrieved Memory naturally, and mention it only when it materially affects the answer, conflicts with current context, needs traceability, or the user asks what context was used.

When creating or correcting/superseding Memory entries, mention the durable change only when the user asked for it, privacy or traceability matters, or the final response would otherwise hide a meaningful durable side effect.

Forget and correction operations should be explicit when they affect future behavior, unless the user requested silent cleanup.

Do not hide Memory failures, invent retrieved context, or treat Memory as a replacement for repository source-of-truth files.

Prefer natural wording such as "Based on the previous decision..." or "For next time, I recorded the reusable point." Avoid routine tool narration such as "I will use the withmate-memory Skill" or "I searched MemorySkill."

## Append Safety

Before append, check:

- Is this expected to matter in future sessions?
- Is it a decision, constraint, convention, preference, reusable context, or explicit Character observation rather than transient progress?
- If the user did not say `remember`, is the content nevertheless explicit, in scope, and clearly useful for future project work or conversation continuity?
- Does the entry attribute what the user actually said and avoid converting an agent inference into a fact?
- Does it avoid secrets, tokens, private paths, raw logs, large diffs, and speculative claims?
- Is the target explicit and correct?
- Would a future agent understand the entry from title, preview, body, and tags alone?

Do not append all conversation by default. Require explicit user intent before saving an inference, saving content outside the current task or conversation scope, or changing an existing Memory entry.

When correcting a previous entry, inspect the exact entry, then append a replacement with `supersedes` instead of creating ambiguous duplicates when possible. Use `forget` when the user explicitly requests removal rather than replacement. Keep the same semantic target unless the user is also correcting the scope.

## CLI

Run the installed command with an explicit target:

```bash
withmate-memory --help
withmate-memory status
withmate-memory characters
withmate-memory schema
withmate-memory validate --command append --stdin
withmate-memory search --project <absolute-repo-path> --query "delivery cleanup" --tag delivery-cleanup
withmate-memory search --project <absolute-repo-path> --tags topic:delivery-cleanup,topic:relaygraph
withmate-memory search --file memory-search.json
withmate-memory get-entry --file memory-get-entry.json
withmate-memory list-tags --file memory-list-tags.json
withmate-memory append --file memory-entry.json
withmate-memory forget --file forget-request.json
```

Commands write one JSON object to stdout, except `--help`, `-h`, and `help`, which print usage text.

For commands that require a request body, prefer `--stdin` or `--file <path>`. Inline `--json` is supported, but it is shell-sensitive. On Windows PowerShell or `.cmd` wrappers, double quotes inside JSON can be consumed before the CLI receives the argument. If `--json` fails with invalid JSON or a CLI usage error, pipe the request through `--stdin`, or write it to a temporary JSON file and retry with `--file`.

If `withmate-memory` is not found and `bin/withmate-memory.mjs` exists in this skill directory, replace `withmate-memory` with `node bin/withmate-memory.mjs` in the commands above.

PowerShell example:

```powershell
$request = @{
  schemaVersion = "withmate-memory-v1"
  targets = @(
    @{
      owner = "project"
      project = @{ type = "path"; path = "<absolute-repo-path>" }
      scope = "project"
    }
  )
  query = "release workflow"
} | ConvertTo-Json -Depth 10

$request | withmate-memory search --stdin
```

### Request Shapes

`help`, `--help`, and `-h` do not require a request body or runtime connection.

`status` does not require a request body.

`characters` does not require a request body and returns active Character catalog entries for choosing explicit Character IDs. It does not return Character definition or notes body.

`schema` does not require a request body and returns supported commands, request body input modes, target selector forms, memory entry kinds, and forget reasons.

`validate` validates a request body locally without writing Memory:

```bash
withmate-memory validate --command append --stdin
```

`search`:

```json
{
  "schemaVersion": "withmate-memory-v1",
  "targets": [
    { "owner": "project", "project": { "type": "path", "path": "<absolute-repo-path>" }, "scope": "project" }
  ],
  "query": "approval mode"
}
```

Search supports natural-language terms across title, preview, body, and tags. Hyphenated and spaced tag words such as `delivery-cleanup` and `delivery cleanup` are treated as related candidates. Shorthand `--tag <tag>` defaults to `topic:<tag>`, and `--tags` accepts comma-separated `<type>:<tag>` values.

Search results may include `match` on each hit with matched fields and a short snippet. `match.fields` can report body matches, but snippets are limited to tags, title, and preview; use `get-entry` when the exact body matters. When no entries match, the response may include `relatedTags`.

For provider-independent user preferences, conventions, constraints, or other cross-project context, use an explicit user-global target:

```json
{
  "schemaVersion": "withmate-memory-v1",
  "targets": [
    { "owner": "user", "scope": "global" }
  ],
  "query": "shared preference"
}
```

`get-entry`:

```json
{
  "schemaVersion": "withmate-memory-v1",
  "entryId": "<entry-id>",
  "target": { "owner": "project", "project": { "type": "path", "path": "<absolute-repo-path>" }, "scope": "project" }
}
```

`list-tags`:

```json
{
  "schemaVersion": "withmate-memory-v1",
  "targets": [
    { "owner": "project", "project": { "type": "path", "path": "<absolute-repo-path>" }, "scope": "project" }
  ]
}
```

`append`:

```json
{
  "schemaVersion": "withmate-memory-v1",
  "target": { "owner": "project", "project": { "type": "path", "path": "<absolute-repo-path>" }, "scope": "project" },
  "kind": "decision",
  "title": "Short title",
  "body": "Durable details for future sessions.",
  "preview": "Short preview.",
  "tags": [{ "type": "topic", "value": "release" }],
  "idempotencyKey": "optional-stable-key"
}
```

`forget`:

```json
{
  "schemaVersion": "withmate-memory-v1",
  "target": { "owner": "project", "project": { "type": "path", "path": "<absolute-repo-path>" }, "scope": "project" },
  "entryIds": ["entry-id"],
  "reason": "user_request",
  "idempotencyKey": "optional-stable-key"
}
```

### Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Usage or validation error |
| `2` | WithMate Memory API is not running or could not be discovered |
| `3` | Runtime API returned a non-success JSON response |
| `4` | Transport failure |

## Target Selection

Choose among project, user-global, character, and character+project by asking whose context it is and where it should remain valid:

- Use a project target for repository-specific non-source-of-truth background, working preferences, investigation context, or workarounds. Use `--project <absolute-repo-path>`, `--project-id <id>`, `{ "project": { "type": "path", "path": "<absolute-repo-path>" } }`, or `{ "project": { "type": "id", "id": "<project-id>" } }`. Explicit absolute paths are not limited to the session's attached projects. Relative paths and `.` are not accepted.
- Use a user-global target with `{ "owner": "user", "scope": "global" }` only for provider-independent preferences, conventions, constraints, or other cross-project context. Do not store secrets, tokens, or project-specific private details there.
- Use a character target for relationship preferences, interaction style, recurring topics, or conversation episodes tied to one Character but not one project: `{ "owner": "character", "character": { "type": "id", "id": "<character-id>" }, "scope": "character" }`.
- Use a character+project target only when the context belongs to the combination of one Character and one project:

```json
{
  "owner": "character", "scope": "project",
  "character": { "type": "id", "id": "<character-id>" },
  "project": { "type": "path", "path": "<absolute-repo-path>" }
}
```

- If the character ID is unknown, run `withmate-memory characters` and select an explicit ID from the returned active Character catalog.
- Do not infer project or character targets silently when a command requires an explicit target.

### Decision Examples

| User input | Save or operation | Target and kind | Recall behavior |
| --- | --- | --- | --- |
| 「空澄の軽くツッコむところが好き」 | Save even without `remember` when this is an explicit, future-useful preference. | `character`; `preference` | Recall when that Character's interaction style is relevant, not on every turn. |
| 「前に話した○○、覚えてる？」 | Do not append the question itself. Search the relevant explicit target and inspect a matching entry. | Search only; no new kind. | This is an explicit recall request. If no hit exists, say so instead of inventing a memory. |
| 「このprojectでは一緒に小さい単位でレビューしたい」 | Save when "一緒に" explicitly refers to the current Character and the preference should remain project-local. | `character+project`; `preference`. Use `project` instead when the preference is not Character-specific. | Recall during planning or review work in that Character/project combination. |
| 「そういう関係ではいたくない。前の記憶は直して」 | Search and inspect the old entry, then append the correction with `supersedes`; use `forget` if removal was requested. | The old entry's target; normally `boundary` for the replacement. | Apply the current statement immediately and prefer it over the old Memory. |

## Error Handling

- If WithMate is not running or Memory is unavailable, continue the task and mention that Memory could not be used.
- If `withmate-memory` is not found on `PATH` and no local bundled helper exists, ask the user to install or update WithMate and continue without Memory unless Memory access itself is required.
- If the character ID is still unavailable, use an explicit project target when the task can be answered from project memory; otherwise continue without Character Memory.
- Do not expose internal runtime identifiers, secrets, headers, or local discovery details in user-facing output.
