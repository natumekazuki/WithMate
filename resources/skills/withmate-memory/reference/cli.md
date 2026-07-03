# WithMate Memory Helper Reference

The bundled helper is a thin client for the running WithMate V6 Memory API. It does not read or write database files directly.
Project-scoped, character-scoped, and user-global Memory require explicit targets. Project targets use an explicit project path or ID. Character targets use an explicit character ID.

Run it with an explicit target after WithMate is installed:

```bash
withmate-memory <command> [--json <json> | --file <path> | --stdin]
withmate-memory --help
```

For commands that require a request body, prefer `--stdin` or `--file <path>`. Inline `--json` is supported, but it is shell-sensitive. On Windows PowerShell or `.cmd` wrappers, double quotes inside JSON can be consumed before the CLI receives the argument. If `--json` fails with invalid JSON or a CLI usage error, pipe the request through `--stdin`, or write it to a temporary JSON file and retry with `--file`.

On Windows, the installer places `withmate-memory.cmd` in the WithMate install directory and creates a user-level alias at `%LOCALAPPDATA%\Microsoft\WindowsApps\withmate-memory.cmd`. It does not edit the user's `Path` registry value. A new terminal may be required after install or uninstall.

When a managed skill includes `bin/withmate-memory.mjs` and no `withmate-memory` command is available on `PATH`, use `node bin/withmate-memory.mjs <command>` as a temporary fallback.

## Commands

### help

```bash
withmate-memory --help
withmate-memory -h
withmate-memory help
withmate-memory search --help
```

Prints CLI usage text and exits without connecting to the runtime API.

### schema

```bash
withmate-memory schema
```

Returns supported commands, request body input modes, target selector forms, memory entry kinds, and forget reasons.

### validate

```bash
withmate-memory validate --command append --stdin
```

Validates a request body locally and prints either `{ "valid": true, ... }` or a memory validation error. It does not create, update, or forget Memory.

### status

```bash
withmate-memory status
```

Returns runtime status.

### characters

```bash
withmate-memory characters
```

Returns active Character catalog entries so callers can choose an explicit Character ID. It does not return Character definition or notes body.

### search

```bash
withmate-memory search --project <absolute-repo-path> --query "delivery cleanup" --tag delivery-cleanup
withmate-memory search --project <absolute-repo-path> --tags topic:delivery-cleanup,topic:relaygraph
withmate-memory search --file memory-search.json
```

Request shape:

```json
{
  "schemaVersion": "withmate-memory-v1",
  "targets": [
    { "owner": "project", "project": { "type": "path", "path": "<absolute-repo-path>" }, "scope": "project" }
  ],
  "query": "approval mode"
}
```

Search returns active entry previews only. Use `get-entry` when the exact body matters.
Search uses natural-language terms across title, preview, body, and tags. Hyphenated and spaced tag words such as `delivery-cleanup` and `delivery cleanup` are treated as related candidates. Shorthand `--tag <tag>` defaults to `topic:<tag>`, and `--tags` accepts comma-separated `<type>:<tag>` values. Search results may include matched fields and a short snippet; body matches may be reported in `match.fields`, but snippets are limited to tags, title, and preview. 0-result responses may include related tag candidates.

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

### get-entry

```bash
withmate-memory get-entry --file memory-get-entry.json
```

Request shape:

```json
{
  "schemaVersion": "withmate-memory-v1",
  "entryId": "<entry-id>",
  "target": { "owner": "project", "project": { "type": "path", "path": "<absolute-repo-path>" }, "scope": "project" }
}
```

`get-entry` must include `target`, using a project target, character target, character-project target, or `{ "owner": "user", "scope": "global" }`.

### list-tags

```bash
withmate-memory list-tags --file memory-list-tags.json
```

Request shape:

```json
{
  "schemaVersion": "withmate-memory-v1",
  "targets": [
    { "owner": "project", "project": { "type": "path", "path": "<absolute-repo-path>" }, "scope": "project" }
  ]
}
```

### append

```bash
withmate-memory append --file memory-entry.json
```

Input shape:

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

### forget

```bash
withmate-memory forget --file forget-request.json
```

Input shape:

```json
{
  "schemaVersion": "withmate-memory-v1",
  "target": { "owner": "project", "project": { "type": "path", "path": "<absolute-repo-path>" }, "scope": "project" },
  "entryIds": ["entry-id"],
  "reason": "user_request",
  "idempotencyKey": "optional-stable-key"
}
```

## Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Usage or validation error |
| `2` | WithMate Memory API is not running or could not be discovered |
| `3` | Runtime API returned a non-success JSON response |
| `4` | Transport failure |

## Notes

- Search results exclude forgotten and superseded entries.
- Project targets use `--project <absolute-repo-path>`, `--project-id <id>`, `{ "type": "path", "path": "<absolute-repo-path>" }`, or `{ "type": "id", "id": "<project-id>" }`. Explicit absolute paths are not limited to the session's attached projects.
- Relative project paths and `.` are rejected by the helper.
- `get-entry` requests require an explicit target.
- Character targets use explicit IDs, for example `{ "owner": "character", "character": { "type": "id", "id": "<character-id>" }, "scope": "character" }`. If the ID is unknown, run `withmate-memory characters` first.
- User-global Memory is visible across projects and providers. Store only user-level preferences, conventions, constraints, or other cross-project context there; do not store secrets, tokens, or project-specific private details.
- Append is idempotent when an idempotency key is supplied.
- Forget hides entries from normal search and skill results.
- Memory failures should not fail unrelated coding work.
