import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { discoverSessionSkills } from "../../src-electron/skill-discovery.js";

const createdDirectories: string[] = [];

function createTempDir(): string {
  const directoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "withmate-skill-discovery-"));
  createdDirectories.push(directoryPath);
  return directoryPath;
}

function writeSkill(rootPath: string, skillName: string, description: string): void {
  const skillDirectoryPath = path.join(rootPath, skillName);
  fs.mkdirSync(skillDirectoryPath, { recursive: true });
  fs.writeFileSync(
    path.join(skillDirectoryPath, "SKILL.md"),
    [
      "---",
      `name: ${skillName}`,
      `description: ${description}`,
      "---",
      "",
      `# ${skillName}`,
    ].join("\n"),
    "utf8",
  );
}

afterEach(() => {
  while (createdDirectories.length > 0) {
    const directoryPath = createdDirectories.pop();
    if (directoryPath && fs.existsSync(directoryPath)) {
      fs.rmSync(directoryPath, { recursive: true, force: true });
    }
  }
});

describe("discoverSessionSkills", () => {
  it("workspace roots と provider root をまとめて列挙できる", () => {
    const workspacePath = createTempDir();
    const providerRootPath = createTempDir();
    const workspaceSkillRootPath = path.join(workspacePath, "skills");
    fs.mkdirSync(workspaceSkillRootPath, { recursive: true });
    writeSkill(workspaceSkillRootPath, "docs-sync", "workspace skill");
    writeSkill(providerRootPath, "provider-helper", "provider skill");

    const skills = discoverSessionSkills(workspacePath, providerRootPath);

    assert.equal(skills.length, 2);
    assert.equal(skills[0]?.name, "docs-sync");
    assert.equal(skills[0]?.source, "workspace");
    assert.equal(skills[1]?.name, "provider-helper");
    assert.equal(skills[1]?.source, "provider");
  });

  it("同名 skill は workspace を優先する", () => {
    const workspacePath = createTempDir();
    const providerRootPath = createTempDir();
    const workspaceSkillRootPath = path.join(workspacePath, ".github", "skills");
    fs.mkdirSync(workspaceSkillRootPath, { recursive: true });
    writeSkill(workspaceSkillRootPath, "docs-sync", "workspace version");
    writeSkill(providerRootPath, "docs-sync", "provider version");

    const skills = discoverSessionSkills(workspacePath, providerRootPath);

    assert.equal(skills.length, 1);
    assert.equal(skills[0]?.name, "docs-sync");
    assert.equal(skills[0]?.source, "workspace");
    assert.match(skills[0]?.sourcePath ?? "", /\.github\/skills\/docs-sync$/);
  });
});
