# WithMate Memory Helper Reference

The bundled helper is a thin client for the running WithMate V6 Memory API. It does not read or write database files directly.
Project-scoped Memory can be used from external Codex or shell sessions while WithMate is running. Current character and current session context require a WithMate-launched session binding.

Run it from the target project directory after WithMate is installed:

```bash
withmate-memory <command> [--json <json> | --file <path>]
```

For commands that require a request body, prefer `--file <path>`. Inline `--json` is supported, but it is shell-sensitive. On Windows PowerShell or `.cmd` wrappers, double quotes inside JSON can be consumed before the CLI receives the argument. If `--json` fails with invalid JSON or a CLI usage error, write the request to a temporary JSON file and retry with `--file`.

On Windows, the installer places `withmate-memory.cmd` in the WithMate install directory and creates a user-level alias at `%LOCALAPPDATA%\Microsoft\WindowsApps\withmate-memory.cmd`. It does not edit the user's `Path` registry value. A new terminal may be required after install or uninstall.

When a managed skill includes `bin/withmate-memory.mjs` and no `withmate-memory` command is available on `PATH`, use `node bin/withmate-memory.mjs <command>` as a temporary fallback.

## Commands

### status

```bash
withmate-memory status
```

Returns runtime status.

### context

```bash
withmate-memory context
```

Sends:

```json
{ "schemaVersion": "withmate-memory-v1" }
```

### search

```bash
withmate-memory search --file memory-search.json
```

Request shape:

```json
{
  "schemaVersion": "withmate-memory-v1",
  "targets": [
    { "owner": "project", "project": { "type": "path", "path": "." }, "scope": "project" }
  ],
  "query": "approval mode"
}
```

Search returns active entry previews only. Use `get-entry` when the exact body matters.

### get-entry

```bash
withmate-memory get-entry --file memory-get-entry.json
```

Request shape:

```json
{
  "schemaVersion": "withmate-memory-v1",
  "entryId": "<entry-id>",
  "target": { "owner": "project", "project": { "type": "path", "path": "." }, "scope": "project" }
}
```

External Codex or shell sessions must include `target`. WithMate-launched sessions with a binding may omit it.

### list-tags

```bash
withmate-memory list-tags --file memory-list-tags.json
```

Request shape:

```json
{
  "schemaVersion": "withmate-memory-v1",
  "targets": [
    { "owner": "project", "project": { "type": "path", "path": "." }, "scope": "project" }
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
  "target": { "owner": "project", "project": { "type": "path", "path": "." }, "scope": "project" },
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
  "target": { "owner": "project", "project": { "type": "path", "path": "." }, "scope": "project" },
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
- Project targets with `{ "type": "path", "path": "." }` are valid from external Codex sessions.
- Relative project paths are resolved by the helper against the CLI process cwd before being sent to WithMate.
- External `get-entry` requests require an explicit project target.
- Character targets and `context` require a WithMate-launched session binding.
- External Codex or shell sessions currently support project memory only; explicit Character ID access needs a separate principal and authorization design.
- Append is idempotent when an idempotency key is supplied.
- Forget hides entries from normal search and skill results.
- Memory failures should not fail unrelated coding work.
