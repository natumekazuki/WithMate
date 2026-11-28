import type {
  MessageOperation,
  ProviderUsage,
  ChangedFile,
  DiffRow,
  RunCheck,
} from "../../src-shared/session/runtime-state.js";
import type {
  MessageArtifact,
  Session,
} from "../../src-shared/session/session-state.js";
import type { SessionExecutionOptions } from "../../src-shared/session/session-execution-options.js";
import {
  reasoningEffortLabel,
  type ModelCatalogProvider,
  type ResolvedModelSelection,
} from "../../src-shared/settings/model-catalog.js";
import type {
  SnapshotCaptureStats,
  WorkspaceSnapshot,
} from "../platform/snapshot-ignore.js";

const MAX_DIFF_MATRIX_CELLS = 2_000_000;

/** 差分の種別と対象パスからアクティビティで使う一行の要約を組み立てる。 */
export function summarizeChangedFile(
  kind: ChangedFile["kind"],
  filePath: string,
): string {
  switch (kind) {
    case "add":
      return `${filePath} created`;
    case "delete":
      return `${filePath} deleted`;
    default:
      return `${filePath} updated`;
  }
}

/** 空または未取得の内容をゼロ行と扱い、内容があれば CRLF・LF の両方で分割する。 */
function toLines(content: string | null): string[] {
  if (!content) {
    return [];
  }

  return content.split(/\r?\n/);
}

/** 変更行を対応付ける前の操作列。共通行は両側、追加と削除は該当する側だけの行番号を持つ。 */
type RawDiffOp =
  | {
      kind: "context";
      leftNumber: number;
      rightNumber: number;
      leftText: string;
      rightText: string;
    }
  | { kind: "delete"; leftNumber: number; leftText: string }
  | { kind: "add"; rightNumber: number; rightText: string };

