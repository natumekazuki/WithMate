# WithMate Character Context MCP and CLI Reference

This reference describes the Character context interface bundled by WithMate. The installed managed Skill's `.withmate-managed-skill.json` contains `bundleVersion`, which identifies the packaged WithMate release that supplied the Skill. Development runs from a source checkout do not install or update the global managed Skill.

## Contract versions

| Contract | Value |
| --- | --- |
| MCP server name | `withmate-character-context` |
| MCP server version | `1.0.0` |
| Verified MCP protocol compatibility | `2025-06-18` |
| Character context schema | `withmate-character-context-v1` |
| Affect candidate schema | `withmate-affect-v1` |

The server uses MCP protocol negotiation. `2025-06-18` is the compatibility version directly verified for this interface; do not infer that the server rejects every other SDK-supported negotiated version.

## Starting the MCP server

For an installed WithMate CLI, configure the MCP client to launch:

```text
withmate-memory mcp-server
```

For a development checkout:

```powershell
npm run build:memory-cli
node resources/skills/withmate-memory/bin/withmate-memory.mjs mcp-server
```

The server uses stdio. It connects to the running WithMate loopback application endpoint through MCP-specific discovery and credentials. It does not start the CLI as a subprocess and does not open SQLite directly.

## Public MCP tools

| Tool | Purpose | Mutation | Authority projection |
| --- | --- | --- | --- |
| `character_context.get` | Read current scoped context | none | read-only MCP route |
| `character_affect.appraise` | Submit Character-owned affect candidates | bounded write | conversation authority |
| `character_memory.search` | Cue-driven Character Memory search | none | read-only MCP route |
| `character_memory.append_episode` | Append one shared-event episode | bounded write | conversation authority |
| `character_memory.correct` | Supersede an episode | destructive write | conversation authority, explicit target, reason, and idempotency key |
| `character_memory.forget` | Forget an episode | destructive write | conversation authority, explicit target, reason, and idempotency key |

The same server publishes general semantic Memory in the `memory.*` namespace:

| Tool | Purpose | Mutation | Authority projection |
| --- | --- | --- | --- |
| `memory.search` | Search explicit general Memory targets | none | read-only MCP route |
| `memory.get_entry` | Read one active entry with its body | none | read-only MCP route |
| `memory.list_targets` | List bounded target inventory | none | read-only MCP route |
| `memory.list_entries` | List one target without bodies by default | none | read-only MCP route |
| `memory.list_tags` | List bounded target tag metadata | none | read-only MCP route |
| `memory.append` | Append semantic Memory, optionally with protected files | bounded write | explicit target and required idempotency key |
| `memory.forget` | Preview or forget entries | destructive write | explicit invocation, reason, target, and idempotency key |
| `memory.move_entry` | Retarget one active entry | destructive write | explicit invocation, reason, from/to targets, and idempotency key |
| `memory.get_file` | Export one protected object to a new file | external file write | target validation and non-overwrite boundary |
| `memory.export_files` | Export one entry's protected objects | external file write | target validation and non-overwrite boundary |
| `memory.file_usage` | Read protected-object usage metadata; bound agents only receive largest-entry candidates from non-Character targets and their own Character | optional | read-only MCP route |

MCP write inputs do not accept a caller-supplied `authority` field. Tool annotations are client hints; the WithMate application service performs final route and authority validation.

Use MCP `tools/list` as the complete MCP input/output schema. General Memory validation and contracts are in `src/memory-v6/memory-validation.ts` and `src/memory-v6/memory-contract.ts`. Character validation and contracts are in `src/character-context/character-context-validation.ts`, `src/character-context/character-context-contract.ts`, and `src/character-affect/affect-contract.ts`.

General Memory targets are always explicit project, user-global, character, or character+project selectors. Project path and project ID forms resolve through the same application service project resolver. General Memory MCP write inputs do not accept caller-supplied authority. Append, mutating forget, and move require an idempotency key; forget also requires a reason and supports dry-run. A successful retry reports `replayed: true`. Reusing the same key with a changed request is a structured domain conflict.

### Required input distinctions

