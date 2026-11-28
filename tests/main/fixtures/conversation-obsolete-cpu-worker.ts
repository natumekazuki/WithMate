import { parentPort } from "node:worker_threads";
import type { ConversationProjectionInput } from "../../../src-electron/storage/conversation-projection-worker.js";
// 決まった条件で実行を譲らない投影処理の代替であり、キャンセルには Worker の終了が必要となる。
parentPort!.on("message", (input: ConversationProjectionInput) => {
  if (input.query.kind === "search" && input.query.query === "obsolete") {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
  }
  parentPort!.postMessage({ result: { count: 1, items: [{ messageIndex: input.rows[0].seq, occurrenceIndex: 0 }] } });
});
