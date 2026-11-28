import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  discoverSessionCustomAgents,
  resolveSessionCustomAgentConfigs,
} from "../../src-electron/skills/custom-agent-discovery.js";

const createdDirectories: string[] = [];

/** 実際の探索に使う一時ルートを作り、後片付けの対象に加える。 */
function createTempDir(): string {
  const directoryPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "withmate-custom-agent-discovery-"),
  );
  createdDirectories.push(directoryPath);
  return directoryPath;
}

/** 指定したメタデータだけを含むエージェント定義を、探索対象の Markdown として保存する。 */
function writeCustomAgent(
  rootPath: string,
  fileName: string,
  {
    name,
    displayName,
    description,
    userInvocable,
    prompt,
  }: {
    name?: string;
    displayName?: string;
    description?: string;
    userInvocable?: boolean;
    prompt: string;
  },
): void {
  fs.mkdirSync(rootPath, { recursive: true });
  const frontmatterLines = [
    "---",
    ...(name ? [`name: ${name}`] : []),
    ...(displayName ? [`displayName: ${displayName}`] : []),
    ...(description ? [`description: ${description}`] : []),
    ...(typeof userInvocable === "boolean"
      ? [`user-invocable: ${userInvocable ? "true" : "false"}`]
      : []),
    "---",
    "",
  ];
  fs.writeFileSync(
    path.join(rootPath, `${fileName}.agent.md`),
    [...frontmatterLines, prompt].join("\n"),
    "utf8",
  );
}

/** 短時間の書き換えでも更新を観測できるよう、mtime を明示的に進める。 */
function touchFile(filePath: string): void {
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(filePath, future, future);
}

/** 各ケースが作った探索ルートを取り除く。 */
afterEach(() => {
  while (createdDirectories.length > 0) {
    const directoryPath = createdDirectories.pop();
    if (directoryPath && fs.existsSync(directoryPath)) {
      fs.rmSync(directoryPath, { recursive: true, force: true });
    }
  }
});

/** エージェント定義の探索範囲、選択可否、キャッシュ更新を実ファイルで確認する。 */
describe("discoverSessionCustomAgents", () => {
  /** ワークスペースとホームの双方から探索し、各候補に出所を付ける。 */
  it("workspace root と global root をまとめて列挙できる", async () => {
    const workspacePath = createTempDir();
    const homeDirectory = createTempDir();
    writeCustomAgent(
      path.join(workspacePath, ".github", "agents"),
      "reviewer",
      {
        displayName: "Reviewer",
        description: "workspace agent",
        userInvocable: true,
        prompt: "Review the code carefully.",
      },
    );
    writeCustomAgent(
      path.join(homeDirectory, ".copilot", "agents"),
      "refactor",
      {
        displayName: "Refactorer",
        description: "global agent",
        userInvocable: true,
        prompt: "Refactor the code safely.",
      },
    );

    const agents = await discoverSessionCustomAgents(
      workspacePath,
      homeDirectory,
    );

    assert.equal(agents.length, 2);
    assert.equal(agents[0]?.source, "workspace");
    assert.equal(agents[0]?.displayName, "Reviewer");
    assert.equal(agents[1]?.source, "global");
    assert.equal(agents[1]?.displayName, "Refactorer");
  });

  /** 名前が衝突した場合は一覧と実行時のプロンプトの両方でワークスペース定義を採用する。 */
  it("同名 agent は workspace を優先する", async () => {
    const workspacePath = createTempDir();
    const homeDirectory = createTempDir();
    writeCustomAgent(
      path.join(workspacePath, ".github", "agents"),
      "reviewer",
      {
        name: "reviewer",
        displayName: "Workspace Reviewer",
        userInvocable: true,
        prompt: "workspace prompt",
      },
    );
    writeCustomAgent(
      path.join(homeDirectory, ".copilot", "agents"),
      "reviewer",
      {
        name: "reviewer",
        displayName: "Global Reviewer",
        userInvocable: true,
        prompt: "global prompt",
      },
    );

    const agents = await discoverSessionCustomAgents(
      workspacePath,
      homeDirectory,
    );
    const resolved = resolveSessionCustomAgentConfigs(
      workspacePath,
      "reviewer",
      homeDirectory,
    );

    assert.equal(agents.length, 1);
    assert.equal(agents[0]?.source, "workspace");
    assert.equal(resolved.selectedAgentName, "reviewer");
    assert.equal(resolved.customAgents[0]?.displayName, "Workspace Reviewer");
    assert.equal(resolved.customAgents[0]?.prompt, "workspace prompt");
  });

  /** 一覧から非公開の候補を除いても、実行用の設定解決には残す。 */
  it("picker には user-invocable: true の agent だけを出す", async () => {
    const workspacePath = createTempDir();
    const homeDirectory = createTempDir();
    writeCustomAgent(
      path.join(workspacePath, ".github", "agents"),
      "reviewer",
      {
        displayName: "Reviewer",
        userInvocable: true,
        prompt: "workspace prompt",
      },
    );
    writeCustomAgent(path.join(workspacePath, ".github", "agents"), "hidden", {
      displayName: "Hidden Agent",
      userInvocable: false,
      prompt: "hidden prompt",
    });
    writeCustomAgent(
      path.join(homeDirectory, ".copilot", "agents"),
      "implicit-hidden",
      {
        displayName: "Implicit Hidden",
        prompt: "implicit hidden prompt",
      },
    );

    const agents = await discoverSessionCustomAgents(
      workspacePath,
      homeDirectory,
    );
    const resolved = resolveSessionCustomAgentConfigs(
      workspacePath,
      "hidden",
      homeDirectory,
    );

    assert.deepEqual(
      agents.map((agent) => agent.displayName),
      ["Reviewer"],
    );
    assert.equal(resolved.customAgents.length, 3);
    assert.equal(resolved.selectedAgentName, "hidden");
  });

  /** 初回の探索に続けて設定を解決しても、未変更の Markdown は再読込しない。 */
  it("変更がない discovery は Markdown 再読込を避ける", async () => {
    const workspacePath = createTempDir();
    const homeDirectory = createTempDir();
    writeCustomAgent(
      path.join(workspacePath, ".github", "agents"),
      "reviewer",
      {
        displayName: "Reviewer",
        userInvocable: true,
        prompt: "workspace prompt",
      },
    );

    const mutableFs = fs as unknown as {
      readFileSync: (...args: any[]) => any;
    };
    const mutableFsPromises = fs.promises as unknown as {
      readFile: (...args: any[]) => Promise<any>;
    };
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
      resolveSessionCustomAgentConfigs(
        workspacePath,
        "reviewer",
        homeDirectory,
      );
    } finally {
      mutableFs.readFileSync = originalReadFileSync;
      mutableFsPromises.readFile = originalReadFile;
    }

    assert.equal(readCount, 1);
  });

  /** 同じパスを書き換えた場合は、mtime の変化を契機に説明を読み直す。 */
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

    assert.equal(
      (await discoverSessionCustomAgents(workspacePath, homeDirectory))[0]
        ?.description,
      "before",
    );

    writeCustomAgent(agentRootPath, "reviewer", {
      displayName: "Reviewer",
      description: "after",
      userInvocable: true,
      prompt: "workspace prompt",
    });
    touchFile(agentFilePath);

    assert.equal(
      (await discoverSessionCustomAgents(workspacePath, homeDirectory))[0]
        ?.description,
      "after",
    );
  });
});
