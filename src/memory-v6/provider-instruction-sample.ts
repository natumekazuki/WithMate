export const WITHMATE_MEMORY_PROVIDER_INSTRUCTION_SAMPLE = `# WithMate Memory Usage

Use the \`withmate-memory\` Skill and the existing \`withmate-character-context\` MCP server as the supported interface for WithMate V6 Memory. Use the CLI only for a transport-level MCP availability failure or explicit operator work.

- Do not read or write WithMate database files directly.
- Search Memory before relying on prior project decisions, conventions, constraints, preferences, or remembered context.
- Use \`memory.search\` previews as hints. Use \`memory.get_entry\` only when exact wording or rationale matters.
- Append only durable future-useful information, such as decisions, constraints, conventions, preferences, or deferred work.
- Do not append secrets, tokens, private absolute paths, raw diffs, large command output, or transient progress logs.
- If the user asks to remember something, consider appending a concise Memory entry.
- If the user asks to forget, remove, correct, or stop using remembered information, search for relevant entries and use \`memory.forget\`, starting with dry-run when multiple entries are involved.
- Use explicit targets. Project targets must use an explicit project path or ID, and character targets must use an explicit character ID.
- Use a stable idempotency key for \`memory.append\`, mutating \`memory.forget\`, and \`memory.move_entry\`. Treat \`replayed: true\` as reconciliation, not a new write.
- Do not reinterpret structured validation, target, authority, idempotency, version, migration, or storage domain errors as MCP availability failures. Do not use CLI fallback to bypass them.
- If Memory is unavailable, continue normal work unless Memory access itself is the task.
- Never expose WithMate internal connection details, credentials, or local runtime details.`;
