import { CLI_EXIT_CODES } from "./contract.js";
import type { CliInvocationResult } from "./invocation.js";

export type CliTextOutputStream = Readonly<{
  write(text: string, callback: (error?: Error | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
}>;

export async function writeCliInvocationResult(
  result: CliInvocationResult,
  streams: Readonly<{ stdout: CliTextOutputStream; stderr: CliTextOutputStream }>,
): Promise<number> {
  try {
    await writeText(streams.stdout, result.stdout);
    if (result.stderr.length > 0) await writeText(streams.stderr, result.stderr);
    return result.exitCode;
  } catch {
    try {
      await writeText(streams.stderr, "withmate: output write failed\n");
    } catch {
      // There is no remaining reliable output channel.
    }
    return CLI_EXIT_CODES.runtimeFailure;
  }
}

function writeText(stream: CliTextOutputStream, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let observedError: unknown;
    let settlementScheduled = false;

    const settleAfterStreamEvents = (): void => {
      if (settlementScheduled) return;
      settlementScheduled = true;
      setImmediate(() => {
        stream.removeListener("error", onError);
        if (observedError === undefined || observedError === null) resolve();
        else reject(observedError);
      });
    };
    const onError = (error: Error): void => {
      observedError ??= error;
      settleAfterStreamEvents();
    };

    stream.once("error", onError);
    try {
      stream.write(text, (error) => {
        observedError ??= error;
        settleAfterStreamEvents();
      });
    } catch (error) {
      observedError = error;
      settleAfterStreamEvents();
    }
  });
}
