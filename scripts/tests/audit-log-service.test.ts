import assert from "node:assert/strict";
import test from "node:test";

import { AuditLogService } from "../../src-electron/audit-log-service.js";
import type { AuditLogEntry } from "../../src-shared/session/runtime-state.js";

type CreateAuditLogInput = Omit<AuditLogEntry, "id">;

function createInput(overrides: Partial<CreateAuditLogInput> = {}): CreateAuditLogInput {
  return {
    sessionId: "session-1",
    createdAt: "2026-03-28T00:00:00.000Z",
    phase: "running",
    provider: "codex",
    model: "gpt-5.4-mini",
    reasoningEffort: "medium",
    approvalMode: "untrusted",
    threadId: "thread-1",
    logicalPrompt: {
      systemText: "system",
      inputText: "input",
      composedText: "composed",
    },
    transportPayload: null,
    assistantText: "",
    operations: [],
    rawItemsJson: "[]",
    usage: null,
    errorMessage: "",
    ...overrides,
  };
}

// @test-value v2
// kind = "contract"
// claim = "AuditLogServiceのCRUDはstorageへ委譲し、返却値と呼び出し順を保持する"
// oracle = { type = "contract", ref = "audit log service storage boundary" }
// fault = "CRUDの引数・返却値・順序が変わり監査記録の保存または更新が欠落する"
// observable = "storage calls and awaited CRUD results"
// observation_boundary = "public-boundary"
// scope = "audit-log-service-crud"
// lifecycle = "permanent"
// @end-test-value
test("AuditLogService は storage の CRUD を委譲する", async () => {
  const calls: Array<
    | { type: "list"; payload: string }
    | { type: "create"; payload: CreateAuditLogInput }
    | { type: "update"; payload: { id: number; input: CreateAuditLogInput } }
    | { type: "clear"; payload: null }
  > = [];
  const createdEntry: AuditLogEntry = { id: 1, ...createInput() };
  const updatedEntry: AuditLogEntry = { id: 1, ...createInput({ phase: "completed" }) };

  const storage: ConstructorParameters<typeof AuditLogService>[0] = {
    async listSessionAuditLogs(sessionId: string): Promise<AuditLogEntry[]> {
      calls.push({ type: "list", payload: sessionId });
      return [createdEntry];
    },
    async createAuditLog(input: CreateAuditLogInput): Promise<AuditLogEntry> {
      calls.push({ type: "create", payload: input });
      return createdEntry;
    },
    async updateAuditLog(id: number, input: CreateAuditLogInput): Promise<AuditLogEntry> {
      calls.push({ type: "update", payload: { id, input } });
      return updatedEntry;
    },
    async clearAuditLogs(): Promise<void> {
      calls.push({ type: "clear", payload: null });
    },
  };
  const service = new AuditLogService(storage);

  assert.deepEqual(await service.listSessionAuditLogs("session-1"), [createdEntry]);
  const createInputValue = createInput();
  assert.equal((await service.createAuditLog(createInputValue)).id, 1);
  const updateInputValue = createInput({ phase: "completed" });
  assert.equal((await service.updateAuditLog(1, updateInputValue)).phase, "completed");
  await service.clearAuditLogs();

  assert.deepEqual(calls, [
    { type: "list", payload: "session-1" },
    { type: "create", payload: createInputValue },
    { type: "update", payload: { id: 1, input: updateInputValue } },
    { type: "clear", payload: null },
  ]);
});

