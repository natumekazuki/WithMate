---
name: withmate-memory
description: Perform lightweight Memory reflection before every user-facing final response, and search, append, inspect, or forget WithMate V6 Memory through the installed CLI when concrete reusable project context or cross-session Character continuity is relevant. Reflection does not require CLI work when no candidate exists. After a command, test, build, tool, or environment failure, use stored Memory only when a known pattern, constraint, or workaround could change the next action.
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

A non-zero exit code alone is not a Memory trigger. Skip recall search when current evidence fully explains the failure and determines a safe corrected action.

Do not run recall search on every turn. Skip recall for trivial local edits or conversations where the current files and user message fully determine the answer. The end-of-turn reflection below still applies to every user-facing turn.

## Principles

- Use the installed `withmate-memory` CLI instead of reading WithMate database files directly.
- Prefer `withmate-memory ...` commands. If the command is not on `PATH` and this managed skill includes `bin/withmate-memory.mjs`, use `node bin/withmate-memory.mjs ...` as a temporary bundled-helper fallback.
- Project, user-global, character, and character+project Memory are available from external Codex or shell sessions while WithMate is running; use explicit targets.
- Keep repository-owned current state, expected behavior, executable contracts, and decision rationale in repository sources of truth. Memory may point to those sources but must not replace them.
- Do not exclude context merely because it is repository-specific. Put reusable project background, preferences, investigation context, and workarounds in project Memory when they do not belong in a maintained repository artifact.
- Keep unfinished state, unexecuted validation, and the next action in a handoff rather than Memory.
- Search before relying on remembered project or Character decisions.
- Use `get-entry` only for search hits whose exact body matters.
- Append only decisions, constraints, conventions, preferences, context, or Character observations that could make later related work or conversation a little easier or more natural.
- Correct or forget entries only when the user asks to remove, correct, or stop using remembered information.
- Treat missing or unavailable Memory as non-blocking unless the user explicitly made Memory access the task.

## Recall Search

Use recall search only when stored context could affect the current task or make the current conversation naturally continue from a past one. Run it at the point the context is needed, with an explicit target. Do not turn end-of-turn reflection into routine recall.

Treat routine search and read as background recall. Search results support the current task; they do not replace current repository sources of truth or the current user message. Inspect exact entry bodies only when the wording or rationale matters.

## Character Memory

Treat Character Memory as an observation record for natural conversation continuity across sessions, not as a person profile or proof of facts.

Treat explicit relationship preferences, conversational distance, preferred names, interaction styles, topics the user wants to continue, light inside jokes, shared episodes, and concrete reactions as candidates when they could make a later related conversation more natural.

Do not require repeated mentions or an unusually memorable event. One explicit statement or one shared episode can be enough, and the user does not need to say `remember`, when the future conversational benefit is concrete and the content is within the current conversation's scope. Read-only requests and casual conversations can produce Character candidates under the same rule.

Do not save every conversation, generic turn summaries, temporary emotions, one-off acknowledgements, routine small talk, raw transcripts, or details with no concrete future value. Keep explicit user statements separate from agent inference. Write observations as attributed context such as "The user said they prefer..." rather than converting them into unqualified facts.

Do not infer romance, exclusivity, real-world relationships, attributes, or feelings from stored interactions. The current user message and current Character Definition take precedence over Memory. Never use Memory to overwrite or amend the Character Definition.

Search Character Memory when the user asks about the past, or when a prior relationship preference, ongoing topic, or conversation episode could naturally improve the current response. Do not perform Character recall on every turn. If no relevant hit exists, do not invent one. If old Memory conflicts with the current user message, follow the current message and use the correction or forget flow when the user asks to change future behavior.

## End-of-Turn Memory Reflection

Before every user-facing final response, review the current turn and recent conversation for concrete Memory candidates. Reflection is required on every user-facing turn; Memory search and append are conditional.

Apply these lenses independently:

- **Project lens:** Look for repository-specific background, decisions, constraints, conventions, working preferences, reliable investigation results, workarounds, environment-specific context, or pointers to repository sources of truth that would make later work start, decisions, investigation, or explanation a little faster. Use a project target for repository-specific context and user-global only for provider-independent preferences or constraints.
- **Character lens:** Look for relationship or conversational distance preferences, interaction style, preferred names, continuing topics, light inside jokes, shared episodes, or concrete reactions that would make a later related conversation a little more natural. Use character or character+project according to whether the context is project-specific.

Keep repository-owned current state, expected behavior, contracts, and decision rationale in repository sources of truth. A project Memory entry may point to that source and preserve only useful non-source-of-truth context.

If neither lens produces a concrete candidate, stop the reflection without searching or appending. Candidate absence is normal. Never append a generic summary of the turn.

