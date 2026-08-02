import assert from "node:assert/strict";
import test from "node:test";

import { openCompanionInlinePath } from "../../src/chat/companion-inline-path.js";
import type { WithMateWindowApi } from "../../src/withmate-window-api.js";

test("openCompanionInlinePath は Companion worktree を baseDirectory として渡す", async () => {
  const calls: Array<{ target: string; baseDirectory?: string | null }> = [];
  const api = {
    openPath(target, options) {
      calls.push({ target, baseDirectory: options?.baseDirectory });
      return Promise.resolve({ status: "opened", targetType: "local-path", target });
    },
  } as Pick<WithMateWindowApi, "openPath"> as WithMateWindowApi;

  assert.equal(await openCompanionInlinePath(api, "src/App.tsx", "C:/repo/.withmate/companion/session-1"), "");

  assert.deepEqual(calls, [
    {
      target: "src/App.tsx",
      baseDirectory: "C:/repo/.withmate/companion/session-1",
    },
  ]);
});

test("openCompanionInlinePath は typed failure result を利用者向けfeedbackへ変換する", async () => {
  const api = {
    async openPath(target: string) {
      return {
        status: "not-found" as const,
        targetType: "local-path" as const,
        target,
        message: "The local path was not found.",
      };
    },
  } as Pick<WithMateWindowApi, "openPath"> as WithMateWindowApi;

  assert.equal(
    await openCompanionInlinePath(api, "missing.txt", "C:/repo"),
    "The local path was not found.",
  );
});
