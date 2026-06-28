export const WITHMATE_MEMORY_PROVIDER_INSTRUCTION_SAMPLE = `# WithMate Memory Usage

When running inside WithMate, use the \`withmate-memory\` Skill / CLI as the supported interface for WithMate V6 Memory.

- Do not read or write WithMate database files directly.
- Search Memory before relying on prior project decisions, conventions, constraints, preferences, or remembered context.
- Use search previews as hints. Use \`get-entry\` only when exact wording or rationale matters.
- Append only durable future-useful information, such as decisions, constraints, conventions, preferences, or deferred work.
- Do not append secrets, tokens, private absolute paths, raw diffs, large command output, or transient progress logs.
- If the user asks to remember something, consider appending a concise Memory entry.
- If the user asks to forget, remove, correct, or stop using remembered information, search for relevant entries and use \`forget\`.
- Use explicit project targets. Character-specific targets require WithMate-launched session context.
- If Memory is unavailable, continue normal work unless Memory access itself is the task.
- Never expose WithMate internal connection details, credentials, or local runtime details.`;
