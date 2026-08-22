import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { SESSION_RUNTIME_OPERATIONS } from "../../src/session-external-runtime-contract.js";

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
