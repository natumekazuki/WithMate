import { parentPort } from "node:worker_threads";
import type { ConversationProjectionInput } from "../../../src-electron/storage/conversation-projection-worker.js";
// A deterministic non-yielding projection stand-in; cancellation must terminate its worker.
parentPort!.on("message", (input: ConversationProjectionInput) => {
  if (input.query.kind === "search" && input.query.query === "obsolete") {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
  }
  parentPort!.postMessage({ result: { count: 1, items: [{ messageIndex: input.rows[0].seq, occurrenceIndex: 0 }] } });
});
