# WithMate Memory Helper Reference

The bundled helper is a thin client for the running WithMate V6 Memory API. It does not read or write database files directly.
Project-scoped, character-scoped, and user-global Memory require explicit targets. Project targets use an explicit project path or ID. Character targets use an explicit character ID.

Normal agent operations use the general `memory.*` tools from the `withmate-character-context` MCP server. The commands in this reference are their CLI equivalents for transport-level MCP fallback and explicit operator or diagnostic work. A structured MCP domain error is not an availability failure and must not be bypassed with CLI.

Character context, Character-owned affect, MCP-first operation, CLI fallback, authority, effect certainty, and Character-specific commands are documented in [Character Context MCP and CLI Reference](character-context.md). This file retains the Project Memory and general helper procedures.

Run it with an explicit target after WithMate is installed:

```bash
withmate-memory <command> [--json <json> | --file <path> | --stdin]
withmate-memory --help
```

For commands that require a request body, prefer `--stdin` or `--file <path>`. Inline `--json` is supported, but it is shell-sensitive. On Windows PowerShell or `.cmd` wrappers, double quotes inside JSON can be consumed before the CLI receives the argument. If `--json` fails with invalid JSON or a CLI usage error, pipe the request through `--stdin`, or write it to a temporary JSON file and retry with `--file`.

On Windows, the installer places `withmate-memory.cmd` in the WithMate install directory and creates a user-level alias at `%LOCALAPPDATA%\Microsoft\WindowsApps\withmate-memory.cmd`. It does not edit the user's `Path` registry value. A new terminal may be required after install or uninstall.

When a managed skill includes `bin/withmate-memory.mjs` and no `withmate-memory` command is available on `PATH`, use `node bin/withmate-memory.mjs <command>` as a temporary fallback.

## Contents

