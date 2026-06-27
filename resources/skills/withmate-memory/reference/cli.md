# WithMate Memory Helper Reference

The bundled helper is a thin client for the running WithMate V6 Memory API. It does not read or write database files directly.
Project-scoped Memory can be used from external Codex or shell sessions while WithMate is running. Current character and current session context require a WithMate-launched session binding.

Run it from this skill directory:

```bash
node bin/withmate-memory.mjs <command> [--json <json> | --file <path>]
```

On Windows, `bin/withmate-memory.cmd` wraps the same script.

## Commands

### status

```bash
node bin/withmate-memory.mjs status
```

Returns runtime status.

### context

```bash
node bin/withmate-memory.mjs context
```

Sends:

```json
{ "schemaVersion": "withmate-memory-v1" }
```

### search

```bash
node bin/withmate-memory.mjs search --json '{"schemaVersion":"withmate-memory-v1","targets":[{"owner":"project","project":{"type":"path","path":"."},"scope":"project"}],"query":"approval mode"}'
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
node bin/withmate-memory.mjs get-entry --json '{"schemaVersion":"withmate-memory-v1","entryId":"<entry-id>","target":{"owner":"project","project":{"type":"path","path":"."},"scope":"project"}}'
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
node bin/withmate-memory.mjs list-tags --json '{"schemaVersion":"withmate-memory-v1","targets":[{"owner":"project","project":{"type":"path","path":"."},"scope":"project"}]}'
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
node bin/withmate-memory.mjs append --file memory-entry.json
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
node bin/withmate-memory.mjs forget --file forget-request.json
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
- External `get-entry` requests require an explicit project target.
- `{ "character": { "type": "current" } }` and `context` require a WithMate-launched session binding.
- Append is idempotent when an idempotency key is supplied.
- Forget hides entries from normal search and skill results.
- Memory failures should not fail unrelated coding work.
