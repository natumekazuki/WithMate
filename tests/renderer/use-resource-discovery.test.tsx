import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import type { DiscoveredSkill } from "../../src-shared/session/runtime-state.js";
import { useResourceDiscovery } from "../../src/chat/use-resource-discovery.js";

// @test-value v2
// kind = "contract"
// claim = "Skill候補は同一provider/workspaceの再取得中と失敗時に保持し、別workspaceへ以前の候補や遅延応答を表示しない"
// oracle = { type = "contract", ref = "docs/design/ui-design-guidelines.md#読込・空・失敗; src/skills/skill-discovery-request.ts（候補のprovider/workspace境界）" }
// fault = "同一対象の再取得で候補を捨てるか、対象切替時に以前の候補または切替前の応答を投影する"
// observable = "useResourceDiscoveryがComposerへ返すSkill ID、読込・失敗状態とlistWorkspaceSkillsの対象"
// observation_boundary = "consumer"
// scope = "Skill discoveryからComposerへ渡す同一対象のキャッシュ・別対象の分離"
// lifecycle = "permanent"
// impact = "選択の途中で候補を失う、または別workspaceのSkillを誤って選べる"
// distinction = "Skill panelのtestは固定候補を入力にするため、取得hookの候補破棄と遅延応答の混入は検出できない"
// @end-test-value
test("Skill候補は同一対象の再取得で保持し、別workspaceの応答と混ぜない", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>");
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  const requests: { path: string; provider: string; resolve: (items: DiscoveredSkill[]) => void; reject: (error: Error) => void }[] = [];
  const api: NonNullable<Parameters<typeof useResourceDiscovery>[0]["api"]> = {
    listSessionCustomAgents: async () => [],
    listWorkspaceSkills: (provider, path) => new Promise((resolve, reject) => requests.push({ path, provider, resolve, reject })),
  };
  const skill = (id: string): DiscoveredSkill => ({
    id, name: id, description: "Synthetic skill", source: "workspace", sourceLabel: "Workspace", sourcePath: `C:/fixture/${id}/SKILL.md`,
  });
  let current: ReturnType<typeof useResourceDiscovery>;
  const committedCandidates: { workspace: string; ids: string[] }[] = [];
  function Consumer({ workspace, revision }: { workspace: string; revision: number }) {
    const discovery = useResourceDiscovery({ api, activeRunSessionId: "session", displayedProvider: "codex",
      selectedProvider: "codex", selectedWorkspacePath: workspace, auxiliaryProvider: undefined, appSettingsRevision: revision });
    useLayoutEffect(() => {
      current = discovery;
      committedCandidates.push({ workspace, ids: discovery.availableSkills.map(({ id }) => id) });
    });
    return null;
  }
  const render = (workspace: string, revision: number) => act(async () => root.render(<Consumer workspace={workspace} revision={revision} />));
  const read = () => ({ ids: current.availableSkills.map(({ id }) => id), loading: current.isSkillListLoading, error: current.skillListError });
  try {
    await render("C:/fixture/a", 0);
    assert.deepEqual(read(), { ids: [], loading: true, error: null });
    assert.equal(requests[0]?.path, "C:/fixture/a");
    await act(async () => requests[0]!.resolve([skill("a")]));
    assert.deepEqual(read(), { ids: ["a"], loading: false, error: null });

    await render("C:/fixture/a", 1);
    assert.deepEqual(read(), { ids: ["a"], loading: true, error: null });
    await act(async () => requests[1]!.reject(new Error("discovery failed")));
    assert.deepEqual(read(), { ids: ["a"], loading: false, error: "Could not load skills. Check Settings or the workspace." });

    await render("C:/fixture/a", 2);
    await render("C:/fixture/b", 2);
    assert.deepEqual(read(), { ids: [], loading: true, error: null });
    assert.equal(requests[3]?.path, "C:/fixture/b");
    assert.equal(requests[3]?.provider, "codex");
    await act(async () => requests[3]!.resolve([skill("b")]));
    await act(async () => requests[2]!.resolve([skill("late-a")]));
    assert.deepEqual(read(), { ids: ["b"], loading: false, error: null });
    assert.deepEqual([...new Set(committedCandidates.filter(({ workspace }) => workspace === "C:/fixture/b").flatMap(({ ids }) => ids))], ["b"]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