- `character_context.get` requires `characterId`; the actor `sessionId` is resolved from the WithMate runtime binding. `query` is optional and `memoryLimit` defaults to 3 within 0..10.
- `character_affect.appraise` requires 1..10 candidates. Candidate `characterId` and `userId: local-user` must match the request owner; candidate `sessionId` is supplied by the runtime binding.
- `character_context.get` and `character_affect.appraise` reject requests without a valid runtime binding before application dispatch. A CLI argument or request-body `sessionId` does not establish actor authority.
- `character_memory.append_episode` retains `sessionId` in its public input because the application request validates the episode's Session scope. When a runtime binding is present, the server replaces it with the actor Session before validation; the caller-supplied value never establishes actor authority.
- An affect candidate requires `schemaVersion`, owner IDs, `layer`, explicit `targetType` and `targetId`, one of `joy`, `relief`, `interest`, `anticipation`, `affinity`, `gratitude`, `concern`, `frustration`, `disappointment`, `regret`, `determination`, or `other` as `family`, free-label value, intensity, reason, evidence, canonical UTC `occurredAt`, and `idempotencyKey`.
- When an episode belongs to that affect event, put its `title`, `preview`, `body`, required `salience` from 0 to 1, and optional `motif` in the candidate's `memoryEpisode`. Linked `memoryEpisode` does not use `observedFact` or `characterObservation`. Do not submit the same event separately through `character_memory.append_episode`.
- Relationship affect may target only `user` or `relationship`. Targets `task`, `bug`, `artifact`, and `self` belong to the session layer.
- `character_memory.search` requires a non-empty query and an explicit Character or Character+Project scope.
- A standalone episode submitted to `character_memory.append_episode` requires `title`, `preview`, `body`, and at least one of `observedFact` or `characterObservation`; `motif` is optional.
- Append, correction, forget, affect correction, and affect reset require an idempotency key. Correction and reset also use the current expected version where defined by the schema.

### Success output shapes

- `character_context.get` returns `characterId`, `sessionId`, baseline definition digest/timestamp, affect `mode`, read-time `evaluatedAt`, effective components with `family` (`null` only for unclassified legacy identity), affect `version`/`updatedAt`, bounded Memory items/related tags/update time, and resolved `userId`/Character/Session scope. It does not return the Character Definition, raw affect events, secrets, or the complete Memory search result set.
- `character_affect.appraise` returns `saved[]`, `rejected[]`, the resulting affect `version`, and `updatedAt`. A saved item identifies `candidateIndex`, `eventId`, optional linked `memoryEntryId`, and `replayed`; a rejected item identifies its candidate index, rejection code, and message.
- `character_memory.search` returns the resolved Character scope, bounded active `items[]`, optional `relatedTags[]`, and `sourceVersion`.
- Character Memory mutations return `operation`, current `entry` when available, optional predecessor/creation/replay fields, `readBack`, and `sourceVersion`.

The success shape is not permission to infer omitted values. Use the exact structured response and schema advertised by `tools/list`.

For a normal WithMate Session turn, lifecycle-injected context identifies a lifecycle-owned turn: the in-process lifecycle owns mandatory post-turn appraisal and its linked `memoryEpisode`. External clients must not submit a second MCP appraisal for that turn. MCP appraisal is for clients without that lifecycle owner or an explicitly requested manual operation. Standalone `character_memory.append_episode` remains available only when the episode is not linked to an affect event.

## Character CLI commands

The CLI is an operator/recovery adapter to the same application service:

- `context-get`
- `affect-appraise`
- `affect-inspect`
- `affect-correct`
- `affect-reset`
- `character-memory-search`
- `character-memory-append-episode`
- `character-memory-correct`
- `character-memory-forget`
- `character-metrics`
- `mcp-server`

These Character-specific commands do not replace general semantic Memory. Use `memory.search`, `memory.get_entry`, and `memory.append` with an explicit `character` or `character+project` target for semantic Character preferences, constraints, facts, conventions, or decisions. Use the equivalent general CLI only after a transport-level MCP availability failure or for explicit operator work.

Prefer `--stdin` or `--file` for request bodies. CLI Character operations require the CLI-specific authenticated adapter credential. The server derives operator authority only after that credential is verified; a request body's `authority` string or a normal runtime secret cannot elevate authority.

Example:

```powershell
$request = @{
  schemaVersion = "withmate-character-context-v1"
  characterId = "<character-id>"
  sessionId = "<session-id>"
  authority = @{ kind = "operator"; reason = "incident inspection" }
} | ConvertTo-Json -Depth 10

$request | withmate-memory affect-inspect --stdin
```

## MCP-to-CLI fallback

Fallback is permitted only when MCP is not configured, cannot start, or has a transport-level availability failure, or when an operator explicitly performs inspection, migration, or recovery.

Mark an actual MCP fallback:

```powershell
$request | withmate-memory context-get --stdin --fallback-from mcp
```

`--fallback-from mcp` is recorded as `mcp->cli` metrics. Both adapters resolve one paired runtime generation and use the same application service and persistence. If the same runtime cannot be confirmed, do not perform a fallback write.

