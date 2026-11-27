import { createRoot } from "react-dom/client";
import LocalPrWindowApp from "../LocalPrWindowApp.js";
import type { LocalPrWindowApi } from "../../../src-shared/local-pr/local-pr-contract.js";
import "../../styles/common.css";

// Synthetic data and an in-memory API isolate visual checks from real repositories and Sessions.
const head = "a".repeat(40);
const target = "b".repeat(40);
const oldHead = "c".repeat(40);
const author = {
  kind: "main",
  sessionId: "synthetic-session",
  incarnationId: "synthetic-incarnation",
};
const versions = [
  {
    version: 1,
    headCommit: oldHead,
    targetCommit: target,
    mergeBaseCommit: target,
    submittedAt: "2026-01-01",
    submittedBy: author,
  },
  {
    version: 2,
    headCommit: head,
    targetCommit: target,
    mergeBaseCommit: target,
    submittedAt: "2026-01-02",
    submittedBy: author,
  },
];
const detail = {
  id: "synthetic-pr",
  title: "Improve review feedback for long changes",
  description: "A synthetic pull request for checking code and comments.",
  targetBranch: "refs/heads/main",
  sourceBranch: "refs/heads/feature",
  createdBy: author,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-02",
  state: "open",
  latestVersion: 2,
  mergedCommit: null,
  currentTargetCommit: target,
  approval: null,
  versions,
  comments: [
    {
      id: "old-comment",
      version: 1,
      anchor: {
        mode: "full",
        path: "src/long-file.ts",
        side: "after",
        startLine: 2,
        endLine: 3,
      },
      replyTo: null,
      body: "Could this be clearer?",
      author: { kind: "user" },
      draft: true,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    },
  ],
};
const runs = [
  {
    id: "synthetic-run",
    version: 2,
    headCommit: head,
    targetCommit: target,
    state: "failed",
    startedAt: "2026-01-02",
    finishedAt: "2026-01-02",
    exitCode: 1,
    error: "Synthetic failure",
  },
];
const listeners = new Set<() => void>();
const calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
let failReads = false;
let unknownDiscussion = false;
let targetTip = target;
let sourceTip = head;
Object.assign(window, {
  localPrFixture: {
    calls,
    setFailReads(value: boolean) {
      failReads = value;
    },
    setUnknownDiscussion(value: boolean) {
      unknownDiscussion = value;
    },
    setTips(nextTarget: string, nextSource: string) {
      targetTip = nextTarget;
      sourceTip = nextSource;
      detail.currentTargetCommit = nextTarget;
    },
    notify() {
      listeners.forEach((listener) => listener());
    },
  },
});
const patch = `diff --git a/src/long-file.ts b/src/long-file.ts\n--- a/src/long-file.ts\n+++ b/src/long-file.ts\n@@ -1,4 +1,4 @@\n const first = true;\n-const second = false;\n+const second = true;\n const third = 3;\n const fourth = 4;`;
const execute = async (operation: string, input: Record<string, unknown>) => {
  calls.push({ operation, input });
  if (
    failReads &&
    ["pr_list", "pr_get", "pr_diff", "pr_ci_list", "pr_ci_validate"].includes(
      operation,
    )
  )
    return {
      ok: false,
      code: "SYNTHETIC_ERROR",
      message: "Synthetic read failure",
      effect: "none",
    };
  let data: unknown;
  switch (operation) {
    case "pr_list":
      data = { entries: [detail], hasMore: false };
      break;
    case "pr_get":
      data = detail;
      break;
    case "pr_branches":
      data = {
        branches: [
          { ref: detail.targetBranch, commit: targetTip },
          { ref: detail.sourceBranch, commit: sourceTip },
        ],
        head: sourceTip,
        headBranch: detail.sourceBranch,
      };
      break;
    case "session_choices":
      data = {
        sessions: [{ target: author, title: "Synthetic Session" }],
        hasMore: false,
      };
      break;
    case "pr_diff":
      data = {
        beforeCommit: target,
        afterCommit: input.version === 1 ? oldHead : head,
        files: [
          { path: "src/long-file.ts", previousPath: null, kind: "modified" },
          { path: "src/very-long.ts", previousPath: null, kind: "modified" },
        ],
        patch:
          input.path === "src/very-long.ts"
            ? `@@ -1,8000 +1,8000 @@\n${Array.from({ length: 8000 }, (_, index) => ` line ${index + 1}`).join("\n")}`
            : input.path
              ? patch
              : null,
      };
      break;
    case "pr_ci_validate":
      data = {
        headCommit: head,
        path: ".withmate/ci.yml",
        state: "valid",
        source: "steps:\n  - npm test",
        error: null,
      };
      break;
    case "pr_ci_list":
      data = { runs: input.version === 2 ? runs : [] };
      break;
    case "pr_ci_log":
      data = {
        log: "Synthetic log\nTest failed\n",
        nextOffset: 26,
        hasMore: false,
      };
      break;
    case "discuss":
      if (unknownDiscussion) {
        unknownDiscussion = false;
        return {
          ok: false,
          code: "SYNTHETIC_UNKNOWN",
          message: "Synthetic unknown",
          effect: "unknown",
        };
      }
      data = { receiptId: "synthetic-receipt" };
      break;
    default:
      data = detail;
  }
  return { ok: true, data };
};
const api: LocalPrWindowApi = {
  execute: execute as LocalPrWindowApi["execute"],
  subscribeChanged(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
createRoot(document.getElementById("root")!).render(
  <LocalPrWindowApp api={api} />,
);
