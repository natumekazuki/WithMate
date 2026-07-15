import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

import {
  useCompanionAuxiliaryRuntimeSession,
  useMainAuxiliaryRuntimeSession,
  useMessageListAuxiliarySessions,
} from "../../src/auxiliary-render-projections.js";
import {
  buildAuxiliaryRuntimeSessionProjection,
  buildCompanionAuxiliaryRuntimeSession,
  buildMainAuxiliaryRuntimeSession,
} from "../../src/auxiliary-runtime-projection.js";
import type { AuxiliarySession } from "../../src/auxiliary-session-state.js";
import type { CompanionSession } from "../../src/companion-state.js";
import type { Session } from "../../src/session-state.js";

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
    model: "gpt-main",
    reasoningEffort: "medium",
    customAgentName: "",
    allowedAdditionalDirectories: [],
    threadId: "session-thread",
    messages: [{ role: "user", text: "hello" }],
    stream: [{ mood: "spark", time: "2026-01-01T00:00:00.000Z", text: "..." }],
  };
}

function createCompanionSession(): CompanionSession {
  return {
    id: "companion-1",
    groupId: "group-1",
    taskTitle: "Companion Session",
    status: "active",
    repoRoot: "C:/workspace",
    focusPath: "src",
    targetBranch: "main",
    baseSnapshotRef: "base-ref",
    baseSnapshotCommit: "base-commit",
    companionBranch: "companion/main",
    worktreePath: "C:/workspace-companion",
    selectedPaths: [],
    changedFiles: [],
    siblingWarnings: [],
    allowedAdditionalDirectories: ["C:/companion"],
    runState: "idle",
    threadId: "companion-thread",
    provider: "provider-companion",
    catalogRevision: 1,
    model: "gpt-companion",
    reasoningEffort: "medium",
    customAgentName: "buddy",
    approvalMode: "on-failure",
    codexSandboxMode: "workspace-write",
    characterId: "companion-char",
    character: "Companion",
    characterRoleMarkdown: "",
    characterIconPath: "",
    characterThemeColors: { main: "#000", sub: "#fff" },
    characterRuntimeSnapshot: {
      characterId: "companion-char",
      name: "Companion",
      description: "Companion auxiliary projection character snapshot",
      iconFilePath: "",
      theme: { main: "#000", sub: "#fff" },
      definitionMarkdown: "# Character\n\nCompanion auxiliary projection keeps this prompt.",
      definitionSha256: "companion-character-sha",
      definitionByteSize: 61,
      snapshotAt: "2026-01-01T00:00:00.000Z",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messages: [{ role: "assistant", text: "companion response" }],
  };
}

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
  const companionSession = createCompanionSession();
  const closedSessions: AuxiliarySession[] = [];
  let latestProjection: {
    messageListSessions: ReturnType<typeof useMessageListAuxiliarySessions>;
    mainRuntime: Session | null;
    companionRuntime: CompanionSession | null;
  } | null = null;

  function ProjectionProbe({ activeSession }: { activeSession: AuxiliarySession }) {
    latestProjection = {
      messageListSessions: useMessageListAuxiliarySessions(closedSessions, activeSession),
      mainRuntime: useMainAuxiliaryRuntimeSession(mainSession, activeSession),
      companionRuntime: useCompanionAuxiliaryRuntimeSession(companionSession, activeSession),
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
    assert.equal(draftOnly.companionRuntime, initial.companionRuntime);

    const transcriptChanged = await renderProjection({
      ...initialSession,
      composerDraft: "typing",
      messages: [...initialSession.messages, { role: "user", text: "next message" }],
    });
    assert.notEqual(transcriptChanged.messageListSessions, draftOnly.messageListSessions);
    assert.notEqual(transcriptChanged.mainRuntime, draftOnly.mainRuntime);
    assert.notEqual(transcriptChanged.companionRuntime, draftOnly.companionRuntime);

    const runtimeChanged = await renderProjection({
      ...initialSession,
      messages: transcriptChanged.mainRuntime?.messages ?? initialSession.messages,
      model: "gpt-next",
    });
    assert.equal(runtimeChanged.messageListSessions, transcriptChanged.messageListSessions);
    assert.notEqual(runtimeChanged.mainRuntime, transcriptChanged.mainRuntime);
    assert.notEqual(runtimeChanged.companionRuntime, transcriptChanged.companionRuntime);

    const anchorChanged = await renderProjection({
      ...initialSession,
      messages: runtimeChanged.mainRuntime?.messages ?? initialSession.messages,
      model: "gpt-next",
      displayAfterMessageIndex: 4,
    });
    assert.notEqual(anchorChanged.messageListSessions, runtimeChanged.messageListSessions);
    assert.equal(anchorChanged.mainRuntime, runtimeChanged.mainRuntime);
    assert.equal(anchorChanged.companionRuntime, runtimeChanged.companionRuntime);
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

test("buildAuxiliaryRuntimeSessionProjection main keeps runtime projection diff fields", () => {
  const parent = createSession();
  const auxiliary = createAuxiliarySession();

  const projection = buildAuxiliaryRuntimeSessionProjection("main", parent, auxiliary);

  assert.equal(projection.id, auxiliary.id);
  assert.equal(projection.provider, auxiliary.provider);
  assert.equal(projection.model, auxiliary.model);
  assert.equal(projection.threadId, auxiliary.threadId);
  assert.deepEqual(projection.messages, auxiliary.messages);
  assert.equal(projection.allowedAdditionalDirectories, auxiliary.allowedAdditionalDirectories);
  assert.equal(projection.status, "running");
  assert.equal(projection.taskTitle, parent.taskTitle);
  assert.equal(projection.characterRuntimeSnapshot, parent.characterRuntimeSnapshot);
  assert.deepEqual(projection.stream, []);
});

test("buildMainAuxiliaryRuntimeSession wraps main runtime projection", () => {
  const parent = createSession();
  const auxiliary = createAuxiliarySession();

  assert.deepEqual(
    buildMainAuxiliaryRuntimeSession(parent, auxiliary),
    buildAuxiliaryRuntimeSessionProjection("main", parent, auxiliary),
  );
});

test("buildAuxiliaryRuntimeSessionProjection main maps non-running auxiliary to idle status", () => {
  const parent = createSession();
  const auxiliary = createAuxiliarySession();

  const projection = buildAuxiliaryRuntimeSessionProjection("main", parent, {
    ...auxiliary,
    runState: "error",
  });

  assert.equal(projection.runState, "error");
  assert.equal(projection.status, "idle");
});

test("buildAuxiliaryRuntimeSessionProjection companion keeps companion projection diff fields", () => {
  const parent = createCompanionSession();
  const auxiliary = createAuxiliarySession();

  const projection = buildAuxiliaryRuntimeSessionProjection("companion", parent, auxiliary);

  assert.equal(projection.id, auxiliary.id);
  assert.equal(projection.provider, auxiliary.provider);
  assert.equal(projection.model, auxiliary.model);
  assert.equal(projection.threadId, auxiliary.threadId);
  assert.deepEqual(projection.messages, auxiliary.messages);
  assert.deepEqual(projection.allowedAdditionalDirectories, auxiliary.allowedAdditionalDirectories);
  assert.notEqual(projection.allowedAdditionalDirectories, auxiliary.allowedAdditionalDirectories);
  assert.equal(projection.status, "active");
  assert.equal(projection.taskTitle, auxiliary.title);
  assert.equal(projection.characterRuntimeSnapshot, parent.characterRuntimeSnapshot);
  assert.equal("stream" in projection, false);
});

test("buildCompanionAuxiliaryRuntimeSession wraps companion runtime projection", () => {
  const parent = createCompanionSession();
  const auxiliary = createAuxiliarySession();

  assert.deepEqual(
    buildCompanionAuxiliaryRuntimeSession(parent, auxiliary),
    buildAuxiliaryRuntimeSessionProjection("companion", parent, auxiliary),
  );
});
