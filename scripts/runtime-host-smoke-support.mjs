import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const childEntry = fileURLToPath(new URL("./runtime-host-smoke-child.mjs", import.meta.url));

export async function startControlledRuntimeHost(applicationDataRoot, timeoutMs = 10_000, options = {}) {
  const child = fork(childEntry, [applicationDataRoot], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  try {
    const ready = await waitForChildMessage(child, timeoutMs);
    if (ready.kind !== "ready" || typeof ready.generationId !== "string") {
      throw new Error(`Controlled runtime host startup failed at ${String(ready.stage)}.`);
    }
    let stopPromise;
    const sendMessage = options.sendMessage ?? sendChildMessage;
    return {
      generationId: ready.generationId,
      isRunning: () => child.exitCode === null && child.signalCode === null,
      stop() {
        stopPromise ??= stopControlledRuntimeHost(child, timeoutMs, sendMessage);
        return stopPromise;
      },
      terminate() {
        return terminateChild(child, timeoutMs);
      },
    };
  } catch (error) {
    try {
      await terminateChild(child, timeoutMs);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Controlled runtime host startup cleanup failed.");
    }
    throw error;
  }
}

export async function cleanupControlledRuntimeHost(runtimeHost, cleanupArtifacts) {
  const failures = [];
  if (runtimeHost?.isRunning()) {
    try {
      await runtimeHost.stop();
    } catch (error) {
      failures.push(error);
    }
  }
  if (runtimeHost?.isRunning()) {
    try {
      await runtimeHost.terminate();
    } catch (error) {
      failures.push(error);
    }
  }
  if (runtimeHost?.isRunning()) {
    failures.push(new Error("Controlled runtime host remained alive after cleanup."));
  } else {
    try {
      await cleanupArtifacts();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Controlled runtime host cleanup failed.");
}

async function stopControlledRuntimeHost(child, timeoutMs, sendMessage) {
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error("Controlled runtime host exited before graceful shutdown.");
  }
  const stoppedMessage = waitForChildMessage(child, timeoutMs);
  const exited = waitForChildExit(child, timeoutMs);
  try {
    const [, stopped, exit] = await Promise.all([sendMessage(child, "shutdown", timeoutMs), stoppedMessage, exited]);
    if (stopped.kind !== "stopped" || stopped.checkpoint !== "completed") {
      throw new Error("Controlled runtime host did not complete its checkpoint.");
    }
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error("Controlled runtime host did not exit cleanly.");
    }
    return { checkpoint: "completed" };
  } catch (error) {
    let cleanupError;
    try {
      await terminateChild(child, timeoutMs);
    } catch (caught) {
      cleanupError = caught;
    }
    await Promise.allSettled([stoppedMessage, exited]);
    if (cleanupError !== undefined) {
      throw new AggregateError([error, cleanupError], "Controlled runtime host shutdown cleanup failed.");
    }
    throw error;
  }
}

function sendChildMessage(child, message, timeoutMs) {
  return withTimeout(
    new Promise((resolve, reject) => {
      try {
        child.send(message, (error) => {
          if (error === null) resolve();
          else reject(error);
        });
      } catch (error) {
        reject(error);
      }
    }),
    timeoutMs,
    "Controlled runtime host shutdown request timed out.",
  );
}

function waitForChildMessage(child, timeoutMs) {
  return withTimeout(
    new Promise((resolve, reject) => {
      const onMessage = (message) => {
        cleanup();
        resolve(message);
      };
      const onExit = (code, signal) => {
        cleanup();
        reject(
          new Error(`Controlled runtime host exited before reporting state (${String(code)}, ${String(signal)}).`),
        );
      };
      const cleanup = () => {
        child.off("message", onMessage);
        child.off("exit", onExit);
      };
      child.once("message", onMessage);
      child.once("exit", onExit);
    }),
    timeoutMs,
    "Controlled runtime host message timed out.",
  );
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return withTimeout(
    new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }),
    timeoutMs,
    "Controlled runtime host exit timed out.",
  );
}

async function terminateChild(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = waitForChildExit(child, timeoutMs);
  try {
    child.kill("SIGKILL");
  } catch (error) {
    await exited.catch(() => undefined);
    throw error;
  }
  await exited;
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error("Controlled runtime host remained alive after forced termination.");
  }
}

function withTimeout(operation, timeoutMs, message) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
}
