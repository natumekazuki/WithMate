import { parentPort, workerData } from "node:worker_threads";

import type { AffectEventInput } from "../../../src/character-affect/affect-contract.js";
import { CharacterAffectStorage } from "../../../src-electron/character-affect-storage.js";
import { openAppDatabase } from "../../../src-electron/sqlite-connection.js";

type WorkerData =
  | { mode: "blocker"; dbPath: string }
  | { mode: "append"; dbPath: string; event: AffectEventInput; started: SharedArrayBuffer };

if (!parentPort) {
  throw new Error("Character Affect concurrency worker requires a parent port.");
}

const input = workerData as WorkerData;

if (input.mode === "blocker") {
  const db = openAppDatabase(input.dbPath);
  db.exec("BEGIN IMMEDIATE TRANSACTION;");
  parentPort.postMessage({ type: "locked" });
  parentPort.once("message", (message: { type?: string }) => {
    try {
      if (message.type !== "release") {
        throw new Error("Unexpected blocker command.");
      }
      db.exec("COMMIT;");
      parentPort.postMessage({ type: "released" });
    } catch (error) {
      parentPort.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      db.close();
    }
  });
} else {
  const storage = new CharacterAffectStorage(input.dbPath);
  parentPort.postMessage({ type: "ready" });
  parentPort.once("message", (message: { type?: string }) => {
    try {
      if (message.type !== "start") {
        throw new Error("Unexpected append command.");
      }
      parentPort.postMessage({ type: "attempting" });
      const started = new Int32Array(input.started);
      Atomics.add(started, 0, 1);
      Atomics.notify(started, 0);
      const result = storage.recordEvent(input.event);
      parentPort.postMessage({
        type: "result",
        created: result.created,
        eventId: result.event.id,
      });
    } catch (error) {
      parentPort.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      storage.close();
    }
  });
}
