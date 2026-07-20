import type { CliHelpTopic, CliRunOperation, CliSessionOperation } from "./contract.js";

const ROOT_HELP = `Usage: withmate <namespace> <operation> [options]

Namespaces:
  session    Create, inspect, and change Session lifecycle state
  run        Observe persisted Run state and events

Global options:
  -h, --help       Show help without starting the application runtime
  -V, --version    Show the executable version without starting the application runtime

Run 'withmate session --help' for Session operations.
Run 'withmate run --help' for Run observation operations.
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
  messages             Read a bounded Message timeline page
  runs                 Read a bounded persisted Run history page
  message-content-chunk
                       Read a bounded raw Message content chunk
  archive              Archive a Session
  unarchive            Unarchive a Session
  close                Close an active or archived Session
  delete               Irreversibly delete local Session data only

Run 'withmate session <operation> --help' for operation options.
`;

const RUN_HELP = `Usage: withmate run <operation> [options]

Operations:
  status            Read the persisted Run status
  events            Read a bounded RunEvent page
  follow            Wait for events, terminal closure, or a bounded deadline
  output-counts     Count persisted Run outputs by category
  outputs           Read a bounded Run output page
  output-preview    Preview bounded text or JSON output
  output-chunk      Read a bounded text or JSON output chunk
  output-export     Export a stored output without overwriting a destination

Run mutation is not available from this CLI.
Run 'withmate run <operation> --help' for operation options.
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
  messages: `Usage: withmate session messages [options]

Required options:
  --session-id <session-id>

Optional options:
  --cursor <opaque-cursor>
  --limit <1..100>    Default: 50
  --timeout-ms <1..2147483647>
  -h, --help
`,
  runs: `Usage: withmate session runs [options]

Required options:
  --session-id <session-id>

Optional options:
  --cursor <opaque-cursor>
  --limit <1..100>    Default: 50
  --timeout-ms <1..2147483647>
  -h, --help
`,
  "message-content-chunk": `Usage: withmate session message-content-chunk [options]

Required options:
  --session-id <session-id>
  --message-id <message-id>
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
  delete: `Usage: withmate session delete [options]

Irreversibly deletes local WithMate Session data and Session Files only.
The Provider thread or Session is not deleted.

Required options:
  --session-id <session-id>
  --idempotency-key <lowercase-uuid>
  --confirm-local-only

Optional options:
  --timeout-ms <1..2147483647>
  -h, --help
`,
};

const RUN_OPERATION_HELP: Readonly<Record<CliRunOperation, string>> = {
  status: `Usage: withmate run status [options]

Required options:
  --session-id <session-id>
  --run-id <run-id>

Optional options:
  --timeout-ms <1..2147483647>
  -h, --help
`,
  events: `Usage: withmate run events [options]

Required options:
  --session-id <session-id>
  --run-id <run-id>

Optional options:
  --cursor <opaque-cursor>
  --limit <1..200>    Default: 100
  --timeout-ms <1..2147483647>
  -h, --help
`,
  follow: `Usage: withmate run follow [options]

Required options:
  --session-id <session-id>
  --run-id <run-id>

Optional options:
  --cursor <opaque-cursor>
  --limit <1..200>       Default: 100
  --wait-ms <0..30000>   Default: 10000
  --poll-ms <25..5000>   Default: 250
  --timeout-ms <1..2147483647>
  -h, --help
`,
  "output-counts": runOutputScopeHelp("output-counts"),
  outputs: `Usage: withmate run outputs [options]

Required options:
  --session-id <session-id>
  --run-id <run-id>

Optional options:
  --category <assistant_detail|operation|interaction|telemetry|diagnostic|provider_metadata>
  --cursor <opaque-cursor>
  --limit <1..200>    Default: 100
  --timeout-ms <1..2147483647>
  -h, --help
`,
  "output-preview": `Usage: withmate run output-preview [options]

Required options:
  --session-id <session-id>
  --run-id <run-id>
  --output-item-id <output-item-id>

Optional options:
  --max-bytes <1..65536>    Default: 65536
  --timeout-ms <1..2147483647>
  -h, --help
`,
  "output-chunk": `Usage: withmate run output-chunk [options]

Required options:
  --session-id <session-id>
  --run-id <run-id>
  --output-item-id <output-item-id>
  --offset <non-negative-integer>

Optional options:
  --max-bytes <1..262144>    Default: 65536
  --timeout-ms <1..2147483647>
  -h, --help
`,
  "output-export": `Usage: withmate run output-export [options]

Required options:
  --session-id <session-id>
  --run-id <run-id>
  --output-item-id <output-item-id>
  --destination <absolute-path>

The destination is never overwritten. Inspect it before retrying an unknown publication outcome.

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
    case "run":
      return RUN_HELP;
    case "operation":
      return topic.command.namespace === "session"
        ? OPERATION_HELP[topic.command.operation]
        : RUN_OPERATION_HELP[topic.command.operation];
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

function runOutputScopeHelp(operation: "output-counts"): string {
  return `Usage: withmate run ${operation} [options]

Required options:
  --session-id <session-id>
  --run-id <run-id>

Optional options:
  --timeout-ms <1..2147483647>
  -h, --help
`;
}