For each concrete candidate:

1. Select its explicit project, user-global, character, or character+project target.
2. Run an append preflight search against that target only to check for an existing duplicate or a possible correction.
3. Inspect an exact hit only when needed to decide duplication, contradiction, correction, or supersession.
4. Skip append when an existing active entry already expresses the candidate. If an active entry conflicts with the candidate, follow the current user message for this turn and do not append, change, supersede, or forget Memory unless the user explicitly requests a durable correction.
5. Append only when the candidate passes Append Safety.

Keep Project and Character candidates in separate entries when their targets differ. Candidates for the same target and one searchable topic may be combined into one concise entry.

Recall search and append preflight search serve different purposes: recall informs the current task or response and remains optional; append preflight runs only after reflection finds a concrete candidate.

## Workflow

1. Read current repository sources of truth and the current user message before relying on Memory.
2. Use Recall Search with an explicit target only when stored context could affect the current task or conversation.
3. After a failure, diagnose it from current evidence first. Search Memory before retrying when the cause or safe next action remains uncertain, the same failure signature recurs, or the next attempt changes scope, subsystem, strategy, permissions, or environment assumptions. Skip search for a deterministic correction supported by current evidence.
4. Before the user-facing final response, perform End-of-Turn Memory Reflection.
5. For each concrete candidate, run append preflight against its explicit target and append only if it is neither already represented nor in conflict with active Memory and passes Append Safety. Keep title and preview short, body precise, and tags reusable.
6. If a failure reveals a reusable pattern or reliable workaround that is likely to matter in future sessions, treat it as a Project lens candidate with the failure signature, likely cause, and next-time guidance.
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

- Would this make a later related task, decision, explanation, or conversation a little easier or more natural?
- Is it a decision, constraint, convention, preference, reusable context, or explicit Character observation rather than transient progress?
- If the user did not say `remember`, is the content nevertheless explicit, in scope, and concretely useful for future project work or conversation continuity?
- Does the entry attribute what the user actually said and avoid converting an agent inference into a fact?
- Does it avoid secrets, tokens, private paths, raw logs, large diffs, and speculative claims?
- Is the target explicit and correct?
- Does it avoid creating a second active entry that conflicts with existing Memory?
- Would a future agent understand the entry from title, preview, body, and tags alone?

Do not append all conversation by default. Require explicit user intent before saving an inference, saving content outside the current task or conversation scope, changing an existing Memory entry, or appending a conflicting replacement.

When correcting a previous entry, inspect the exact entry, then append a replacement with `supersedes` instead of creating ambiguous duplicates when possible. Use `forget` when the user explicitly requests removal rather than replacement. Keep the same semantic target unless the user is also correcting the scope.

## CLI

Run the installed command with an explicit target:

```bash
withmate-memory --help
withmate-memory status
withmate-memory characters
withmate-memory file-usage --largest --limit 20
withmate-memory list-targets
withmate-memory list-entries --project <absolute-repo-path> --limit 100
withmate-memory audit --all-targets --format markdown
withmate-memory schema
withmate-memory validate --command append --stdin
withmate-memory search --project <absolute-repo-path> --query "delivery cleanup" --tag delivery-cleanup
withmate-memory search --project <absolute-repo-path> --tags topic:delivery-cleanup,topic:relaygraph
withmate-memory search --file memory-search.json
withmate-memory get-entry --file memory-get-entry.json
withmate-memory get-file --project <absolute-repo-path> --object-id <object-id> --output <absolute-output-path>
withmate-memory export-files --project <absolute-repo-path> --entry-id <entry-id> --output-dir <absolute-output-directory>
withmate-memory list-tags --project <absolute-repo-path> --with-counts
withmate-memory append --file memory-entry.json
withmate-memory forget --file forget-request.json
withmate-memory forget --file forget-request.json --dry-run
withmate-memory move-entry --file move-request.json
```

Commands write one JSON object to stdout, except help text and `audit --format jsonl|markdown`.

Use the maintenance commands only for an explicit Memory review or cleanup task. Start with `list-targets`, page through `list-entries` without `--include-body`, use `audit` or counted tags to classify candidates, and run `forget --dry-run` before an approved bulk forget. Use `move-entry` instead of manual append+forget when the entry is under the wrong target. Do not inspect database files directly.

For commands that require a request body, prefer `--stdin` or `--file <path>`. Inline `--json` is supported, but it is shell-sensitive. On Windows PowerShell or `.cmd` wrappers, double quotes inside JSON can be consumed before the CLI receives the argument. If `--json` fails with invalid JSON or a CLI usage error, pipe the request through `--stdin`, or write it to a temporary JSON file and retry with `--file`.

