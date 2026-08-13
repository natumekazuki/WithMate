import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { SESSION_RUNTIME_OPERATIONS } from "../../src/session-external-runtime-contract.js";

const skillRoot = path.resolve("resources", "skills", "withmate-session");

describe("withmate-session managed Skill contract", () => {
  it("installed packaged CLIとMCP entryを使いsource checkout helperへ依存しない", async () => {
    const skill = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
    const operations = await readFile(path.join(skillRoot, "references", "operations.md"), "utf8");

    assert.match(skill, /installed `withmate-session` command/);
    assert.match(skill, /withmate-session mcp-server/);
    assert.match(operations, /WindowsApps alias/);
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
