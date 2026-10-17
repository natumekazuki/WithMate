import { parentPort } from "node:worker_threads";
import { CodexProjectionOwner } from "./codex-projection-owner.js";
import type { CodexProjectionRequest, CodexProjectionResponse } from "./codex-projection-protocol.js";

if (!parentPort) throw new Error("Codex projection Worker requires a parent port.");
const owners = new Map<string, CodexProjectionOwner>();
parentPort.on("message", (request: CodexProjectionRequest) => {
  const owner = owners.get(request.runId);
  try {
    let value: unknown;
    const command = request.command;
    if (command.type === "start") {
      if (owner) throw new Error("Codex projection run is already open.");
      owners.set(request.runId, new CodexProjectionOwner(command.input));
    } else {
      if (!owner) throw new Error("Codex projection run is not open.");
      switch (command.type) {
        case "event": value = owner.apply(command.event); break;
        case "events": value = command.events.map(event => owner.apply(event)); break;
        case "live": value = owner.live(command.inputAvailable, command.force); break;
        case "question-position": value = owner.questionPosition(); break;
        case "finish": value = owner.finish(command.diagnostics); break;
        case "release": owners.delete(request.runId); break;
      }
    }
    parentPort!.postMessage({ id: request.id, value } satisfies CodexProjectionResponse);
  } catch (error) {
    parentPort!.postMessage({ id: request.id, error: owner?.sanitizeError(error) ?? "Codex projection initialization failed." } satisfies CodexProjectionResponse);
  }
});