- [Character Context](character-context.md)
- [Commands](#commands)
- [Exit Codes](#exit-codes)
- [Notes](#notes)

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

### file-usage

```bash
withmate-memory file-usage
withmate-memory file-usage --largest --limit 20
```

Returns WithMate-wide Protected Object quota and usage metadata. `--largest` includes the largest active Memory entry candidates and `--limit` bounds that list. It does not return source paths, object-store paths, keys, hashes, or decrypted content.

### list-targets

```bash
withmate-memory list-targets
withmate-memory list-targets --owner project --include-empty --limit 100
```

Returns paginated target inventory with target selectors, display metadata when available, active entry count, distinct tag count, and last update. Use `nextCursor` until absent. `--include-empty` adds known empty project, Character, and user-global targets; it does not create Character/project cartesian combinations.

### list-entries

```bash
withmate-memory list-entries --project <absolute-repo-path> --limit 100
```

Lists entries in one explicit target without a search query. Active entries are the default. The response omits body text unless `--include-body` or `includeBody: true` is explicit. Request JSON may also filter `states`, `kinds`, and `tags`; repeat the same filters with `nextCursor` for exhaustive enumeration.

### audit

```bash
withmate-memory audit --all-targets --format markdown
withmate-memory audit --project <absolute-repo-path> --format jsonl
```

Returns per-target kind counts, top tag counts, and bounded candidate lists for stale/progress-like entries, broader-scope language, duplicate normalized titles, repository documentation, and missing tags. Candidate classifications are conservative heuristics and do not mutate Memory. Use `--format json`, `jsonl`, or `markdown`; JSON is the default. JSONL starts each page with an `audit_page` record containing `nextCursor`, followed by `target_audit` records. Markdown includes the same counts, tag statistics, candidate families, and continuation cursor. Audit output never includes entry bodies.

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
  "query": "approval mode",
  "kinds": ["decision", "constraint"],
  "limit": 20,
  "cursor": "<nextCursor-from-prior-response>"
}
```

Search returns active entry previews only. Use `get-entry` when the exact body matters.
Search uses natural-language terms across title, preview, body, and tags. Hyphenated and spaced tag words such as `delivery-cleanup` and `delivery cleanup` are treated as related candidates. Shorthand `--tag <tag>` defaults to `topic:<tag>`, and `--tags` accepts comma-separated `<type>:<tag>` values. Search results may include matched fields and a short snippet; body matches may be reported in `match.fields`, but snippets are limited to tags, title, and preview. 0-result responses may include related tag candidates.

The response contains results in `items[]` and may contain `relatedTags[]` and `nextCursor`. Each result uses `id` as its entry ID and may include attached-object metadata in `files[]`.

`kinds`, `limit`, and `cursor` are optional. Omit `cursor` on the first page. When a response includes `nextCursor`, repeat the same target, query, kinds, tags, and limit with that cursor. Continue pagination when an exhaustive append-preflight or requested lookup has not found a conclusive match.

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
The response contains the full Memory in `entry`. Attached-object metadata, when present, is in `entry.files[]`; use each item's `objectId` with `get-file`.

### get-file

```bash
withmate-memory get-file --project <absolute-repo-path> --object-id <object-id> --output <absolute-output-path>
withmate-memory get-file --file memory-get-file.json
```

Request shape:

```json
{
  "schemaVersion": "withmate-memory-v1",
  "target": { "owner": "project", "project": { "type": "path", "path": "<absolute-repo-path>" }, "scope": "project" },
  "objectId": "<object-id>",
  "outputPath": "<absolute-output-path>"
}
```

Exports one attached object after target validation. The output path must be absolute, and an existing file is never overwritten.
The response confirms `objectId`, `entryId`, `outputPath`, `bytesWritten`, `contentType`, and `displayName`.

### export-files

```bash
withmate-memory export-files --project <absolute-repo-path> --entry-id <entry-id> --output-dir <absolute-output-directory>
withmate-memory export-files --file memory-export-files.json
```

Request shape:

```json
{
  "schemaVersion": "withmate-memory-v1",
  "target": { "owner": "project", "project": { "type": "path", "path": "<absolute-repo-path>" }, "scope": "project" },
  "entryId": "<entry-id>",
  "outputDirectoryPath": "<absolute-output-directory>"
}
```

Creates the output directory when needed and exports all files attached to the entry with safe object-prefixed names. Existing output files are never overwritten.
The response confirms `entryId`, `outputDirectoryPath`, `exportedCount`, and one result per object in `files[]`.

### list-tags

```bash
withmate-memory list-tags --file memory-list-tags.json
withmate-memory list-tags --project <absolute-repo-path> --with-counts --sample-limit 3 --limit 50
```

Request shape:

```json
{
  "schemaVersion": "withmate-memory-v1",
  "targets": [
    { "owner": "project", "project": { "type": "path", "path": "<absolute-repo-path>" }, "scope": "project" }
  ],
  "withCounts": true,
  "sampleLimit": 3,
  "limit": 50,
  "cursor": "<nextCursor-from-prior-response>"
}
```

`limit` bounds the total tag rows returned in one page. `sampleLimit` only bounds the entry samples attached to each tag when `withCounts` is true. Omit `cursor` on the first page, then repeat the same targets, count options, and limit with `nextCursor` until it is absent.
`targets` must contain exactly one explicit target. A cursor is server-issued and opaque; do not construct or reuse it with another target or option set.

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
  "supersedes": ["optional-replaced-entry-id"],
  "files": [
    {
      "path": "<absolute-readable-file-path>",
      "role": "evidence",
      "summary": "Why this file is retained.",
      "displayName": "optional-name.txt",
      "contentType": "text/plain"
    }
  ],
  "idempotencyKey": "optional-stable-key"
}
```

`supersedes` is an array of entry IDs. `files` is optional. Each `files[]` item requires an absolute readable file path and a non-empty summary. `role` is optional and accepts `evidence`, `source`, `snapshot`, `artifact`, `reference`, or `other`; `displayName` and `contentType` are optional metadata.

Do not attach secrets or files outside the user's authorized scope. Input paths are used for import and are not exposed in agent-facing Memory responses. File append is atomic with entry creation: quota, import, metadata, or idempotency failure must not be interpreted as a successful text-only append.

### forget

```bash
withmate-memory forget --file forget-request.json
withmate-memory forget --file forget-request.json --dry-run
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

Dry-run returns the matching entry title/preview/tags, target-mismatch-or-not-found warnings, `dryRun: true`, and `writeOccurred: false`. It does not change entries, protected objects, mutation events, or idempotency state. Review the preview before an approved bulk forget.

### move-entry

```bash
withmate-memory move-entry --file move-request.json
```

```json
{
  "schemaVersion": "withmate-memory-v1",
  "entryId": "<entry-id>",
  "from": { "owner": "project", "scope": "project", "project": { "type": "path", "path": "<absolute-repo-path>" } },
  "to": { "owner": "user", "scope": "global" },
  "reason": "Retarget this entry to user-global Memory.",
  "idempotencyKey": "stable-move-key"
}
```

Moves one active entry between explicit, different targets while preserving its ID, relations, and protected-file attachments. The retarget and its audit event are atomic. Retry an ambiguous result with the unchanged request and idempotency key.

For `append`, mutating `forget`, and `move-entry`, choose a stable idempotency key before the first attempt. If a timeout or response loss leaves the result ambiguous, retry the unchanged request with the same key. A changed request body requires a new key.

## Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | CLI usage or argument error |
| `2` | WithMate Memory API is not running or could not be discovered |
| `3` | Local request validation failed, or the runtime API returned a non-success JSON response |
| `4` | Transport failure |

## Notes

### Semantic Memory target shapes

Use one explicit target in general `search`, `get-entry`, and mutation request bodies. A Character preference that remains valid across projects uses:

```json
{
  "owner": "character",
  "character": { "type": "id", "id": "<character-id>" },
  "scope": "character"
}
```

A Character preference that belongs only to one project uses the combined target:

```json
{
  "owner": "character",
  "character": { "type": "id", "id": "<character-id>" },
  "project": { "type": "path", "path": "<absolute-repo-path>" },
  "scope": "project"
}
```

Use `{ "owner": "user", "scope": "global" }` only for provider- and project-independent semantic Memory. Use the project target shape shown in the request examples for repository-specific context that is not Character-specific. Do not silently drop either owner from a combined Character+Project candidate.

- Search results exclude forgotten and superseded entries.
- Project targets use `--project <absolute-repo-path>`, `--project-id <id>`, `{ "type": "path", "path": "<absolute-repo-path>" }`, or `{ "type": "id", "id": "<project-id>" }`. Explicit absolute paths are not limited to the session's attached projects.
- Relative project paths and `.` are rejected by the helper.
- `get-entry` requests require an explicit target.
- Character targets use explicit IDs, for example `{ "owner": "character", "character": { "type": "id", "id": "<character-id>" }, "scope": "character" }`. If the ID is unknown, run `withmate-memory characters` first.
- User-global Memory is visible across projects and providers. Store only user-level preferences, conventions, constraints, or other cross-project context there; do not store secrets, tokens, or project-specific private details.
- Append is idempotent when an idempotency key is supplied.
- MCP append, mutating forget, and move require an idempotency key. A successful retry reports `replayed: true`; a changed request with the same key returns an idempotency conflict.
- `append`, `get-file`, and `export-files` use a longer 300-second operation timeout by default. A mutation timeout is ambiguous; do not assume it proves that no write occurred.
- Forget hides entries from normal search and skill results.
- Memory failures should not fail unrelated coding work.
