import assert from "node:assert/strict";
import test from "node:test";

import { PreviewResourceQueue } from "../../src/file-explorer/preview-resource-queue.js";

test("preview resource queue limits concurrent work", async () => {
  const queue = new PreviewResourceQueue(2);
  let releaseTasks = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseTasks = resolve;
  });
  let activeCount = 0;
  let maxActiveCount = 0;

  const tasks = Array.from({ length: 8 }, (_, index) => queue.run(async () => {
    activeCount += 1;
    maxActiveCount = Math.max(maxActiveCount, activeCount);
    await gate;
    activeCount -= 1;
    return String(index);
  }));

  await Promise.resolve();
  assert.equal(activeCount, 2);
  releaseTasks();
  assert.deepEqual(await Promise.all(tasks), ["0", "1", "2", "3", "4", "5", "6", "7"]);
  assert.equal(maxActiveCount, 2);
});

test("preview resource queue discards waiting work when the preview changes", async () => {
  const queue = new PreviewResourceQueue(2);
  const releases: Array<() => void> = [];
  const started: number[] = [];

  const tasks = Array.from({ length: 6 }, (_, index) => queue.run(async (isCurrent) => {
    started.push(index);
    await new Promise<void>((resolve) => releases.push(resolve));
    return isCurrent() ? String(index) : null;
  }));

  await Promise.resolve();
  assert.deepEqual(started, [0, 1]);
  queue.invalidate();
  assert.deepEqual(started, [0, 1]);
  for (const release of releases) {
    release();
  }

  assert.deepEqual(await Promise.all(tasks), [null, null, null, null, null, null]);
  assert.deepEqual(started, [0, 1]);
  assert.equal(await queue.run(async (isCurrent) => isCurrent() ? "next" : null), "next");
});
