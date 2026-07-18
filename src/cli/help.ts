import type { CliHelpTopic, CliSessionOperation } from "./contract.js";

const ROOT_HELP = `Usage: withmate <namespace> <operation> [options]

Namespaces:
  session    Create, inspect, and change Session lifecycle state

Global options:
  -h, --help       Show help without starting the application runtime
  -V, --version    Show the executable version without starting the application runtime

Run 'withmate session --help' for Session operations.
Operation results and failures are written as one withmate-cli-v1 JSON object to stdout.
`;

const SESSION_HELP = `Usage: withmate session <operation> [options]

Operations:
  create               Create a Session for an absolute Workspace path
  rename               Update a Session title
  list                 List and filter Sessions
  repositories         List local Repositories registered by Sessions
  read                 Read a Session by Session ID
  directories-chunk    Read a bounded chunk of additional-directory configuration
  archive              Archive a Session
  unarchive            Unarchive a Session
  close                Close an active or archived Session

Run 'withmate session <operation> --help' for operation options.
`;

const OPERATION_HELP: Readonly<Record<CliSessionOperation, string>> = {
  create: `Usage: withmate session create [options]

Required options:
  --title <session-title>
  --workspace <absolute-path>
  --idempotency-key <lowercase-uuid>
  --provider <provider-id>
  --default-character <character-id>
  --max-concurrent-child-runs <0..1024>

Optional options:
  --additional-directory <absolute-path>    Repeatable, maximum 1024
  --timeout-ms <1..2147483647>
  -h, --help
`,
  rename: `Usage: withmate session rename [options]

Required options:
  --session-id <session-id>
  --title <session-title>
  --idempotency-key <lowercase-uuid>

Optional options:
  --timeout-ms <1..2147483647>
  -h, --help
`,
  list: `Usage: withmate session list [options]

Optional options:
  --workspace <absolute-path>
  --lifecycle-status <active|archived|closed>
  --repository-key <local-repository-key>    Repeatable, maximum 100
  --query <title-or-repository-name>
  --cursor <cursor>
  --limit <1..100>    Default: 25
  --timeout-ms <1..2147483647>
  -h, --help
`,
  repositories: `Usage: withmate session repositories [options]

Optional options:
  --cursor <cursor>
  --limit <1..100>    Default: 25
  --timeout-ms <1..2147483647>
  -h, --help
`,
  read: `Usage: withmate session read [options]

Required options:
  --session-id <session-id>

Optional options:
  --timeout-ms <1..2147483647>
  -h, --help
`,
  "directories-chunk": `Usage: withmate session directories-chunk [options]

Required options:
  --session-id <session-id>
  --offset <non-negative-integer>
  --max-bytes <1..262144>

Optional options:
  --timeout-ms <1..2147483647>
  -h, --help
`,
  archive: writeHelp("archive"),
  unarchive: writeHelp("unarchive"),
  close: `Usage: withmate session close [options]

Required options:
  --session-id <session-id>
  --idempotency-key <lowercase-uuid>
  --expected-lifecycle-status <active|archived>

Optional options:
  --timeout-ms <1..2147483647>
  -h, --help
`,
};

export function helpText(topic: CliHelpTopic): string {
  switch (topic.kind) {
    case "root":
      return ROOT_HELP;
    case "session":
      return SESSION_HELP;
    case "operation":
      return OPERATION_HELP[topic.command.operation];
  }
}

function writeHelp(operation: "archive" | "unarchive"): string {
  return `Usage: withmate session ${operation} [options]

Required options:
  --session-id <session-id>
  --idempotency-key <lowercase-uuid>

Optional options:
  --timeout-ms <1..2147483647>
  -h, --help
`;
}
