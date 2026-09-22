import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

import {
  useMainAuxiliaryRuntimeSession,
  useMessageListAuxiliarySessions,
} from "../../src/chat/auxiliary/auxiliary-render-projections.js";
import {
  buildMainAuxiliaryRuntimeSession,
} from "../../src/chat/auxiliary/auxiliary-runtime-projection.js";
import type { AuxiliarySession } from "../../src-shared/auxiliary/auxiliary-session-state.js";
import type { Session } from "../../src-shared/session/session-state.js";

function createAuxiliarySession(overrides: Partial<AuxiliarySession> = {}): AuxiliarySession {
  return {
    id: "auxiliary-1",
    parentSessionId: "parent-1",
    status: "active",
    runState: "running",
    title: "Auxiliary Session",
    provider: "codex",
    catalogRevision: 2,
    model: "gpt-test",
    reasoningEffort: "low",
    approvalMode: "never",
    codexSandboxMode: "workspace-write",
    codexSpeed: "standard",
    codexReviewer: "user",
    customAgentName: "",
    allowedAdditionalDirectories: ["C:/alpha", "C:/beta"],
    threadId: "thread-1",
    composerDraft: "",
    messages: [{ role: "assistant", text: "auxiliary response" }],
    displayAfterMessageIndex: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    closedAt: "",
    ...overrides,
  };
}

function createSession(): Session {
  return {
    id: "session-1",
    taskTitle: "Main Session",
    status: "idle",
    updatedAt: "2026-01-01T00:00:00.000Z",
    provider: "provider-main",
    catalogRevision: 1,
    workspaceLabel: "WithMate",
    workspacePath: "C:/workspace",
    branch: "main",
    sessionKind: "default",
    accessMode: "active",
    sourceSchemaVersion: 4,
    isPinned: false,
    characterId: "char-1",
    character: "Test",
    characterIconPath: "",
    characterThemeColors: { main: "#000", sub: "#fff" },
    characterRuntimeSnapshot: {
      characterId: "char-1",
      name: "Test",
      description: "Auxiliary projection character snapshot",
      iconFilePath: "",
      theme: { main: "#000", sub: "#fff" },
      definitionMarkdown: "# Character\n\nAuxiliary projection keeps this prompt.",
      definitionSha256: "character-sha",
      definitionByteSize: 51,
      snapshotAt: "2026-01-01T00:00:00.000Z",
    },
    runState: "idle",
    approvalMode: "on-request",
    codexSandboxMode: "workspace-write",
    codexSpeed: "standard",
    codexReviewer: "user",
    model: "gpt-main",
    reasoningEffort: "medium",
    customAgentName: "",
    allowedAdditionalDirectories: [],
    threadId: "session-thread",
    messages: [{ role: "user", text: "hello" }],
    stream: [{ mood: "spark", time: "2026-01-01T00:00:00.000Z", text: "..." }],
  };
}

// @test-value v2
// kind = "invariant"
// claim = "Auxiliaryのdraft-only更新は履歴とMain runtime projectionの参照を維持する"
// oracle = { type = "contract", ref = "https://github.com/natumekazuki/WithMate/issues/729" }
// fault = "draft変更だけで履歴またはruntime projectionを不要に再生成する"
// observable = "draft-only、transcript、runtime、anchor更新後のprojection参照"
// observation_boundary = "component-behavior"
// scope = "auxiliary-runtime-projection"
// lifecycle = "permanent"
// @end-test-value
test("Auxiliary render projection は draft-only 更新で履歴と runtime の参照を維持する", async () => {
  const previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNode = globalThis.Node;
  const previousNavigator = globalThis.navigator;
  const dom = new JSDOM("<!doctype html><div id=\"root\"></div>", { pretendToBeVisual: true });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: dom.window.Node });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });

  const root = createRoot(dom.window.document.getElementById("root") as HTMLElement);
  const mainSession = createSession();
  const closedSessions: AuxiliarySession[] = [];
  let latestProjection: {
    messageListSessions: ReturnType<typeof useMessageListAuxiliarySessions>;
    mainRuntime: Session | null;
  } | null = null;

  function ProjectionProbe({ activeSession }: { activeSession: AuxiliarySession }) {
    latestProjection = {
      messageListSessions: useMessageListAuxiliarySessions(closedSessions, activeSession),
      mainRuntime: useMainAuxiliaryRuntimeSession(mainSession, activeSession),
    };
    return null;
  }

  const renderProjection = async (activeSession: AuxiliarySession) => {
    await act(async () => {
      root.render(React.createElement(ProjectionProbe, { activeSession }));
    });
    assert.ok(latestProjection);
    return latestProjection;
  };

  try {
    const initialSession = createAuxiliarySession();
    const initial = await renderProjection(initialSession);
    const draftOnly = await renderProjection({
      ...initialSession,
      composerDraft: "typing",
      updatedAt: "2026-01-03T00:00:00.000Z",
    });

    assert.equal(draftOnly.messageListSessions, initial.messageListSessions);
    assert.equal(draftOnly.mainRuntime, initial.mainRuntime);

    const transcriptChanged = await renderProjection({
      ...initialSession,
      composerDraft: "typing",
      messages: [...initialSession.messages, { role: "user", text: "next message" }],
    });
    assert.notEqual(transcriptChanged.messageListSessions, draftOnly.messageListSessions);
    assert.notEqual(transcriptChanged.mainRuntime, draftOnly.mainRuntime);

    const runtimeChanged = await renderProjection({
      ...initialSession,
      messages: transcriptChanged.mainRuntime?.messages ?? initialSession.messages,
      model: "gpt-next",
    });
    assert.equal(runtimeChanged.messageListSessions, transcriptChanged.messageListSessions);
    assert.notEqual(runtimeChanged.mainRuntime, transcriptChanged.mainRuntime);

    const anchorChanged = await renderProjection({
      ...initialSession,
      messages: runtimeChanged.mainRuntime?.messages ?? initialSession.messages,
      model: "gpt-next",
      displayAfterMessageIndex: 4,
    });
    assert.notEqual(anchorChanged.messageListSessions, runtimeChanged.messageListSessions);
    assert.equal(anchorChanged.mainRuntime, runtimeChanged.mainRuntime);
  } finally {
    await act(async () => {
      root.unmount();
    });
    dom.window.close();
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "Node", { configurable: true, value: previousNode });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      previousActEnvironment;
  }
});


