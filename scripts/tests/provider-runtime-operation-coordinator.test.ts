import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ProviderRuntimeOperationCoordinator } from "../../src-electron/provider-runtime-operation-coordinator.js";

function createDeferred(): {
  promise: Promise<void>;
  resolve(): void;
} {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("ProviderRuntimeOperationCoordinator", () => {
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
