import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { discoverSessionSkills } from "../../src-electron/skills/skill-discovery.js";

const createdDirectories: string[] = [];

/** 探索元ごとに独立した一時ディレクトリを作り、後片付けの対象に登録する。 */
function createTempDir(): string {
  const directoryPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "withmate-skill-discovery-"),
  );
  createdDirectories.push(directoryPath);
  return directoryPath;
}

/** 名前と説明をフロントマターに持つ最小のスキル定義を指定ルートへ置く。 */
function writeSkill(
  rootPath: string,
  skillName: string,
  description: string,
): void {
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

/** 同一パスでも変更が判別できるよう、ファイルの時刻を明示的に進める。 */
function touchFile(filePath: string): void {
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(filePath, future, future);
}

/** 成功・失敗にかかわらず、ケース内で作った探索元だけを取り除く。 */
afterEach(() => {
  while (createdDirectories.length > 0) {
    const directoryPath = createdDirectories.pop();
    if (directoryPath && fs.existsSync(directoryPath)) {
      fs.rmSync(directoryPath, { recursive: true, force: true });
    }
  }
});

/** スキル探索の候補元、同名時の優先順位、定義の再読込条件を検証する。 */
describe("discoverSessionSkills", () => {
  /** workspace と provider の別名スキルが、出所を区別した一覧に共存することを確認する。 */
  it("workspace roots と provider root をまとめて列挙できる", async () => {
    const workspacePath = createTempDir();
    const providerRootPath = createTempDir();
    const workspaceSkillRootPath = path.join(workspacePath, "skills");
    fs.mkdirSync(workspaceSkillRootPath, { recursive: true });
    writeSkill(workspaceSkillRootPath, "docs-sync", "workspace skill");
    writeSkill(providerRootPath, "provider-helper", "provider skill");

    const skills = await discoverSessionSkills(workspacePath, providerRootPath);

    assert.equal(skills.length, 2);
    assert.equal(skills[0]?.name, "docs-sync");
    assert.equal(skills[0]?.source, "workspace");
    assert.equal(skills[1]?.name, "provider-helper");
    assert.equal(skills[1]?.source, "provider");
  });

  /** provider にも同名の定義がある場合は、workspace 側のパスを持つ一件だけを残す。 */
  it("同名 skill は workspace を優先する", async () => {
    const workspacePath = createTempDir();
    const providerRootPath = createTempDir();
    const workspaceSkillRootPath = path.join(
      workspacePath,
      ".github",
      "skills",
    );
    fs.mkdirSync(workspaceSkillRootPath, { recursive: true });
    writeSkill(workspaceSkillRootPath, "docs-sync", "workspace version");
    writeSkill(providerRootPath, "docs-sync", "provider version");

    const skills = await discoverSessionSkills(workspacePath, providerRootPath);

    assert.equal(skills.length, 1);
    assert.equal(skills[0]?.name, "docs-sync");
    assert.equal(skills[0]?.source, "workspace");
    assert.match(skills[0]?.sourcePath ?? "", /\.github\/skills\/docs-sync$/);
  });

  /** 隠しディレクトリ配下の定義も workspace 由来として列挙されることを確認する。 */
  it(".agents/skills の workspace skill を列挙できる", async () => {
    const workspacePath = createTempDir();
    const providerRootPath = createTempDir();
    const workspaceSkillRootPath = path.join(
      workspacePath,
      ".agents",
      "skills",
    );
    fs.mkdirSync(workspaceSkillRootPath, { recursive: true });
    writeSkill(workspaceSkillRootPath, "docs-sync", "workspace version");

    const skills = await discoverSessionSkills(workspacePath, providerRootPath);

    assert.equal(skills.length, 1);
    assert.equal(skills[0]?.name, "docs-sync");
    assert.equal(skills[0]?.source, "workspace");
    assert.match(skills[0]?.sourcePath ?? "", /\.agents\/skills\/docs-sync$/);
  });

  /** 変更なしで二度探索し、ファイル読込を計数して初回の一度しか発生しないことを確認する。 */
  it("変更がない discovery は Markdown 再読込を避ける", async () => {
    const workspacePath = createTempDir();
    const providerRootPath = createTempDir();
    const workspaceSkillRootPath = path.join(workspacePath, "skills");
    fs.mkdirSync(workspaceSkillRootPath, { recursive: true });
    writeSkill(workspaceSkillRootPath, "docs-sync", "workspace skill");

    const mutableFsPromises = fs.promises as unknown as {
      readFile: (...args: any[]) => Promise<any>;
    };
    const originalReadFile = mutableFsPromises.readFile;
    let readCount = 0;
    mutableFsPromises.readFile = async (...args: any[]) => {
      readCount += 1;
      return originalReadFile(...args);
    };

    try {
      await discoverSessionSkills(workspacePath, providerRootPath);
      await discoverSessionSkills(workspacePath, providerRootPath);
    } finally {
      mutableFsPromises.readFile = originalReadFile;
    }

    assert.equal(readCount, 1);
  });

  /** 同じファイルの説明と更新時刻を変更すると、次の探索に新しい説明が反映されることを確認する。 */
  it("SKILL.md の mtime 変更で cache を更新する", async () => {
    const workspacePath = createTempDir();
    const providerRootPath = createTempDir();
    const workspaceSkillRootPath = path.join(workspacePath, "skills");
    fs.mkdirSync(workspaceSkillRootPath, { recursive: true });
    writeSkill(workspaceSkillRootPath, "docs-sync", "before");
    const skillFilePath = path.join(
      workspaceSkillRootPath,
      "docs-sync",
      "SKILL.md",
    );

    assert.equal(
      (await discoverSessionSkills(workspacePath, providerRootPath))[0]
        ?.description,
      "before",
    );

    fs.writeFileSync(
      skillFilePath,
      [
        "---",
        "name: docs-sync",
        "description: after",
        "---",
        "",
        "# docs-sync",
      ].join("\n"),
      "utf8",
    );
    touchFile(skillFilePath);

    assert.equal(
      (await discoverSessionSkills(workspacePath, providerRootPath))[0]
        ?.description,
      "after",
    );
  });
});