/** 差分行列の上限を超えたときは、行の再整列をせず同じ位置同士を比較する。 */
function buildFallbackDiffRows(
  beforeLines: string[],
  afterLines: string[],
): DiffRow[] {
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

/** 共通行を基準に前後の内容を整列し、同じ変更区間の削除と追加を変更行にまとめる。巨大な入力は位置比較に切り替える。 */
export function buildDiffRows(
  beforeContent: string | null,
  afterContent: string | null,
): DiffRow[] {
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
    while (
      cursor < operations.length &&
      operations[cursor].kind !== "context"
    ) {
      block.push(operations[cursor]);
      cursor += 1;
    }

    const deletes = block.filter(
      (entry): entry is Extract<RawDiffOp, { kind: "delete" }> =>
        entry.kind === "delete",
    );
    const adds = block.filter(
      (entry): entry is Extract<RawDiffOp, { kind: "add" }> =>
        entry.kind === "add",
    );
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

    for (
      let deleteIndex = pairedCount;
      deleteIndex < deletes.length;
      deleteIndex += 1
    ) {
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

/** 両側の内容の有無と一致から追加・削除・編集を区別し、差がなければ null を返す。 */
function inferChangedFileKind(
  beforeContent: string | null,
  afterContent: string | null,
): ChangedFile["kind"] | null {
  if (beforeContent === null && afterContent !== null) {
    return "add";
  }

  if (beforeContent !== null && afterContent === null) {
    return "delete";
  }

  if (
    beforeContent !== null &&
    afterContent !== null &&
    beforeContent !== afterContent
  ) {
    return "edit";
  }

  return null;
}

/** どちらかのスナップショットに含まれる全パスを調べ、変更があるものだけをパス順で返す。 */
function compareSnapshotChanges(
  beforeSnapshot: WorkspaceSnapshot,
  afterSnapshot: WorkspaceSnapshot,
): Array<{
  path: string;
  kind: ChangedFile["kind"];
}> {
  const paths = new Set<string>([
    ...beforeSnapshot.keys(),
    ...afterSnapshot.keys(),
  ]);
  const changes: Array<{ path: string; kind: ChangedFile["kind"] }> = [];

  for (const filePath of paths) {
    const kind = inferChangedFileKind(
      beforeSnapshot.get(filePath) ?? null,
      afterSnapshot.get(filePath) ?? null,
    );
    if (!kind) {
      continue;
    }

    changes.push({ path: filePath, kind });
  }

  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

/** スナップショットの除外件数と到達した上限だけを警告に列挙する。該当がなければ空文字列を返す。 */
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

/** 変更されたパスに要約と行差分を添える。追加の変更前、削除の変更後は内容がないものとして扱う。 */
function buildChangedFilesFromSnapshots(
  beforeSnapshot: WorkspaceSnapshot,
  afterSnapshot: WorkspaceSnapshot,
): ChangedFile[] {
  return compareSnapshotChanges(beforeSnapshot, afterSnapshot).map(
    ({ path, kind }) => {
      const beforeContent = beforeSnapshot.get(path) ?? null;
      const afterContent = afterSnapshot.get(path) ?? null;

      return {
        kind,
        path,
        summary: summarizeChangedFile(kind, path),
        diffRows: buildDiffRows(
          kind === "add" ? null : beforeContent,
          kind === "delete" ? null : afterContent,
        ),
      };
    },
  );
}

/** メッセージと不明な操作を除いて先頭最大 6 件を要約し、対象操作がなければファイル変更から補う。 */
function buildActivitySummary(
  operations: MessageOperation[],
  changedFiles: ChangedFile[],
): string[] {
  const summary = operations
    .filter(
      (operation) =>
        operation.type !== "agent_message" && operation.type !== "unknown",
    )
    .map((operation) =>
      operation.type === "command_execution"
        ? `command: ${operation.summary}`
        : operation.summary,
    );

  if (summary.length > 0) {
    return summary.slice(0, 6);
  }

  return changedFiles.map((file) => file.summary).slice(0, 6);
}

/** 選択済み実行設定を記録し、取得できたスレッド・トークン使用量とスナップショット取得時の警告を添える。 */
function buildRunChecks(
  executionOptions: SessionExecutionOptions,
  usage: ProviderUsage | null,
  threadId: string | null,
  providerCatalog: ModelCatalogProvider,
  selection: ResolvedModelSelection,
  beforeSnapshotStats: SnapshotCaptureStats,
  afterSnapshotStats: SnapshotCaptureStats,
): RunCheck[] {
  const checks: RunCheck[] = [
    { label: "provider", value: providerCatalog.label },
    { label: "approval", value: executionOptions.approvalMode },
    { label: "model", value: selection.resolvedModel },
    {
      label: "reasoning",
      value: reasoningEffortLabel(selection.resolvedReasoningEffort),
    },
  ];

  if (threadId) {
    checks.push({ label: "thread", value: threadId });
  }

  if (usage) {
    checks.push({
      label: "tokens",
      value: `${usage.inputTokens}/${usage.outputTokens}`,
    });
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

/** 操作の時系列、ワークスペース差分、実行条件の記録を Session 名付きのメッセージ成果物にまとめる。 */
export function buildArtifactFromOperations(input: {
  session: Session;
  executionOptions: SessionExecutionOptions;
  operations: MessageOperation[];
  usage: ProviderUsage | null;
  threadId: string | null;
  beforeSnapshot: WorkspaceSnapshot;
  afterSnapshot: WorkspaceSnapshot;
  beforeSnapshotStats: SnapshotCaptureStats;
  afterSnapshotStats: SnapshotCaptureStats;
  providerCatalog: ModelCatalogProvider;
  selection: ResolvedModelSelection;
}): MessageArtifact | undefined {
  const changedFiles = buildChangedFilesFromSnapshots(
    input.beforeSnapshot,
    input.afterSnapshot,
  );
  const operationTimeline = input.operations;
  const runChecks = buildRunChecks(
    input.executionOptions,
    input.usage,
    input.threadId,
    input.providerCatalog,
    input.selection,
    input.beforeSnapshotStats,
    input.afterSnapshotStats,
  );
  const activitySummary = buildActivitySummary(operationTimeline, changedFiles);

  if (
    changedFiles.length === 0 &&
    operationTimeline.length === 0 &&
    runChecks.length === 0
  ) {
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
