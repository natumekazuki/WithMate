import { parentPort, workerData } from "node:worker_threads";
import { tsImport } from "tsx/esm/api";

import type { AffectEventInput } from "../../../src-shared/character-affect/affect-contract.js";

const { CharacterAffectStorage } = await tsImport(
  "../../../src-electron/character/character-affect-storage.ts",
  import.meta.url,
) as typeof import("../../../src-electron/character/character-affect-storage.js");
const { openAppDatabase } = await tsImport(
  "../../../src-electron/storage/sqlite-connection.ts",
  import.meta.url,
) as typeof import("../../../src-electron/storage/sqlite-connection.js");

type WorkerData =
  | { mode: "blocker"; dbPath: string }
  | { mode: "append"; dbPath: string; event: AffectEventInput; started: SharedArrayBuffer };

if (!parentPort) {
  throw new Error("Character Affect concurrency worker requires a parent port.");
}
const workerPort = parentPort;

const input = workerData as WorkerData;

if (input.mode === "blocker") {
  const db = openAppDatabase(input.dbPath);
  db.exec("BEGIN IMMEDIATE TRANSACTION;");
  workerPort.postMessage({ type: "locked" });
  workerPort.once("message", (message: { type?: string }) => {
    try {
      if (message.type !== "release") {
        throw new Error("Unexpected blocker command.");
      }
      db.exec("COMMIT;");
      workerPort.postMessage({ type: "released" });
    } catch (error) {
      workerPort.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      db.close();
    }
  });
} else {
  const storage = new CharacterAffectStorage(input.dbPath);
  workerPort.postMessage({ type: "ready" });
  workerPort.once("message", (message: { type?: string }) => {
    try {
      if (message.type !== "start") {
        throw new Error("Unexpected append command.");
      }
      workerPort.postMessage({ type: "attempting" });
      const started = new Int32Array(input.started);
      Atomics.add(started, 0, 1);
      Atomics.notify(started, 0);
      const result = storage.recordEvent(input.event);
      workerPort.postMessage({
        type: "result",
        created: result.created,
        eventId: result.event.id,
      });
    } catch (error) {
      workerPort.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      storage.close();
    }
  });
}
