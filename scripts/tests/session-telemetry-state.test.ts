import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderQuotaTelemetry, SessionContextTelemetry } from "../../src/app-state.js";
import {
  resolveOwnedProviderQuotaTelemetry,
  resolveOwnedSessionContextTelemetry,
} from "../../src/session-telemetry-state.js";

const providerTelemetry: ProviderQuotaTelemetry = {
  provider: "codex",
  updatedAt: "2026-05-31T00:00:00.000Z",
  snapshots: [],
};

const sessionTelemetry: SessionContextTelemetry = {
  provider: "codex",
  sessionId: "session-1",
  updatedAt: "2026-05-31T00:00:00.000Z",
  tokenLimit: 1000,
  currentTokens: 120,
  messagesLength: 3,
};

test("resolveOwnedProviderQuotaTelemetry は owner provider が一致する telemetry だけ返す", () => {
  assert.equal(
    resolveOwnedProviderQuotaTelemetry(
      { ownerProviderId: "codex", telemetry: providerTelemetry },
      "codex",
    ),
    providerTelemetry,
  );
  assert.equal(
    resolveOwnedProviderQuotaTelemetry(
      { ownerProviderId: "codex", telemetry: providerTelemetry },
      "copilot",
    ),
    null,
  );
  assert.equal(
    resolveOwnedProviderQuotaTelemetry(
      { ownerProviderId: "codex", telemetry: providerTelemetry },
      null,
    ),
    null,
  );
  assert.equal(
    resolveOwnedProviderQuotaTelemetry(
      { ownerProviderId: "codex", telemetry: providerTelemetry },
      undefined,
    ),
    null,
  );
});

test("resolveOwnedSessionContextTelemetry は owner session が一致する telemetry だけ返す", () => {
  assert.equal(
    resolveOwnedSessionContextTelemetry(
      { ownerSessionId: "session-1", telemetry: sessionTelemetry },
      "session-1",
    ),
    sessionTelemetry,
  );
  assert.equal(
    resolveOwnedSessionContextTelemetry(
      { ownerSessionId: "session-1", telemetry: sessionTelemetry },
      "session-2",
    ),
    null,
  );
  assert.equal(
    resolveOwnedSessionContextTelemetry(
      { ownerSessionId: "session-1", telemetry: sessionTelemetry },
      null,
    ),
    null,
  );
  assert.equal(
    resolveOwnedSessionContextTelemetry(
      { ownerSessionId: "session-1", telemetry: sessionTelemetry },
      undefined,
    ),
    null,
  );
});
