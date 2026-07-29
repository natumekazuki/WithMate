import assert from "node:assert/strict";
import test from "node:test";

import {
  createWindowsJobObject,
  WindowsJobObjectAcquisitionError,
  type WindowsJobObjectDependencies,
} from "../src/main/providers/codex/windows-job-object.js";

test("configuration failure exposes the same Job owner until native release succeeds", () => {
  let jobReleaseAttempts = 0;
  const api = createFakeWindowsJobApi({
    setInformationJobObject: () => 0,
    closeHandle(handle) {
      assert.equal(handle, 1n);
      jobReleaseAttempts += 1;
      return jobReleaseAttempts === 1 ? 0 : 1;
    },
  });

  let acquisitionError: WindowsJobObjectAcquisitionError | undefined;
  try {
    createWindowsJobObject({ platform: "win32", api });
  } catch (error) {
    if (error instanceof WindowsJobObjectAcquisitionError) acquisitionError = error;
    else throw error;
  }
  assert.ok(acquisitionError);

  assert.throws(() => acquisitionError.owner.close(), /could not be released/u);
  acquisitionError.owner.close();
  assert.equal(jobReleaseAttempts, 2);
});

test("assignment retains an unclosed process handle for the Job owner release retry", () => {
  const closedHandles: bigint[] = [];
  let processReleaseAttempts = 0;
  const api = createFakeWindowsJobApi({
    closeHandle(handle) {
      closedHandles.push(handle);
      if (handle === 2n) {
        processReleaseAttempts += 1;
        return processReleaseAttempts === 1 ? 0 : 1;
      }
      return 1;
    },
  });
  const owner = createWindowsJobObject({ platform: "win32", api });

  assert.throws(() => owner.assignProcess(42), /process handle ownership could not be released/u);
  owner.close();

  assert.deepEqual(closedHandles, [2n, 2n, 1n]);
});

function createFakeWindowsJobApi(
  overrides: Partial<NonNullable<WindowsJobObjectDependencies["api"]>>,
): NonNullable<WindowsJobObjectDependencies["api"]> {
  return {
    createJobObject: () => 1n,
    setInformationJobObject: () => 1,
    openProcess: () => 2n,
    assignProcessToJobObject: () => 1,
    terminateJobObject: () => 1,
    closeHandle: () => 1,
    jobLimitsSize: 1,
    ...overrides,
  };
}
