import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  loadMateStatusSnapshot,
  type MateStatusLoadApi,
} from "../../src/mate/mate-status-load-operation.js";
import { buildMateStatusRefreshers } from "../../src/mate/mate-status-refreshers.js";
import type { MateProfile } from "../../src-shared/mate/mate-state.js";

/** 表示名以外を固定した active の Mate プロフィールを生成する。 */
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

/** active を取得した後でプロフィールを読み込み、両方を持つ ready スナップショットを返す。 */
test("loadMateStatusSnapshot は active state と profile を取得する", async () => {
  const profile = createMateProfile("アリス");
  const calls: string[] = [];
  const api: MateStatusLoadApi = {
    /** 状態取得が先に呼ばれたことを記録し、プロフィールを読める active を返す。 */
    getMateState: async () => {
      calls.push("getMateState");
      return "active";
    },
    /** 状態取得より後に呼ばれたことを記録し、比較用のプロフィールを返す。 */
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

/** Mate が未作成ならプロフィールを要求せず、空のプロフィールと not_created を ready として返す。 */
test("loadMateStatusSnapshot は not_created では profile を取得しない", async () => {
  let profileCallCount = 0;
  const api: MateStatusLoadApi = {
    /** プロフィールのない未作成状態を返す。 */
    getMateState: async () => "not_created",
    /** 未作成なのにプロフィールを要求した場合の呼び出しを数える。 */
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

/** プロフィールが利用不能と報告されたとき、残っているプロフィールを読まず null を返す。 */
test("loadMateStatusSnapshot は profile_unavailable では profile を取得しない", async () => {
  let profileCallCount = 0;
  const api: MateStatusLoadApi = {
    /** Mate は作成済みでもプロフィールを利用できない状態を返す。 */
    getMateState: async () => "profile_unavailable",
    /** 利用不能なプロフィールを誤って読んだ場合に回数を記録する。 */
    getMateProfile: async () => {
      profileCallCount += 1;
      return createMateProfile("stale");
    },
  };

  const result = await loadMateStatusSnapshot({ api });

  assert.equal(profileCallCount, 0);
  assert.deepEqual(result, {
    status: "ready",
    mateState: "profile_unavailable",
    mateProfile: null,
  });
});

/** 状態取得の完了時に依頼が無効になれば、そこで処理を打ち切り、プロフィールを読まず stale として返す。 */
test("loadMateStatusSnapshot は state 取得後に inactive なら stale として profile を取得しない", async () => {
  let active = true;
  let profileCallCount = 0;
  const api: MateStatusLoadApi = {
    /** active を返すのと同時に、呼び出し元が結果を採用できない状態に変える。 */
    getMateState: async () => {
      active = false;
      return "active";
    },
    /** 無効になった依頼で後続のプロフィール取得が始まった場合に記録する。 */
    getMateProfile: async () => {
      profileCallCount += 1;
      return createMateProfile("stale");
    },
  };

  const result = await loadMateStatusSnapshot({
    api,
    /** 状態取得の側で切り替えた、依頼がまだ有効かどうかを返す。 */
    isActive: () => active,
  });

  assert.equal(profileCallCount, 0);
  assert.deepEqual(result, {
    status: "stale",
    mateState: "active",
  });
});

/** 状態が有効でも、プロフィール取得中に依頼が無効になれば、古いプロフィールは返さず stale を返す。 */
test("loadMateStatusSnapshot は profile 取得後に inactive なら stale として返す", async () => {
  let active = true;
  const api: MateStatusLoadApi = {
    /** 依頼がまだ有効な段階で、プロフィールの読取対象となる active を返す。 */
    getMateState: async () => "active",
    /** プロフィールの値が届く前に依頼を無効に切り替える。 */
    getMateProfile: async () => {
      active = false;
      return createMateProfile("stale");
    },
  };

  const result = await loadMateStatusSnapshot({
    api,
    /** プロフィール取得中の無効化を、取得直後の有効性確認に伝える。 */
    isActive: () => active,
  });

  assert.deepEqual(result, {
    status: "stale",
    mateState: "active",
  });
});

// @test-value v2
// kind = "contract"
// claim = "Mateの状態取得後に対象がinactiveなら、Avatar処理状態を含むUI stateを更新しない"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md 読込・空・失敗" }
// fault = "遅いMate取得結果が無効化後のUI状態を上書きする"
// observable = "state更新callbackの呼出し一覧"
// observation_boundary = "consumer"
// scope = "Mate status refreshの有効期間"
// lifecycle = "permanent"
// @end-test-value
/** 取得自体が ready で完了しても反映直前に無効なら、active は呼び出し元へ返すが画面の更新関数は呼ばない。 */
test("refreshMateStatus は ready result 後に inactive なら UI state を更新しない", async () => {
  const profile = createMateProfile("アリス");
  const calls: string[] = [];
  let activeCheckCount = 0;
  /** 読み取りの途中までは有効とし、状態を UI へ適用する直前の照合で初めて無効になるようにする。 */
  const isActive = () => {
    activeCheckCount += 1;
    return activeCheckCount <= 2;
  };
  const api: MateStatusLoadApi = {
    /** 古い依頼でも状態取得自体は成功する状況を作る。 */
    getMateState: async () => "active",
    /** 無効化前に取得済みとなるプロフィールを返す。 */
    getMateProfile: async () => profile,
  };
  const refreshers = buildMateStatusRefreshers({
    /** 状態の UI 書き込みが拒否されずに進んだ場合を記録する。 */
    setMateState: () => calls.push("setMateState"),
    /** プロフィール本体の UI 書き込みが発生したら記録する。 */
    setMateProfile: () => calls.push("setMateProfile"),
    /** 表示名への個別の反映も起きていないことを確認できるようにする。 */
    setMateDisplayName: () => calls.push("setMateDisplayName"),
    /** アバター操作の更新が古い結果で呼ばれた場合に記録する。 */
    setMateAvatarAction: () => calls.push("setMateAvatarAction"),
  });

  const state = await refreshers.refreshMateStatus(api, { isActive });

  assert.equal(state, "active");
  assert.deepEqual(calls, []);
});
