---
name: withmate-memory
description: Search, append, inspect, and forget WithMate V6 Memory through the bundled local helper when durable project or character context is useful.
---

# WithMate Memory

Use this skill when a task may depend on durable WithMate Memory or when the user asks to remember, forget, reuse, or inspect stored project or character context.

## When To Use

Use Memory before making a durable project or character-sensitive decision when the task mentions or implies:

- previous decisions, past agreements, remembered context, preferences, conventions, or constraints
- provider behavior, approval/sandbox/model/reasoning policy, session lifecycle, Memory, database, migration, privacy, or docs source-of-truth questions
- "remember", "forget", "do not use this anymore", "use the same policy as before", or similar user intent
- a design or implementation review where prior repo-specific direction may matter

Do not use Memory for trivial local edits where the current files and user message fully determine the answer.

## Principles

- Use the bundled helper script instead of reading WithMate database files directly.
- Project Memory is available from external Codex or shell sessions while WithMate is running; use explicit project targets.
- Search before relying on remembered project or character decisions.
- Use `get-entry` only for search hits whose exact body matters.
- Append only durable decisions, constraints, conventions, preferences, or context that will matter in future sessions.
- Forget entries when the user asks to remove, correct, or stop using remembered information.
- Treat missing or unavailable Memory as non-blocking unless the user explicitly made Memory access the task.

## Workflow

1. Search first with an explicit target.
2. Inspect only relevant hits with `get-entry` when exact wording or rationale matters.
3. Use retrieved Memory as supporting context, not as a replacement for reading current repo files and source-of-truth docs.
4. Append only durable, future-useful facts or decisions. Keep title and preview short, body precise, and tags reusable.
5. Forget entries when the user requests removal, correction, privacy cleanup, or no-longer-use semantics.
6. If Memory is unavailable, continue the task unless Memory access itself is the requested task.

## Append Safety

Before append, check:

- Is this expected to matter in future sessions?
- Is it a decision, constraint, convention, preference, or durable context rather than transient progress?
- Does it avoid secrets, tokens, private paths, raw logs, large diffs, and speculative claims?
- Is the target explicit and correct?
- Would a future agent understand the entry from title, preview, body, and tags alone?

When correcting a previous entry, append a replacement with `supersedes` instead of creating ambiguous duplicates when possible.

## Helper

Run the helper from this skill directory:

```bash
node bin/withmate-memory.mjs status
node bin/withmate-memory.mjs context
node bin/withmate-memory.mjs search --json '{"schemaVersion":"withmate-memory-v1","targets":[{"owner":"project","project":{"type":"path","path":"."},"scope":"project"}],"query":"release workflow"}'
node bin/withmate-memory.mjs get-entry --json '{"schemaVersion":"withmate-memory-v1","entryId":"<entry-id>","target":{"owner":"project","project":{"type":"path","path":"."},"scope":"project"}}'
node bin/withmate-memory.mjs list-tags --json '{"schemaVersion":"withmate-memory-v1","targets":[{"owner":"project","project":{"type":"path","path":"."},"scope":"project"}]}'
node bin/withmate-memory.mjs append --file memory-entry.json
node bin/withmate-memory.mjs forget --file forget-request.json
```

On Windows, `bin/withmate-memory.cmd` wraps the same helper.

Read `reference/cli.md` for JSON shapes and error handling.

## Target Selection

- Use a project target with `{ "project": { "type": "path", "path": "." } }` when the current directory is the intended project, including from outside WithMate-launched sessions. The helper resolves relative project paths against its own cwd before sending the request.
- Use character targets only inside a WithMate-launched session where session binding context is available.
- External Codex or shell sessions can use project memory only; explicit character IDs are not supported for `local_user` principals yet.
- Do not infer project or character targets silently when a command requires an explicit target.

## Error Handling

- If WithMate is not running or Memory is unavailable, continue the task and mention that Memory could not be used.
- If current character context is unavailable, use an explicit project target when the task can be answered from project memory; otherwise continue without Character Memory.
- Do not expose internal runtime identifiers, secrets, headers, or local discovery details in user-facing output.
