import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { discoverSessionCustomAgents, resolveSessionCustomAgentConfigs } from "../../src-electron/custom-agent-discovery.js";

const createdDirectories: string[] = [];

function createTempDir(): string {
  const directoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "withmate-custom-agent-discovery-"));
  createdDirectories.push(directoryPath);
  return directoryPath;
}

function writeCustomAgent(
  rootPath: string,
  fileName: string,
  {
    name,
    displayName,
    description,
    userInvocable,
    prompt,
  }: { name?: string; displayName?: string; description?: string; userInvocable?: boolean; prompt: string },
): void {
  fs.mkdirSync(rootPath, { recursive: true });
  const frontmatterLines = [
    "---",
    ...(name ? [`name: ${name}`] : []),
    ...(displayName ? [`displayName: ${displayName}`] : []),
    ...(description ? [`description: ${description}`] : []),
    ...(typeof userInvocable === "boolean" ? [`user-invocable: ${userInvocable ? "true" : "false"}`] : []),
    "---",
    "",
  ];
  fs.writeFileSync(
    path.join(rootPath, `${fileName}.agent.md`),
    [...frontmatterLines, prompt].join("\n"),
    "utf8",
  );
}

function touchFile(filePath: string): void {
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(filePath, future, future);
}

afterEach(() => {
  while (createdDirectories.length > 0) {
    const directoryPath = createdDirectories.pop();
    if (directoryPath && fs.existsSync(directoryPath)) {
      fs.rmSync(directoryPath, { recursive: true, force: true });
    }
  }
});

describe("discoverSessionCustomAgents", () => {
  it("workspace root と global root をまとめて列挙できる", async () => {
    const workspacePath = createTempDir();
    const homeDirectory = createTempDir();
    writeCustomAgent(path.join(workspacePath, ".github", "agents"), "reviewer", {
      displayName: "Reviewer",
      description: "workspace agent",
      userInvocable: true,
      prompt: "Review the code carefully.",
    });
    writeCustomAgent(path.join(homeDirectory, ".copilot", "agents"), "refactor", {
      displayName: "Refactorer",
      description: "global agent",
      userInvocable: true,
      prompt: "Refactor the code safely.",
    });

    const agents = await discoverSessionCustomAgents(workspacePath, homeDirectory);

    assert.equal(agents.length, 2);
    assert.equal(agents[0]?.source, "workspace");
    assert.equal(agents[0]?.displayName, "Reviewer");
    assert.equal(agents[1]?.source, "global");
    assert.equal(agents[1]?.displayName, "Refactorer");
  });

  it("同名 agent は workspace を優先する", async () => {
    const workspacePath = createTempDir();
    const homeDirectory = createTempDir();
    writeCustomAgent(path.join(workspacePath, ".github", "agents"), "reviewer", {
      name: "reviewer",
      displayName: "Workspace Reviewer",
      userInvocable: true,
      prompt: "workspace prompt",
    });
    writeCustomAgent(path.join(homeDirectory, ".copilot", "agents"), "reviewer", {
      name: "reviewer",
      displayName: "Global Reviewer",
      userInvocable: true,
      prompt: "global prompt",
    });

    const agents = await discoverSessionCustomAgents(workspacePath, homeDirectory);
    const resolved = resolveSessionCustomAgentConfigs(workspacePath, "reviewer", homeDirectory);

    assert.equal(agents.length, 1);
    assert.equal(agents[0]?.source, "workspace");
    assert.equal(resolved.selectedAgentName, "reviewer");
    assert.equal(resolved.customAgents[0]?.displayName, "Workspace Reviewer");
    assert.equal(resolved.customAgents[0]?.prompt, "workspace prompt");
  });

  it("picker には user-invocable: true の agent だけを出す", async () => {
    const workspacePath = createTempDir();
    const homeDirectory = createTempDir();
    writeCustomAgent(path.join(workspacePath, ".github", "agents"), "reviewer", {
      displayName: "Reviewer",
      userInvocable: true,
      prompt: "workspace prompt",
    });
    writeCustomAgent(path.join(workspacePath, ".github", "agents"), "hidden", {
      displayName: "Hidden Agent",
      userInvocable: false,
      prompt: "hidden prompt",
    });
    writeCustomAgent(path.join(homeDirectory, ".copilot", "agents"), "implicit-hidden", {
      displayName: "Implicit Hidden",
      prompt: "implicit hidden prompt",
    });

    const agents = await discoverSessionCustomAgents(workspacePath, homeDirectory);
    const resolved = resolveSessionCustomAgentConfigs(workspacePath, "hidden", homeDirectory);

    assert.deepEqual(agents.map((agent) => agent.displayName), ["Reviewer"]);
    assert.equal(resolved.customAgents.length, 3);
    assert.equal(resolved.selectedAgentName, "hidden");
  });

  it("変更がない discovery は Markdown 再読込を避ける", async () => {
    const workspacePath = createTempDir();
    const homeDirectory = createTempDir();
    writeCustomAgent(path.join(workspacePath, ".github", "agents"), "reviewer", {
      displayName: "Reviewer",
      userInvocable: true,
      prompt: "workspace prompt",
    });

    const mutableFs = fs as unknown as { readFileSync: (...args: any[]) => any };
    const mutableFsPromises = fs.promises as unknown as { readFile: (...args: any[]) => Promise<any> };
    const originalReadFileSync = mutableFs.readFileSync;
    const originalReadFile = mutableFsPromises.readFile;
    let readCount = 0;
    mutableFs.readFileSync = (...args: any[]) => {
      readCount += 1;
      return originalReadFileSync(...args);
    };
    mutableFsPromises.readFile = async (...args: any[]) => {
      readCount += 1;
      return originalReadFile(...args);
    };

    try {
      await discoverSessionCustomAgents(workspacePath, homeDirectory);
      resolveSessionCustomAgentConfigs(workspacePath, "reviewer", homeDirectory);
    } finally {
      mutableFs.readFileSync = originalReadFileSync;
      mutableFsPromises.readFile = originalReadFile;
    }

    assert.equal(readCount, 1);
  });

  it(".agent.md の mtime 変更で cache を更新する", async () => {
    const workspacePath = createTempDir();
    const homeDirectory = createTempDir();
    const agentRootPath = path.join(workspacePath, ".github", "agents");
    writeCustomAgent(agentRootPath, "reviewer", {
      displayName: "Reviewer",
      description: "before",
      userInvocable: true,
      prompt: "workspace prompt",
    });
    const agentFilePath = path.join(agentRootPath, "reviewer.agent.md");

    assert.equal((await discoverSessionCustomAgents(workspacePath, homeDirectory))[0]?.description, "before");

    writeCustomAgent(agentRootPath, "reviewer", {
      displayName: "Reviewer",
      description: "after",
      userInvocable: true,
      prompt: "workspace prompt",
    });
    touchFile(agentFilePath);

    assert.equal((await discoverSessionCustomAgents(workspacePath, homeDirectory))[0]?.description, "after");
  });
});
