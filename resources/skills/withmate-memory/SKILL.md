---
name: withmate-memory
description: Search, append, inspect, and forget WithMate V6 Memory through the bundled local helper when durable project or character context is useful.
---

# WithMate Memory

Use this skill when a task may depend on durable WithMate Memory or when the user asks to remember, forget, reuse, or inspect stored project or character context.

## Principles

- Use the bundled helper script instead of reading WithMate database files directly.
- Project Memory is available from external Codex or shell sessions while WithMate is running; use explicit project targets.
- Search before relying on remembered project or character decisions.
- Use `get-entry` only for search hits whose exact body matters.
- Append only durable decisions, constraints, conventions, preferences, or context that will matter in future sessions.
- Forget entries when the user asks to remove, correct, or stop using remembered information.
- Treat missing or unavailable Memory as non-blocking unless the user explicitly made Memory access the task.

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
- Use `{ "character": { "type": "current" } }` only inside a WithMate-launched session where current character context is available.
- Do not infer project or character targets silently when a command requires an explicit target.

## Error Handling

- If WithMate is not running or Memory is unavailable, continue the task and mention that Memory could not be used.
- If current character context is unavailable, retry with an explicit character or project target when appropriate.
- Do not expose internal runtime identifiers, secrets, headers, or local discovery details in user-facing output.
