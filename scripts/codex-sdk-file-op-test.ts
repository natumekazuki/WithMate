import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { Codex } from "@openai/codex-sdk";

type FileChange = {
  path: string;
  kind: string;
};

function buildTargetRelativePath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `tmp/codex-sdk-file-op-${stamp}.txt`;
}

function buildExpectedContent(relativePath: string): string {
  return [
    "withmate codex sdk file operation test",
    `path=${relativePath}`,
    "mode=workspace-write",
    "result=created-by-codex-sdk",
  ].join("\n");
}

function buildPrompt(relativePath: string, expectedContent: string): string {
  return [
    "Create exactly one new text file in the current workspace.",
    `Relative path: ${relativePath}`,
    "Use the file editing tool so the file is actually written to disk.",
    "Do not modify any existing file.",
    "Write exactly this content with newline separators:",
    "```text",
    expectedContent,
    "```",
    "After writing the file, respond with only the relative path.",
  ].join("\n");
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").trimEnd();
}

async function main(): Promise<void> {
  const workingDirectory = process.cwd();
  const relativePath = buildTargetRelativePath();
  const absolutePath = path.join(workingDirectory, relativePath);
  const expectedContent = buildExpectedContent(relativePath);

  await mkdir(path.dirname(absolutePath), { recursive: true });

  const codex = new Codex();
  const thread = codex.startThread({
    workingDirectory,
    approvalPolicy: "never",
    sandboxMode: "workspace-write",
  });

  console.log("Running Codex SDK file operation test...");
  console.log(`workingDirectory: ${workingDirectory}`);
  console.log(`targetFile: ${relativePath}`);
  console.log("authMode: stored-cli-auth");

  const turn = await thread.run(buildPrompt(relativePath, expectedContent));

  const createdStat = await stat(absolutePath);
  const content = await readFile(absolutePath, "utf8");
  const contentMatches = normalizeText(content) === normalizeText(expectedContent);
  const fileChanges = turn.items
    .filter((item): item is typeof item & { type: "file_change"; changes: FileChange[] } => item.type === "file_change")
    .flatMap((item) => item.changes);

  console.log(`threadId: ${thread.id ?? "unavailable"}`);
  console.log(`assistantResponse: ${turn.finalResponse}`);
  console.log(`fileExists: ${createdStat.isFile()}`);
  console.log(`contentMatches: ${contentMatches}`);
  console.log(`fileChangeCount: ${fileChanges.length}`);
  for (const change of fileChanges) {
    console.log(`fileChange: ${change.kind} ${change.path}`);
  }
  console.log("fileContent:");
  console.log(content);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);

  console.error("Codex SDK file operation test failed.");
  console.error(message);
  console.error("");
  console.error("確認ポイント:");
  console.error("- `codex` CLI で事前に ChatGPT ログインを完了させる");
  console.error("- `workingDirectory` が Git リポジトリであることを確認する");
  console.error("- SDK 起動時の `sandboxMode` が `workspace-write` になっていることを確認する");

  process.exitCode = 1;
});
