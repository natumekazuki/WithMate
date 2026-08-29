import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { SESSION_RUNTIME_OPERATIONS } from "../../src/session-external-runtime-contract.js";
import {
  WORK_ITEM_AGGREGATION_MAX_LIST_LIMIT,
  WORK_ITEM_MAX_LIST_LIMIT,
} from "../../src/work-item.js";

const skillRoot = path.resolve("resources", "skills", "withmate-session");

describe("withmate-session managed Skill contract", () => {
  it("host設定済みMCPを優先しstdio entryを通常shell commandとして実行しない", async () => {
    const skill = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
    const operations = await readFile(path.join(skillRoot, "references", "operations.md"), "utf8");
    const openaiYaml = await readFile(path.join(skillRoot, "agents", "openai.yaml"), "utf8");

    assert.match(skill, /MCP tools that the Codex host has already exposed/);
    assert.match(skill, /Never start `withmate-session mcp-server` through a shell/);
    assert.match(skill, /specifically requires MCP, stop until the MCP tools are available/);
    assert.match(skill, /only when the user explicitly permits CLI fallback/);
    assert.match(skill, /new Codex Session or restart Codex/);
    assert.match(openaiYaml, /type: "mcp"[\s\S]*?value: "withmate-session"/);
    assert.match(operations, /does not create or overwrite a shared WindowsApps alias/);
    assert.doesNotMatch(operations, /```powershell[\s\S]*?withmate-session mcp-server[\s\S]*?```/);
    assert.doesNotMatch(`${skill}\n${operations}`, /node(?:\.exe)?\s+scripts[\\/]withmate-session/);
    assert.doesNotMatch(`${skill}\n${operations}`, /node_modules/);
  });

  it("Agent間TurnのRole/hierarchy authority matrixを配布Skillとreferenceへ同期する", async () => {
    const skill = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
    const operations = await readFile(path.join(skillRoot, "references", "operations.md"), "utf8");
    const contract = `${skill}\n${operations}`;

    assert.match(contract, /sessionTurnCommunicationContractRevision/);
    assert.match(contract, /standalone actor may target only itself/);
    assert.match(contract, /overall coordinator may target itself or a direct task coordinator or executor child/);
    assert.match(contract, /sibling task coordinator with the same root and parent/);
    assert.match(contract, /executor may target only itself or its direct parent/);
    assert.match(contract, /Trusted GUI messages are a separate user-invocation boundary/);
  });

  it("authority、discovery、retry、queue、interaction、file、handoff contractを保持する", async () => {
    const skill = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
    const operations = await readFile(path.join(skillRoot, "references", "operations.md"), "utf8");
    const contract = `${skill}\n${operations}`;

    for (const required of [
      "Codex subagents",
      "sessionId",
      "runtime.catalog",
      "session.self",
      "turn.options",
      "turn.run",
      "turn.enqueue",
      "idempotency",
      "effect: indeterminate",
      "wait timeout",
      "interaction",
      "SessionFolder-relative",
      "canonical JSON",
      "destination Session",
      "adoption candidate",
    ]) {
      assert.match(contract, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), required);
    }
  });

  it("DECOMP-POLICY-01: no-split、直属executor、task coordinatorの選択基準を案内する", async () => {
    const skill = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");

    assert.match(skill, /Do not decompose a single coherent responsibility[\s\S]*complete and verify directly/);
    assert.match(skill, /direct `executor` child for one independent delegation/);
    assert.match(skill, /direct `task-coordinator` only when one task needs multiple slices, dependency management, integration, or review convergence/);
    assert.match(skill, /`task-coordinator` decomposes only to its direct `executor` children/);
    assert.match(skill, /maximum depth is an enforcement limit, not a policy target/);
    assert.match(skill, /minimum number of children needed[\s\S]*Do not invent a fixed decomposition or parallelism limit/);
  });

  it("DECOMP-BOUNDARY-02: coherentな子とfail-closedな強制境界を分離する", async () => {
    const skill = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
    const operations = await readFile(path.join(skillRoot, "references", "operations.md"), "utf8");
    const contract = `${skill}\n${operations}`;

    assert.match(skill, /Agent owns the work-decomposition policy\. WithMate owns the enforced Role hierarchy, authority, Session and Work Item state, Turn admission, and aggregation contract/);
    assert.match(skill, /one coherent delegation with an explicit goal, scope, completion criteria, authority, and source identity/);
    assert.match(skill, /Keep sibling scopes non-overlapping and assign integration ownership/);
    assert.match(contract, /Do not bypass[\s\S]*free-form Turn[\s\S]*another root[\s\S]*caller-asserted/);
    assert.match(operations, /Decomposition is an Agent policy over existing operations, not a separate runtime resource or operation/);
  });

  it("DECOMP-RECOVERY-03: operation別keyとpartial successからの再開を案内する", async () => {
    const skill = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
    const operations = await readFile(path.join(skillRoot, "references", "operations.md"), "utf8");
    const contract = `${skill}\n${operations}`;

    assert.match(skill, /`session.create` with a caller-owned idempotency key[\s\S]*`session.get`/);
    assert.match(skill, /`work.create` with a different idempotency key/);
    assert.match(skill, /`turn.run` or `turn.enqueue`[\s\S]*a separate key/);
    assert.match(contract, /not an atomic batch/);
    assert.match(contract, /resume the same decomposition plan from the failed step/);
    assert.match(contract, /rather than creating a duplicate Session/);
    assert.match(contract, /response loss or `effect: indeterminate`[\s\S]*Replay only the unchanged operation with its original key/);
    assert.match(contract, /do not convert a failed `turn\.run` into `turn\.enqueue`/);
  });

  it("DECOMP-INTEGRATE-04: 依存順、明示result、直属子集約、親finalizationまで閉じる", async () => {
    const skill = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
    const operations = await readFile(path.join(skillRoot, "references", "operations.md"), "utf8");
    const contract = `${skill}\n${operations}`;

    assert.match(contract, /Parallel dispatch is valid only for independent children/);
    assert.match(contract, /dependent work after the parent coordinator validates and decides the prerequisite result/);
    assert.match(contract, /execution terminal state is not Work Item terminal state/);
    assert.match(contract, /parent Work Item's target coordinator[\s\S]*only its direct children/);
    assert.match(contract, /`accepted`, `excluded`, or `retry_requested`[\s\S]*strict parent result/);
    assert.match(contract, /overall coordinator does not flatten grandchildren/);
  });

  it("blockerへの回答、consume、解決を別の状態遷移として案内する", async () => {
    const skill = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
    const operations = await readFile(path.join(skillRoot, "references", "operations.md"), "utf8");

    assert.match(skill, /trusted GUI response to a blocker does not resolve it/i);
    assert.match(operations, /recorded as a `responded` action and does not resolve the blocker/);
    assert.match(operations, /only the actor-owned Agent may resolve it/);
    assert.match(operations, /remains editable until the owner Session consumes it/);
    assert.match(operations, /Consumption confirms the exact response revision[\s\S]*it does not change blocker state/);
  });

  it("referenceの公開operation集合をruntime contractと双方向一致させる", async () => {
    const operations = await readFile(path.join(skillRoot, "references", "operations.md"), "utf8");
    const publicOperationsSection = operations.match(
      /## Public operations\s+([\s\S]*?)\s+CLI dotted names/,
    )?.[1];
    assert.ok(publicOperationsSection, "Public operations section is required");
    const documentedOperations = [...publicOperationsSection.matchAll(/`([a-z][a-z_.]+)`/g)]
      .map((match) => match[1])
      .sort();

    assert.deepEqual(documentedOperations, [...SESSION_RUNTIME_OPERATIONS].sort());
  });

  it("runbookとreferenceのoperation数・Work Item list上限をruntime contractへ同期する", async () => {
    const runbook = await readFile(path.resolve("docs", "runbooks", "session-cli.md"), "utf8");
    const operations = await readFile(path.join(skillRoot, "references", "operations.md"), "utf8");
    const aggregationOperations = SESSION_RUNTIME_OPERATIONS.filter((operation) => operation.startsWith("work.aggregation."));

    assert.match(runbook, new RegExp(`公開toolは計${SESSION_RUNTIME_OPERATIONS.length}操作`));
    for (const operation of aggregationOperations) {
      assert.match(runbook, new RegExp("`" + operation.replaceAll(".", "\\.") + "`"), operation);
    }
    assert.match(
      operations,
      new RegExp(`Work Item lists[^\\n]*maximum of ${WORK_ITEM_MAX_LIST_LIMIT}`),
    );
    assert.equal(WORK_ITEM_AGGREGATION_MAX_LIST_LIMIT, WORK_ITEM_MAX_LIST_LIMIT);
  });

  it("packaged resourceを起動時と設定保存後に同期する", async () => {
    const mainSource = await readFile(path.resolve("src-electron", "main.ts"), "utf8");

    assert.match(
      mainSource,
      /process\.resourcesPath, "resources", "skills", WITHMATE_SESSION_SKILL_NAME/,
    );
    assert.match(
      mainSource,
      /async function updateAppSettings[\s\S]*?void syncManagedSessionSkillBestEffort\(\)[\s\S]*?return savedSettings;/,
    );
    assert.match(
      mainSource,
      /requireMainBootstrapService\(\)\.handleReady\(\)[\s\S]*?void syncManagedSessionSkillBestEffort\(\)[\s\S]*?publishAppBootStatus/,
    );
  });
});
