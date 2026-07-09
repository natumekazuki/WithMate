import assert from "node:assert/strict";
import test from "node:test";

import { openCompanionInlinePath } from "../../src/chat/companion-inline-path.js";
import type { WithMateWindowApi } from "../../src/withmate-window-api.js";

test("openCompanionInlinePath は Companion worktree を baseDirectory として渡す", () => {
  const calls: Array<{ target: string; baseDirectory?: string | null }> = [];
  const api = {
    openPath(target, options) {
      calls.push({ target, baseDirectory: options?.baseDirectory });
      return Promise.resolve();
    },
  } as Pick<WithMateWindowApi, "openPath"> as WithMateWindowApi;

  openCompanionInlinePath(api, "src/App.tsx", "C:/repo/.withmate/companion/session-1");

  assert.deepEqual(calls, [
    {
      target: "src/App.tsx",
      baseDirectory: "C:/repo/.withmate/companion/session-1",
    },
  ]);
});