Do not fallback for `invalid_input`, `unknown_character`, `unknown_scope`, `authority_denied`, `version_conflict`, `idempotent_replay`, `migration_required`, general Memory validation/target/authority/idempotency errors, or any structured error from a normally responding MCP server. These are domain results, not MCP availability failures.

## Idempotency and retry

Choose an idempotency key before the first write.

- Retry the same event after timeout or response loss with the unchanged request and unchanged key.
- A changed request uses a new key.
- A separate event at a later time uses a new key even when it shares a motif with an older episode.
- Reusing one key with a different request fingerprint is rejected.
- `replayed: true` identifies an idempotent replay; it is not a newly created event.

Semantic Memory and Character episodes have different duplicate rules. Equivalent active semantic preferences or constraints should not be appended repeatedly. A later distinct Character episode may be appended separately; use `motif` to relate recurring events without replacing the older episode.

## Success, errors, and effect certainty

Success responses and structured errors both use `withmate-character-context-v1`. Public errors use these codes:

- `invalid_input`
- `unknown_character`
- `unknown_scope`
- `authority_denied`
- `version_conflict`
- `idempotent_replay`
- `storage_unavailable`
- `migration_required`
- `partial_failure`
- `internal_error`

Errors include `retryable` and `conversationMayContinue`, and may include `field`, `effect`, and `details`.

Transport or domain operation success is distinct from durable effect. A structured error can still identify committed or partially committed state; honor its `effect` and `details` without treating the overall operation as successful.

| Effect | Interpretation |
| --- | --- |
| `none` | No mutation is known to have occurred. |
| `committed` | The response identifies committed state that can be read back. |
| `partial` | Only the saved range identified in `details` is committed. |
| `unknown` | The write may or may not have committed; do not claim either result. |

Appraisal success separates `saved[]` and `rejected[]`; each saved item may report `replayed`. Candidate rejection is not an availability failure and is not a save. Character Memory mutation responses report `entry`, `created`, `replayed`, `readBack`, and `sourceVersion` as applicable. Do not synthesize omitted values.

Read-only response loss maps to `effect: none`. A write dispatched before timeout or response loss maps to `effect: unknown` unless the application service returned more certain state. Reconcile an ambiguous write only with the same request and idempotency key.

The CLI exit code is transport/adapter status, not a replacement for the JSON domain result:

| Exit code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | CLI usage or argument error |
| `2` | WithMate runtime is not running or discovery failed |
| `3` | Local validation failed or runtime returned a non-success domain result |
| `4` | Transport failure |

An exit code 3 does not make a domain rejection an MCP availability failure.

## Correction, forget, reset, and read-back

An agent may correct or forget Character Memory autonomously as the user's delegate. It must use its own Character scope, confirm the target entry and current version, provide a concrete reason and idempotency key, and read back the result. Affect correction, relationship/session affect reset, and relationship-boundary changes require an explicit user instruction or authenticated operator authority.

After mutation:

- read the returned `readBack` for Character Memory;
- use `character_memory.search`, `context-get`, or `affect-inspect` as the operation requires;
- verify the returned Character scope and current source/affect version;
- report `partial` or `unknown` without filling the gap by inference.

Do not use CLI authority to retry a rejected MCP request unless the user/operator independently authorized the CLI operation and the failure was not being bypassed.

## Metrics and privacy

Run:

```bash
withmate-memory character-metrics
```

Metrics distinguish transport and operation calls, successes, rejections, failures, idempotent replays, version conflicts, rejection codes, total latency, and `mcp->cli` fallback counts. Affect metrics also expose family-bucketed candidates/saves/rejections, `otherRate`, invalid-family/schema/version rejections, persisted `eventsByFamily`, legacy event/projection counts, decay exclusions, and projection cache hit/miss/stale counts. Lifecycle and model-driven MCP operations use distinct operation prefixes.

Metrics and logs must not contain conversation text, Memory bodies, affect evidence text, inferred user emotion, secrets, or raw transcripts. Use an authorized inspect/search operation when content is genuinely required for recovery.

## Shadow mode

Character context reports affect `mode` independently from the mutation result. In shadow mode, callers observe context and candidates and limit response influence, especially for negative or relationship affect. A committed write is still committed; shadow mode is not a dry-run flag. Rejected candidates remain rejected and must not be stored independently.

## Runtime parity check

To confirm adapter parity, read the same Character/session context through MCP `character_context.get` and CLI `context-get` from the same WithMate-launched provider execution. Both adapters self-resolve the actor Session from the opaque runtime binding; an external CLI without that binding receives an authority error. The Character scope and affect version must match. A CLI fallback must also be visible in `character-metrics` as `mcp->cli`.
