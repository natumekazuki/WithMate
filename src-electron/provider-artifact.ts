import type {
  AuditLogOperation,
  AuditLogUsage,
  ChangedFile,
  DiffRow,
  MessageArtifact,
  RunCheck,
  Session,
} from "../src/app-state.js";
import { reasoningEffortLabel, type ModelCatalogProvider, type ResolvedModelSelection } from "../src/model-catalog.js";
import type { SnapshotCaptureStats, WorkspaceSnapshot } from "./snapshot-ignore.js";

const MAX_DIFF_MATRIX_CELLS = 2_000_000;

function summarizeChangedFile(kind: ChangedFile["kind"], filePath: string): string {
  switch (kind) {
    case "add":
      return `${filePath} を新規作成した`;
    case "delete":
      return `${filePath} を削除した`;
    default:
      return `${filePath} を更新した`;
  }
}

function toLines(content: string | null): string[] {
  if (!content) {
    return [];
  }

  return content.split(/\r?\n/);
}

type RawDiffOp =
  | { kind: "context"; leftNumber: number; rightNumber: number; leftText: string; rightText: string }
  | { kind: "delete"; leftNumber: number; leftText: string }
  | { kind: "add"; rightNumber: number; rightText: string };

function buildFallbackDiffRows(beforeLines: string[], afterLines: string[]): DiffRow[] {
  const rows: DiffRow[] = [];
  const maxLength = Math.max(beforeLines.length, afterLines.length);

  for (let index = 0; index < maxLength; index += 1) {
    const beforeLine = beforeLines[index];
    const afterLine = afterLines[index];

    if (beforeLine === afterLine && beforeLine !== undefined) {
      rows.push({
        kind: "context",
        leftNumber: index + 1,
        rightNumber: index + 1,
        leftText: beforeLine,
        rightText: afterLine,
      });
      continue;
    }

    if (beforeLine !== undefined && afterLine !== undefined) {
      rows.push({
        kind: "modify",
        leftNumber: index + 1,
        rightNumber: index + 1,
        leftText: beforeLine,
        rightText: afterLine,
      });
      continue;
    }

    if (beforeLine !== undefined) {
      rows.push({
        kind: "delete",
        leftNumber: index + 1,
        leftText: beforeLine,
      });
      continue;
    }

    rows.push({
      kind: "add",
      rightNumber: index + 1,
      rightText: afterLine ?? "",
    });
  }

  return rows;
}

