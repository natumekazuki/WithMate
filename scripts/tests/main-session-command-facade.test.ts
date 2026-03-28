import assert from "node:assert/strict";
import test from "node:test";

import { MainSessionCommandFacade } from "../../src-electron/main-session-command-facade.js";

test("MainSessionCommandFacade は create/update/delete/cancel を各 service に委譲する", () => {
  const calls: string[] = [];
  const facade = new MainSessionCommandFacade({
    getSession: () => null,
    getSessionPersistenceService: () =>
      ({
        createSession(input) {
          calls.push(`create:${input.id}`);
          return input as never;
        },
        updateSession(session) {
          calls.push(`update:${session.id}`);
          return session as never;
        },
        deleteSession(sessionId) {
          calls.push(`delete:${sessionId}`);
        },
      }) as never,
    getSessionRuntimeService: () =>
      ({
        cancelRun(sessionId) {
          calls.push(`cancel:${sessionId}`);
        },
      }) as never,
    getProviderQuotaTelemetry: () => null,
    isProviderQuotaTelemetryStale: () => false,
    refreshProviderQuotaTelemetry: async () => null,
  });

  facade.createSession({ id: "s-1" } as never);
  facade.updateSession({ id: "s-1" } as never);
  facade.deleteSession("s-1");
  facade.cancelSessionRun("s-1");

  assert.deepEqual(calls, ["create:s-1", "update:s-1", "delete:s-1", "cancel:s-1"]);
});

test("MainSessionCommandFacade は stale な Copilot quota を非同期更新して run を委譲する", async () => {
  const calls: string[] = [];
  let refreshedProviderId: string | null = null;
  const facade = new MainSessionCommandFacade({
    getSession: () => ({ id: "s-1", provider: "copilot" }) as never,
    getSessionPersistenceService: () => ({} as never),
    getSessionRuntimeService: () =>
      ({
        async runSessionTurn(sessionId) {
          calls.push(`run:${sessionId}`);
          return { id: sessionId } as never;
        },
      }) as never,
    getProviderQuotaTelemetry: () => ({ providerId: "copilot", updatedAt: "old" } as never),
    isProviderQuotaTelemetryStale: () => true,
    refreshProviderQuotaTelemetry: async (providerId) => {
      refreshedProviderId = providerId;
      return null;
    },
  });

  const result = await facade.runSessionTurn("s-1", { userMessage: "hello" } as never);

  assert.equal(result.id, "s-1");
  assert.equal(refreshedProviderId, "copilot");
  assert.deepEqual(calls, ["run:s-1"]);
});

test("MainSessionCommandFacade は non-Copilot session では quota refresh を行わない", async () => {
  let refreshed = false;
  const facade = new MainSessionCommandFacade({
    getSession: () => ({ id: "s-1", provider: "codex" }) as never,
    getSessionPersistenceService: () => ({} as never),
    getSessionRuntimeService: () =>
      ({
        async runSessionTurn(sessionId) {
          return { id: sessionId } as never;
        },
      }) as never,
    getProviderQuotaTelemetry: () => null,
    isProviderQuotaTelemetryStale: () => true,
    refreshProviderQuotaTelemetry: async () => {
      refreshed = true;
      return null;
    },
  });

  await facade.runSessionTurn("s-1", { userMessage: "hello" } as never);

  assert.equal(refreshed, false);
});
