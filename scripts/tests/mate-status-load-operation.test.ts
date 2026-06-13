import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  loadMateStatusSnapshot,
  type MateStatusLoadApi,
} from "../../src/mate/mate-status-load-operation.js";
import { buildMateStatusRefreshers } from "../../src/mate/mate-status-refreshers.js";
import type { MateProfile } from "../../src/mate/mate-state.js";

const createMateProfile = (displayName: string): MateProfile => ({
  id: "mate-1",
  state: "active",
  displayName,
  description: "",
  themeMain: "#111111",
  themeSub: "#ffffff",
  avatarFilePath: "",
  avatarSha256: "",
  avatarByteSize: 0,
  activeRevisionId: null,
  profileGeneration: 1,
  createdAt: "2026-06-10T00:00:00.000Z",
  updatedAt: "2026-06-10T00:00:00.000Z",
  deletedAt: null,
  sections: [],
});

test("loadMateStatusSnapshot は active state と profile を取得する", async () => {
  const profile = createMateProfile("アリス");
  const calls: string[] = [];
  const api: MateStatusLoadApi = {
    getMateState: async () => {
      calls.push("getMateState");
      return "active";
    },
    getMateProfile: async () => {
      calls.push("getMateProfile");
      return profile;
    },
  };

  const result = await loadMateStatusSnapshot({ api });

  assert.deepEqual(calls, ["getMateState", "getMateProfile"]);
  assert.deepEqual(result, {
    status: "ready",
    mateState: "active",
    mateProfile: profile,
  });
});

test("loadMateStatusSnapshot は not_created では profile を取得しない", async () => {
  let profileCallCount = 0;
  const api: MateStatusLoadApi = {
    getMateState: async () => "not_created",
    getMateProfile: async () => {
      profileCallCount += 1;
      return createMateProfile("stale");
    },
  };

  const result = await loadMateStatusSnapshot({ api });

  assert.equal(profileCallCount, 0);
  assert.deepEqual(result, {
    status: "ready",
    mateState: "not_created",
    mateProfile: null,
  });
});

test("loadMateStatusSnapshot は state 取得後に inactive なら stale として profile を取得しない", async () => {
  let active = true;
  let profileCallCount = 0;
  const api: MateStatusLoadApi = {
    getMateState: async () => {
      active = false;
      return "active";
    },
    getMateProfile: async () => {
      profileCallCount += 1;
      return createMateProfile("stale");
    },
  };

  const result = await loadMateStatusSnapshot({ api, isActive: () => active });

  assert.equal(profileCallCount, 0);
  assert.deepEqual(result, {
    status: "stale",
    mateState: "active",
  });
});

test("loadMateStatusSnapshot は profile 取得後に inactive なら stale として返す", async () => {
  let active = true;
  const api: MateStatusLoadApi = {
    getMateState: async () => "active",
    getMateProfile: async () => {
      active = false;
      return createMateProfile("stale");
    },
  };

  const result = await loadMateStatusSnapshot({ api, isActive: () => active });

  assert.deepEqual(result, {
    status: "stale",
    mateState: "active",
  });
});

test("refreshMateStatus は ready result 後に inactive なら UI state を更新しない", async () => {
  const profile = createMateProfile("アリス");
  const calls: string[] = [];
  let activeCheckCount = 0;
  const isActive = () => {
    activeCheckCount += 1;
    return activeCheckCount <= 2;
  };
  const api: MateStatusLoadApi = {
    getMateState: async () => "active",
    getMateProfile: async () => profile,
  };
  const refreshers = buildMateStatusRefreshers({
    setMateState: () => calls.push("setMateState"),
    setMateProfile: () => calls.push("setMateProfile"),
    setMateDisplayName: () => calls.push("setMateDisplayName"),
    setMateAvatarUpdating: () => calls.push("setMateAvatarUpdating"),
  });

  const state = await refreshers.refreshMateStatus(api, { isActive });

  assert.equal(state, "active");
  assert.deepEqual(calls, []);
});

test("MateTalk 初期化 caller は mate status result 適用直前に active を再確認する", async () => {
  const source = await readFile(new URL("../../src/chat/use-mate-talk-window-state.ts", import.meta.url), "utf8");
  const loadIndex = source.indexOf("loadMateStatusSnapshot({");
  assert.notEqual(loadIndex, -1);

  assert.match(
    source.slice(loadIndex, loadIndex + 260),
    /result\.status === "stale" \|\| !active/,
  );
});