function buildDiffRows(beforeContent: string | null, afterContent: string | null): DiffRow[] {
  const beforeLines = toLines(beforeContent);
  const afterLines = toLines(afterContent);

  if (beforeLines.length === 0 && afterLines.length === 0) {
    return [];
  }

  const cellCount = (beforeLines.length + 1) * (afterLines.length + 1);
  if (cellCount > MAX_DIFF_MATRIX_CELLS) {
    return buildFallbackDiffRows(beforeLines, afterLines);
  }

  const lcs: number[][] = Array.from({ length: beforeLines.length + 1 }, () =>
    Array.from({ length: afterLines.length + 1 }, () => 0),
  );

  for (let left = beforeLines.length - 1; left >= 0; left -= 1) {
    for (let right = afterLines.length - 1; right >= 0; right -= 1) {
      lcs[left][right] =
        beforeLines[left] === afterLines[right]
          ? lcs[left + 1][right + 1] + 1
          : Math.max(lcs[left + 1][right], lcs[left][right + 1]);
    }
  }

  const operations: RawDiffOp[] = [];
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < beforeLines.length && rightIndex < afterLines.length) {
    if (beforeLines[leftIndex] === afterLines[rightIndex]) {
      operations.push({
        kind: "context",
        leftNumber: leftIndex + 1,
        rightNumber: rightIndex + 1,
        leftText: beforeLines[leftIndex],
        rightText: afterLines[rightIndex],
      });
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }

    if (lcs[leftIndex][rightIndex + 1] >= lcs[leftIndex + 1][rightIndex]) {
      operations.push({
        kind: "add",
        rightNumber: rightIndex + 1,
        rightText: afterLines[rightIndex],
      });
      rightIndex += 1;
      continue;
    }

    operations.push({
      kind: "delete",
      leftNumber: leftIndex + 1,
      leftText: beforeLines[leftIndex],
    });
    leftIndex += 1;
  }

  while (leftIndex < beforeLines.length) {
    operations.push({
      kind: "delete",
      leftNumber: leftIndex + 1,
      leftText: beforeLines[leftIndex],
    });
    leftIndex += 1;
  }

  while (rightIndex < afterLines.length) {
    operations.push({
      kind: "add",
      rightNumber: rightIndex + 1,
      rightText: afterLines[rightIndex],
    });
    rightIndex += 1;
  }

  const rows: DiffRow[] = [];

  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    if (operation.kind === "context") {
      rows.push({
        kind: "context",
        leftNumber: operation.leftNumber,
        rightNumber: operation.rightNumber,
        leftText: operation.leftText,
        rightText: operation.rightText,
      });
      continue;
    }

    const block: RawDiffOp[] = [];
    let cursor = index;
    while (cursor < operations.length && operations[cursor].kind !== "context") {
      block.push(operations[cursor]);
      cursor += 1;
    }

    const deletes = block.filter((entry): entry is Extract<RawDiffOp, { kind: "delete" }> => entry.kind === "delete");
    const adds = block.filter((entry): entry is Extract<RawDiffOp, { kind: "add" }> => entry.kind === "add");
    const pairedCount = Math.min(deletes.length, adds.length);

    for (let pairIndex = 0; pairIndex < pairedCount; pairIndex += 1) {
      rows.push({
        kind: "modify",
        leftNumber: deletes[pairIndex].leftNumber,
        rightNumber: adds[pairIndex].rightNumber,
        leftText: deletes[pairIndex].leftText,
        rightText: adds[pairIndex].rightText,
      });
    }

    for (let deleteIndex = pairedCount; deleteIndex < deletes.length; deleteIndex += 1) {
      rows.push({
        kind: "delete",
        leftNumber: deletes[deleteIndex].leftNumber,
        leftText: deletes[deleteIndex].leftText,
      });
    }

    for (let addIndex = pairedCount; addIndex < adds.length; addIndex += 1) {
      rows.push({
        kind: "add",
        rightNumber: adds[addIndex].rightNumber,
        rightText: adds[addIndex].rightText,
      });
    }

    index = cursor - 1;
  }

  return rows;
}

function inferChangedFileKind(beforeContent: string | null, afterContent: string | null): ChangedFile["kind"] | null {
  if (beforeContent === null && afterContent !== null) {
    return "add";
  }

  if (beforeContent !== null && afterContent === null) {
    return "delete";
  }

  if (beforeContent !== null && afterContent !== null && beforeContent !== afterContent) {
    return "edit";
  }

  return null;
}

