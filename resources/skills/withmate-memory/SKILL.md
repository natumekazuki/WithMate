---
name: withmate-memory
description: Search, append, inspect, and forget WithMate V6 Memory through the installed WithMate Memory CLI when durable project or character context is useful.
---

# WithMate Memory

Use this skill when a task may depend on durable WithMate Memory or when the user asks to remember, forget, reuse, or inspect stored project or character context.

## When To Use

Use Memory before making a durable project or character-sensitive decision when the task mentions or implies:

- previous decisions, past agreements, remembered context, preferences, conventions, or constraints
- provider behavior, approval/sandbox/model/reasoning policy, session lifecycle, Memory, database, migration, privacy, or docs source-of-truth questions
- "remember", "forget", "do not use this anymore", "use the same policy as before", or similar user intent
- a design or implementation review where prior repo-specific direction may matter

Use Memory after an unexpected command, test, build, tool invocation, or environment check failure when a known failure pattern, tooling trap, environment constraint, or workaround could affect the next action.

Do not use Memory for trivial local edits where the current files and user message fully determine the answer.

## Principles

- Use the installed `withmate-memory` CLI instead of reading WithMate database files directly.
- Prefer `withmate-memory ...` commands. If the command is not on `PATH` and this managed skill includes `bin/withmate-memory.mjs`, use `node bin/withmate-memory.mjs ...` as a temporary bundled-helper fallback.
- Project Memory and user-global Memory are available from external Codex or shell sessions while WithMate is running; use explicit targets.
- Search before relying on remembered project or character decisions.
- Use `get-entry` only for search hits whose exact body matters.
- Append only durable decisions, constraints, conventions, preferences, or context that will matter in future sessions.
- Forget entries when the user asks to remove, correct, or stop using remembered information.
- Treat missing or unavailable Memory as non-blocking unless the user explicitly made Memory access the task.

## Workflow

1. Search first with an explicit target.
2. Inspect only relevant hits with `get-entry` when exact wording or rationale matters.
3. Use retrieved Memory as supporting context, not as a replacement for reading current repo files and source-of-truth docs.
4. Before repeating the same failed command unchanged or escalating to a broader strategy, search Memory with the command/tool name, subsystem, and error signature when available.
5. Append only durable, future-useful facts or decisions. Keep title and preview short, body precise, and tags reusable.
6. If a failure reveals a reusable pattern or reliable workaround that is likely to matter in future sessions, append a concise Memory entry describing the failure signature, likely cause, and next-time guidance.
7. Forget entries when the user requests removal, correction, privacy cleanup, or no-longer-use semantics.
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
- Is it a decision, constraint, convention, preference, or durable context rather than transient progress?
- Does it avoid secrets, tokens, private paths, raw logs, large diffs, and speculative claims?
- Is the target explicit and correct?
- Would a future agent understand the entry from title, preview, body, and tags alone?

When correcting a previous entry, append a replacement with `supersedes` instead of creating ambiguous duplicates when possible.

## CLI

Run the installed command from the target project directory:

```bash
withmate-memory --help
withmate-memory status
withmate-memory context
withmate-memory schema
withmate-memory validate --command append --stdin
withmate-memory search --project . --query "release workflow"
withmate-memory search --project . --query "delivery cleanup" --tag delivery-cleanup
withmate-memory search --project . --tags topic:delivery-cleanup,topic:relaygraph
withmate-memory search --project . --query "withmate-memory search MEMORY_UNKNOWN_FIELD target targets"
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
      project = @{ type = "path"; path = "." }
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

`schema` does not require a request body and returns supported commands, request body input modes, target selector forms, memory entry kinds, and forget reasons.

`validate` validates a request body locally without writing Memory:

```bash
withmate-memory validate --command append --stdin
```

`context` sends this default body when no JSON is supplied:

```json
{ "schemaVersion": "withmate-memory-v1" }
```

`search`:

```json
{
  "schemaVersion": "withmate-memory-v1",
  "targets": [
    { "owner": "project", "project": { "type": "path", "path": "." }, "scope": "project" }
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
  "target": { "owner": "project", "project": { "type": "path", "path": "." }, "scope": "project" }
}
```

`list-tags`:

```json
{
  "schemaVersion": "withmate-memory-v1",
  "targets": [
    { "owner": "project", "project": { "type": "path", "path": "." }, "scope": "project" }
  ]
}
```

`append`:

```json
{
  "schemaVersion": "withmate-memory-v1",
  "target": { "owner": "project", "project": { "type": "path", "path": "." }, "scope": "project" },
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
  "target": { "owner": "project", "project": { "type": "path", "path": "." }, "scope": "project" },
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

- Use a project target with `{ "project": { "type": "path", "path": "." } }` when the current directory is the intended project, including from outside WithMate-launched sessions. The helper resolves relative project paths against its own cwd before sending the request.
- Use a user-global target with `{ "owner": "user", "scope": "global" }` only for provider-independent user preferences, conventions, constraints, or other cross-project context. Do not store secrets, tokens, or project-specific private details there.
- Use character targets only inside a WithMate-launched session where session binding context is available.
- External Codex or shell sessions can use project Memory and user-global Memory; explicit character IDs are not supported for `local_user` principals yet.
- Do not infer project or character targets silently when a command requires an explicit target.

## Error Handling

- If WithMate is not running or Memory is unavailable, continue the task and mention that Memory could not be used.
- If `withmate-memory` is not found on `PATH` and no local bundled helper exists, ask the user to install or update WithMate and continue without Memory unless Memory access itself is required.
- If current character context is unavailable, use an explicit project target when the task can be answered from project memory; otherwise continue without Character Memory.
- Do not expose internal runtime identifiers, secrets, headers, or local discovery details in user-facing output.
