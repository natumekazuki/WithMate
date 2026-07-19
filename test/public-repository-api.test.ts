import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import ts from "typescript";

import * as publicApi from "../src/main/index.js";
import type { ApplicationRunOperations, ApplicationSessionOperations } from "../src/main/index.js";

type Authorization = Readonly<{ principalId: string }>;
type SessionListInput = Parameters<ApplicationSessionOperations<Authorization>["list"]>[0];
type RunStatusInput = Parameters<ApplicationRunOperations<Authorization>["status"]>[0];

test("public Main barrel exposes only the transport-neutral Application contract", () => {
  const sourcePath = new URL("../src/main/index.ts", import.meta.url);
  const source = fs.readFileSync(sourcePath, "utf8");
  const sourceFile = ts.createSourceFile(sourcePath.pathname, source, ts.ScriptTarget.Latest, true);
  const exportedModules = sourceFile.statements.flatMap((statement) =>
    ts.isExportDeclaration(statement) &&
    statement.moduleSpecifier !== undefined &&
    ts.isStringLiteral(statement.moduleSpecifier)
      ? [statement.moduleSpecifier.text]
      : [],
  );
  const listInput = null as SessionListInput | null;
  const statusInput = null as RunStatusInput | null;

  assert.deepEqual(exportedModules, ["../shared/application-service-model.js", "../shared/application-run-model.js"]);
  assert.deepEqual(Object.keys(publicApi), []);
  assert.equal(listInput, null);
  assert.equal(statusInput, null);
});