function compareSnapshotChanges(beforeSnapshot: WorkspaceSnapshot, afterSnapshot: WorkspaceSnapshot): Array<{
  path: string;
  kind: ChangedFile["kind"];
}> {
  const paths = new Set<string>([...beforeSnapshot.keys(), ...afterSnapshot.keys()]);
  const changes: Array<{ path: string; kind: ChangedFile["kind"] }> = [];

  for (const filePath of paths) {
    const kind = inferChangedFileKind(beforeSnapshot.get(filePath) ?? null, afterSnapshot.get(filePath) ?? null);
    if (!kind) {
      continue;
    }

    changes.push({ path: filePath, kind });
  }

  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

function summarizeSnapshotWarning(stats: SnapshotCaptureStats): string {
  const warnings: string[] = [];
  if (stats.skippedBinaryOrOversizeFiles > 0) {
    warnings.push(`binary/oversize ${stats.skippedBinaryOrOversizeFiles}`);
  }
  if (stats.skippedByLimitFiles > 0) {
    warnings.push(`limit skipped ${stats.skippedByLimitFiles}`);
  }
  if (stats.hitFileCountLimit) {
    warnings.push("file limit hit");
  }
  if (stats.hitTotalBytesLimit) {
    warnings.push("size limit hit");
  }

  return warnings.join(", ");
}

function buildChangedFilesFromSnapshots(beforeSnapshot: WorkspaceSnapshot, afterSnapshot: WorkspaceSnapshot): ChangedFile[] {
  return compareSnapshotChanges(beforeSnapshot, afterSnapshot)
    .map(({ path, kind }) => {
      const beforeContent = beforeSnapshot.get(path) ?? null;
      const afterContent = afterSnapshot.get(path) ?? null;

      return {
        kind,
        path,
        summary: summarizeChangedFile(kind, path),
        diffRows: buildDiffRows(kind === "add" ? null : beforeContent, kind === "delete" ? null : afterContent),
      };
    });
}

function buildActivitySummary(operations: AuditLogOperation[], changedFiles: ChangedFile[]): string[] {
  const summary = operations
    .filter((operation) => operation.type !== "agent_message" && operation.type !== "unknown")
    .map((operation) => (operation.type === "command_execution" ? `command: ${operation.summary}` : operation.summary));

  if (summary.length > 0) {
    return summary.slice(0, 6);
  }

  return changedFiles.map((file) => file.summary).slice(0, 6);
}

function buildRunChecks(
  session: Session,
  usage: AuditLogUsage | null,
  threadId: string | null,
  providerCatalog: ModelCatalogProvider,
  selection: ResolvedModelSelection,
  beforeSnapshotStats: SnapshotCaptureStats,
  afterSnapshotStats: SnapshotCaptureStats,
): RunCheck[] {
  const checks: RunCheck[] = [
    { label: "provider", value: providerCatalog.label },
    { label: "approval", value: session.approvalMode },
    { label: "model", value: selection.resolvedModel },
    { label: "reasoning", value: reasoningEffortLabel(selection.resolvedReasoningEffort) },
  ];

  if (threadId) {
    checks.push({ label: "thread", value: threadId });
  }

  if (usage) {
    checks.push({ label: "tokens", value: `${usage.inputTokens}/${usage.outputTokens}` });
  }

  const beforeSnapshotWarning = summarizeSnapshotWarning(beforeSnapshotStats);
  if (beforeSnapshotWarning) {
    checks.push({ label: "snapshot before", value: beforeSnapshotWarning });
  }

  const afterSnapshotWarning = summarizeSnapshotWarning(afterSnapshotStats);
  if (afterSnapshotWarning) {
    checks.push({ label: "snapshot after", value: afterSnapshotWarning });
  }

  return checks;
}

export function buildArtifactFromOperations(input: {
  session: Session;
  operations: AuditLogOperation[];
  usage: AuditLogUsage | null;
  threadId: string | null;
  beforeSnapshot: WorkspaceSnapshot;
  afterSnapshot: WorkspaceSnapshot;
  beforeSnapshotStats: SnapshotCaptureStats;
  afterSnapshotStats: SnapshotCaptureStats;
  providerCatalog: ModelCatalogProvider;
  selection: ResolvedModelSelection;
}): MessageArtifact | undefined {
  const changedFiles = buildChangedFilesFromSnapshots(input.beforeSnapshot, input.afterSnapshot);
  const operationTimeline = input.operations;
  const runChecks = buildRunChecks(
    input.session,
    input.usage,
    input.threadId,
    input.providerCatalog,
    input.selection,
    input.beforeSnapshotStats,
    input.afterSnapshotStats,
  );
  const activitySummary = buildActivitySummary(operationTimeline, changedFiles);

  if (changedFiles.length === 0 && operationTimeline.length === 0 && runChecks.length === 0) {
    return undefined;
  }

  return {
    title: input.session.taskTitle,
    activitySummary,
    operationTimeline,
    changedFiles,
    runChecks,
  };
}
