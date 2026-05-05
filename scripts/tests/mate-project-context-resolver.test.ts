import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildNewSession } from "../../src/app-state.js";
import type { Session } from "../../src/session-state.js";
import type { MateProjectDigest } from "../../src-electron/mate-project-digest-storage.js";
import type { MateStorageState } from "../../src/mate-state.js";
import {
  resolveMateProjectContextTextForPrompt,
  resolveMateProjectDigestForSession,
} from "../../src-electron/mate-project-context-resolver.js";

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    ...buildNewSession({
      taskTitle: "Resolver Test",
      workspaceLabel: "resolver-workspace",
      workspacePath: "/tmp/resolver-workspace",
      branch: "main",
      characterId: "character-a",
      character: "Resolver",
      characterIconPath: "",
      characterThemeColors: { main: "#6f8cff", sub: "#6fb8c7" },
      approvalMode: "untrusted",
    }),
    ...overrides,
  };
}

const ACTIVE_MATE_STATE: MateStorageState = "active";
const NOT_CREATED_MATE_STATE: MateStorageState = "not_created";

describe("resolveMateProjectDigestForSession", () => {
  it("Mate 未作成なら null を返す", () => {
    let calledWorkspacePath: string | null = null;
    const session = createSession();
    const digest = resolveMateProjectDigestForSession({
      session,
      getMateState: () => NOT_CREATED_MATE_STATE,
      resolveProjectDigestForWorkspace: (workspacePath) => {
        calledWorkspacePath = workspacePath;
        return null;
      },
    });

    assert.equal(digest, null);
    assert.equal(calledWorkspacePath, null);
  });

  it("resolveProjectDigestForWorkspace 例外時は warn して null を返す", () => {
    let warned = false;
    const session = createSession();
    const digest = resolveMateProjectDigestForSession({
      session,
      getMateState: () => ACTIVE_MATE_STATE,
      resolveProjectDigestForWorkspace: () => {
        throw new Error("digest failed");
      },
      logWarning: (..._args) => {
        warned = true;
      },
    });

    assert.equal(digest, null);
    assert.equal(warned, true);
  });
});

describe("resolveMateProjectContextTextForPrompt", () => {
  it("workspace から digest を解決し、userMessage を queryText として context service に渡す", async () => {
    const session = createSession({ id: "session-1" });
    const expectedDigest: MateProjectDigest = {
      id: "digest-1",
      mateId: "current",
      projectType: "git",
      projectKey: "git:resolver",
      workspacePath: "/tmp/resolver-workspace",
      gitRoot: "/tmp/resolver-workspace/.git",
      displayName: "resolver",
      digestFilePath: "/tmp/resolver-workspace/.withmate/digest.json",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const userMessage = "このファイルの問題点は？";
    let resolvedWorkspacePath: string | null = null;
    let resolvedQueryText: string | null = null;
    const contextText = "Project Digest:\n- context";

    const resolved = await resolveMateProjectContextTextForPrompt({
      session,
      userMessage,
      getMateState: () => ACTIVE_MATE_STATE,
      resolveProjectDigestForWorkspace: (workspacePath) => {
        resolvedWorkspacePath = workspacePath;
        return expectedDigest;
      },
      getProjectDigestContextText: async (_projectDigestId, options) => {
        resolvedQueryText = options.queryText;
        return contextText;
      },
    });

    assert.equal(resolvedWorkspacePath, session.workspacePath);
    assert.equal(resolvedQueryText, userMessage);
    assert.equal(resolved, contextText);
  });

  it("digest が null なら null を返し context service を呼ばない", async () => {
    const session = createSession({ id: "session-2" });
    let calledContext = false;

    const resolved = await resolveMateProjectContextTextForPrompt({
      session,
      userMessage: "unused",
      getMateState: () => ACTIVE_MATE_STATE,
      resolveProjectDigestForWorkspace: () => null,
      getProjectDigestContextText: async () => {
        calledContext = true;
        return "context";
      },
    });

    assert.equal(resolved, null);
    assert.equal(calledContext, false);
  });

  it("context service 例外時は warn して null を返す", async () => {
    const session = createSession({ id: "session-3" });
    const digest: MateProjectDigest = {
      id: "digest-2",
      mateId: "current",
      projectType: "git",
      projectKey: "git:resolver",
      workspacePath: "/tmp/resolver-workspace",
      gitRoot: "/tmp/resolver-workspace/.git",
      displayName: "resolver",
      digestFilePath: "/tmp/resolver-workspace/.withmate/digest.json",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    let warned = false;
    const resolved = await resolveMateProjectContextTextForPrompt({
      session,
      userMessage: "warn this",
      getMateState: () => ACTIVE_MATE_STATE,
      resolveProjectDigestForWorkspace: () => digest,
      getProjectDigestContextText: async () => {
        throw new Error("context failed");
      },
      logWarning: (..._args) => {
        warned = true;
      },
    });

    assert.equal(resolved, null);
    assert.equal(warned, true);
  });
});