If `withmate-memory` is not found and `bin/withmate-memory.mjs` exists in this skill directory, replace `withmate-memory` with `node bin/withmate-memory.mjs` in the commands above.

Read [reference/cli.md](reference/cli.md) before attaching or exporting files, or when complete request and failure details matter.

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

`list-targets` inventories discoverable Memory targets and returns entry/tag counts and last-updated metadata. `--include-empty` adds known project, Character, and user-global targets with no active entries. Filters include `--owner`, `--scope`, `--project`, `--project-id`, and `--character-id`.

`list-entries` lists a target without a search query. It is paginated and omits `body` unless `includeBody: true` or `--include-body` is explicit. Continue with `nextCursor` until absent for an exhaustive review.

`audit` accepts exactly one of `allTargets: true` or explicit `targets[]`. JSON is the default; JSONL and Markdown are CLI projections. JSONL emits an `audit_page` metadata record before its `target_audit` records so pagination state is not lost. Audit candidates are heuristics for review, not authorization to forget or retarget entries.

`search`:

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

Search supports natural-language terms across title, preview, body, and tags. Hyphenated and spaced tag words such as `delivery-cleanup` and `delivery cleanup` are treated as related candidates. Shorthand `--tag <tag>` defaults to `topic:<tag>`, and `--tags` accepts comma-separated `<type>:<tag>` values.

Search results may include `match` on each hit with matched fields and a short snippet. `match.fields` can report body matches, but snippets are limited to tags, title, and preview; use `get-entry` when the exact body matters. When no entries match, the response may include `relatedTags`.

Omit `cursor` on the first request. If a response has `nextCursor` and the needed entry or append-preflight duplicate has not been resolved, repeat the same search options with that cursor before concluding that no relevant entry exists.

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
  ],
  "withCounts": true,
  "sampleLimit": 3
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
  "supersedes": ["optional-replaced-entry-id"],
  "files": [
    {
      "path": "<absolute-readable-file-path>",
      "role": "evidence",
      "summary": "Why this file is retained."
    }
  ],
  "idempotencyKey": "optional-stable-key"
}
```

`supersedes` is an array of entry IDs. Use it only for an explicitly authorized correction. `files` is optional; each file needs an absolute path and non-empty summary. Valid roles are `evidence`, `source`, `snapshot`, `artifact`, `reference`, and `other`; `displayName` and `contentType` are optional.

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

Add `"dryRun": true` or pass `--dry-run` to return the entries that would be forgotten, not-found/target-mismatch warnings, and `writeOccurred: false`. A dry-run does not create mutation or idempotency records.

`move-entry`:

```json
{
  "schemaVersion": "withmate-memory-v1",
  "entryId": "<entry-id>",
  "from": { "owner": "project", "project": { "type": "path", "path": "<absolute-repo-path>" }, "scope": "project" },
  "to": { "owner": "user", "scope": "global" },
  "idempotencyKey": "stable-move-key"
}
```

Move requires explicit, different source and destination targets. It preserves the entry ID, relations, and protected-file attachments, records the retarget operation, and is atomic. Retry an ambiguous result with the unchanged request and idempotency key.

Choose a stable `idempotencyKey` before the first `append`, mutating `forget`, or `move-entry` attempt. After a timeout or response loss, retry the unchanged request with the same key. Use a new key when the request body changes.

### Protected Files

`file-usage` is read-only and requires no target. Use `--largest --limit <n>` to include the largest active entry candidates. It returns aggregate metadata, not file paths or decrypted content.

`get-file` exports one object to an explicit absolute output path:

```json
{
  "schemaVersion": "withmate-memory-v1",
  "target": { "owner": "project", "project": { "type": "path", "path": "<absolute-repo-path>" }, "scope": "project" },
  "objectId": "<object-id>",
  "outputPath": "<absolute-output-path>"
}
```

`export-files` exports every file attached to one entry into an explicit absolute directory:

```json
{
  "schemaVersion": "withmate-memory-v1",
  "target": { "owner": "project", "project": { "type": "path", "path": "<absolute-repo-path>" }, "scope": "project" },
  "entryId": "<entry-id>",
  "outputDirectoryPath": "<absolute-output-directory>"
}
```

Do not attach secrets or files outside the user's authorized scope. File append is atomic with entry creation: quota, import, or persistence failure must not be treated as a text-only success. Export verifies the explicit target and never overwrites an existing output file. `append`, `get-file`, and `export-files` may run for up to 300 seconds by default; do not assume a timeout means that a mutation had no effect.

### Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | CLI usage or argument error |
| `2` | WithMate Memory API is not running or could not be discovered |
| `3` | Local request validation failed, or the runtime API returned a non-success JSON response |
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
