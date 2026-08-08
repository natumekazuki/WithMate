import { startRuntimeHost } from "../dist/main/runtime-host/runtime-host.js";

const applicationDataRoot = process.argv[2];
if (applicationDataRoot === undefined || typeof process.send !== "function") {
  process.exitCode = 2;
} else {
  try {
    const host = await startRuntimeHost({ applicationDataRoot, timeoutMs: 10_000 });
    let stopPromise;
    const send = (message) => {
      if (process.connected) process.send(message);
    };
    const stop = () => {
      stopPromise ??= host
        .close({ timeoutMs: 10_000 })
        .then((result) => {
          send({ kind: "stopped", checkpoint: result.checkpoint });
          if (result.checkpoint !== "completed") process.exitCode = 1;
        })
        .catch(() => {
          process.exitCode = 1;
          send({ kind: "failure", stage: "shutdown" });
        })
        .finally(() => {
          if (process.connected) process.disconnect();
        });
      return stopPromise;
    };
    process.once("message", (message) => {
      if (message === "shutdown") void stop();
    });
    process.once("disconnect", () => {
      void stop();
    });
    send({ kind: "ready", generationId: host.generationId });
  } catch {
    process.exitCode = 1;
    if (process.connected) {
      process.send({ kind: "failure", stage: "startup" });
      process.disconnect();
    }
  }
}
