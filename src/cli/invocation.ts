import type { ApplicationSessionOperations } from "../main/index.js";
import { serializeCliStructuredOutput } from "./application-response.js";
import { CLI_EXIT_CODES, type CliExitCode, type CliParseResult, type CliValidatedCommand } from "./contract.js";
import { helpText } from "./help.js";
import { parseCliArgv } from "./parser.js";
import { dispatchCliSessionCommand } from "./session-dispatch.js";

export type CliInvocationResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: CliExitCode;
}>;

export type CliInvocationDependencies<TAuthorizationContext> = Readonly<{
  version: string;
  operations: ApplicationSessionOperations<TAuthorizationContext>;
  authorization: TAuthorizationContext;
  signal?: AbortSignal;
}>;

export async function runCliWithSessionOperations<TAuthorizationContext>(
  argv: readonly string[],
  dependencies: CliInvocationDependencies<TAuthorizationContext>,
): Promise<CliInvocationResult> {
  const parsed = parseCliArgv(argv);
  if (parsed.kind === "command") return runValidatedCliCommand(parsed.command, dependencies);
  const nonCommandResult = renderCliParseResult(parsed, dependencies.version);
  if (nonCommandResult === undefined) throw new TypeError("CLI parse result could not be rendered.");
  return nonCommandResult;
}

export function renderCliParseResult(parsed: CliParseResult, version: string): CliInvocationResult | undefined {
  switch (parsed.kind) {
    case "help":
      return { stdout: helpText(parsed.topic), stderr: "", exitCode: CLI_EXIT_CODES.success };
    case "version":
      return { stdout: `${version}\n`, stderr: "", exitCode: CLI_EXIT_CODES.success };
    case "usage_failure":
      return { stdout: serializeCliStructuredOutput(parsed.output), stderr: "", exitCode: parsed.exitCode };
    case "command":
      return undefined;
  }
}

export async function runValidatedCliCommand<TAuthorizationContext>(
  command: CliValidatedCommand,
  dependencies: Omit<CliInvocationDependencies<TAuthorizationContext>, "version">,
): Promise<CliInvocationResult> {
  const result = await dispatchCliSessionCommand(command, dependencies);
  return {
    stdout: serializeCliStructuredOutput(result.output),
    stderr: "",
    exitCode: result.exitCode,
  };
}
