import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ProviderRuntimeOperationCoordinator } from "../../src-electron/providers/provider-runtime-operation-coordinator.js";

/** 操作の開始と解放をテスト側から別々に通知できる待機点を作る。 */
function createDeferred(): {
  promise: Promise<void>;
  /** 待機中の操作を進める。 */
  resolve(): void;
} {
  /** Promise の生成時に、外部から呼べる解決関数を受け取る。 */
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

/** 排他キューの直列実行と失敗後の継続を確かめる。 */
describe("ProviderRuntimeOperationCoordinator", () => {
  /** 先行処理を明示的に解放するまで、後続処理が開始しないことを確かめる。 */
  it("先行 operation の完了まで後続 operation を開始しない", async () => {
    const coordinator = new ProviderRuntimeOperationCoordinator();
    const firstEntered = createDeferred();
    const releaseFirst = createDeferred();
    const events: string[] = [];

    const first = coordinator.runExclusive(async () => {
      events.push("first:start");
      firstEntered.resolve();
      await releaseFirst.promise;
      events.push("first:end");
    });
    await firstEntered.promise;
    const second = coordinator.runExclusive(() => {
      events.push("second");
    });

    await Promise.resolve();
    assert.deepEqual(events, ["first:start"]);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(events, ["first:start", "first:end", "second"]);
  });

  /** 先行処理の例外は呼び出し元に返し、キューに残留させないことを確かめる。 */
  it("operation が失敗しても後続 operation を開始できる", async () => {
    const coordinator = new ProviderRuntimeOperationCoordinator();
    const events: string[] = [];

    await assert.rejects(
      coordinator.runExclusive(() => {
        events.push("failed");
        throw new Error("operation failed");
      }),
      /operation failed/,
    );
    await coordinator.runExclusive(() => {
      events.push("next");
    });

    assert.deepEqual(events, ["failed", "next"]);
  });
});