// @test-value v2
// kind = "invariant"
// claim = "Auxiliary runtime projectionは保存済みCharacter snapshotの表示情報とownerをMainへ投影する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md" }
// fault = "Auxiliaryの表示名・icon・themeが親Characterへ戻り、会話identityと表示identityが混線する"
// observable = "projection characterId/name/icon/theme/snapshot"
// observation_boundary = "public-boundary"
// scope = "auxiliary-runtime-projection"
// lifecycle = "permanent"
// @end-test-value
test("Auxiliary runtime projectionはCharacter snapshotの表示情報を保持する", () => {
  const parent = createSession();
  const auxiliary = createAuxiliarySession();
  const snapshot = {
    ...parent.characterRuntimeSnapshot!,
    characterId: "character-aux",
    name: "Auxiliary Character",
    iconFilePath: "auxiliary/icon.png",
    theme: { main: "#111111", sub: "#222222" },
  };
  const projection = buildMainAuxiliaryRuntimeSession(parent, {
    ...auxiliary,
    characterId: snapshot.characterId,
    characterRuntimeSnapshot: snapshot,
  });

  assert.equal(projection.characterId, snapshot.characterId);
  assert.equal(projection.character, snapshot.name);
  assert.equal(projection.characterIconPath, snapshot.iconFilePath);
  assert.deepEqual(projection.characterThemeColors, snapshot.theme);
  assert.deepEqual(projection.characterRuntimeSnapshot, snapshot);
});

// @test-value v2
// kind = "invariant"
// claim = "MainのAuxiliary表示はAuxiliary会話のruntimeと親Sessionの表示contextを投影する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md" }
// fault = "Auxiliaryを選択しても親Sessionの会話・provider・threadを表示する"
// observable = "投影SessionのID、provider、model、thread、messages、directories、status、親titleとsnapshot"
// observation_boundary = "public-boundary"
// scope = "Main Auxiliary runtime projection"
// lifecycle = "permanent"
// @end-test-value
test("buildAuxiliaryRuntimeSessionProjection main keeps runtime projection diff fields", () => {
  const parent = createSession();
  const auxiliary = createAuxiliarySession();

  const projection = buildMainAuxiliaryRuntimeSession(parent, auxiliary);

  assert.equal(projection.id, auxiliary.id);
  assert.equal(projection.provider, auxiliary.provider);
  assert.equal(projection.model, auxiliary.model);
  assert.equal(projection.threadId, auxiliary.threadId);
  assert.deepEqual(projection.messages, auxiliary.messages);
  assert.deepEqual(projection.allowedAdditionalDirectories, auxiliary.allowedAdditionalDirectories);
  assert.equal(projection.status, "running");
  assert.equal(projection.taskTitle, parent.taskTitle);
  assert.deepEqual(projection.characterRuntimeSnapshot, parent.characterRuntimeSnapshot);
  assert.deepEqual(projection.stream, []);
});

// @test-value v2
// kind = "invariant"
// claim = "non-running状態のAuxiliaryはrunStateを維持しSession statusをidleへ投影する"
// oracle = { type = "contract", ref = "docs/design/auxiliary-session.md" }
// fault = "終了または失敗したAuxiliaryを実行中として表示する"
// observable = "投影SessionのrunStateとstatus"
// observation_boundary = "public-boundary"
// scope = "Main Auxiliary runtime projection status"
// lifecycle = "permanent"
// @end-test-value
test("buildAuxiliaryRuntimeSessionProjection main maps non-running auxiliary to idle status", () => {
  for (const runState of ["idle", "error"] as const) {
    const parent = createSession();
    const auxiliary = createAuxiliarySession();

    const projection = buildMainAuxiliaryRuntimeSession(parent, {
      ...auxiliary,
      runState,
    });

    assert.equal(projection.runState, runState);
    assert.equal(projection.status, "idle");
  }
});
