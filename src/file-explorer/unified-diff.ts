export type UnifiedDiffContentRow = {
  kind: "context" | "add" | "delete" | "modify";
  leftNumber?: number;
  rightNumber?: number;
  leftText?: string;
  rightText?: string;
  leftPatchLineIndex?: number;
  rightPatchLineIndex?: number;
};

export type UnifiedDiffAnnotationRow =
  | { kind: "metadata"; text: string; patchLineIndex: number }
  | { kind: "hunk"; text: string; patchLineIndex: number }
  | { kind: "note"; text: string; patchLineIndex: number };

export type UnifiedDiffDisplayRow = UnifiedDiffContentRow | UnifiedDiffAnnotationRow;

export type ParsedUnifiedDiff = {
  rows: UnifiedDiffDisplayRow[];
  hasTextChanges: boolean;
};

type PendingChange = {
  kind: "add" | "delete";
  number: number;
  text: string;
  patchLineIndex: number;
};

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseUnifiedDiff(patch: string): ParsedUnifiedDiff {
  const lines = patch.split(/\r\n|\n|\r/);
  const rows: UnifiedDiffDisplayRow[] = [];
  let pendingChanges: PendingChange[] = [];
  let pendingNotes: Array<Extract<UnifiedDiffAnnotationRow, { kind: "note" }>> = [];
  let leftNumber = 0;
  let rightNumber = 0;
  let leftRemaining = 0;
  let rightRemaining = 0;
  let inHunk = false;
  let hasTextChanges = false;

  const flushPendingChanges = () => {
    const deletes = pendingChanges.filter((change) => change.kind === "delete");
    const adds = pendingChanges.filter((change) => change.kind === "add");
    const pairedCount = Math.min(deletes.length, adds.length);

    for (let index = 0; index < pairedCount; index += 1) {
      const deleted = deletes[index];
      const added = adds[index];
      rows.push({
        kind: "modify",
        leftNumber: deleted.number,
        rightNumber: added.number,
        leftText: deleted.text,
        rightText: added.text,
        leftPatchLineIndex: deleted.patchLineIndex,
        rightPatchLineIndex: added.patchLineIndex,
      });
    }
    for (const deleted of deletes.slice(pairedCount)) {
      rows.push({
        kind: "delete",
        leftNumber: deleted.number,
        leftText: deleted.text,
        leftPatchLineIndex: deleted.patchLineIndex,
      });
    }
    for (const added of adds.slice(pairedCount)) {
      rows.push({
        kind: "add",
        rightNumber: added.number,
        rightText: added.text,
        rightPatchLineIndex: added.patchLineIndex,
      });
    }
    pendingChanges = [];
    rows.push(...pendingNotes);
    pendingNotes = [];
  };

  const closeHunkIfComplete = () => {
    if (leftRemaining === 0 && rightRemaining === 0) {
      flushPendingChanges();
      inHunk = false;
    }
  };

  lines.forEach((line, patchLineIndex) => {
    const hunkMatch = line.match(HUNK_HEADER_PATTERN);
    if (hunkMatch) {
      flushPendingChanges();
      leftNumber = Number.parseInt(hunkMatch[1], 10);
      rightNumber = Number.parseInt(hunkMatch[3], 10);
      leftRemaining = hunkMatch[2] === undefined ? 1 : Number.parseInt(hunkMatch[2], 10);
      rightRemaining = hunkMatch[4] === undefined ? 1 : Number.parseInt(hunkMatch[4], 10);
      inHunk = true;
      rows.push({ kind: "hunk", text: line, patchLineIndex });
      closeHunkIfComplete();
      return;
    }

    if (line.startsWith("\\")) {
      pendingNotes.push({ kind: "note", text: line, patchLineIndex });
      return;
    }

    if (!inHunk) {
      flushPendingChanges();
      rows.push({ kind: "metadata", text: line, patchLineIndex });
      return;
    }

    const marker = line[0];
    const text = line.slice(1);
    if (marker === " " && leftRemaining > 0 && rightRemaining > 0) {
      flushPendingChanges();
      rows.push({
        kind: "context",
        leftNumber,
        rightNumber,
        leftText: text,
        rightText: text,
        leftPatchLineIndex: patchLineIndex,
        rightPatchLineIndex: patchLineIndex,
      });
      leftNumber += 1;
      rightNumber += 1;
      leftRemaining -= 1;
      rightRemaining -= 1;
      closeHunkIfComplete();
      return;
    }
    if (marker === "-" && leftRemaining > 0) {
      pendingChanges.push({ kind: "delete", number: leftNumber, text, patchLineIndex });
      leftNumber += 1;
      leftRemaining -= 1;
      hasTextChanges = true;
      closeHunkIfComplete();
      return;
    }
    if (marker === "+" && rightRemaining > 0) {
      pendingChanges.push({ kind: "add", number: rightNumber, text, patchLineIndex });
      rightNumber += 1;
      rightRemaining -= 1;
      hasTextChanges = true;
      closeHunkIfComplete();
      return;
    }

    flushPendingChanges();
    inHunk = false;
    rows.push({ kind: "metadata", text: line, patchLineIndex });
  });

  flushPendingChanges();
  return { rows, hasTextChanges };
}
