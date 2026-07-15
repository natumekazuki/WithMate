import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = process.cwd();
const sourceRoot = path.join(root, "src");

const rules = [
  {
    directory: "main",
    forbidden: ["node:sqlite", "../persistence-worker", "/persistence-worker/"],
  },
  {
    directory: "shared",
    forbidden: ["node:sqlite", "node:worker_threads", "electron", "../main", "../persistence-worker"],
  },
  {
    directory: "persistence-worker",
    forbidden: ["../main", "/main/", "electron"],
  },
];

function listSourceFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(entryPath));
    } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

const violations = [];
for (const rule of rules) {
  const directory = path.join(sourceRoot, rule.directory);
  if (!fs.existsSync(directory)) {
    continue;
  }

  for (const file of listSourceFiles(directory)) {
    const source = fs.readFileSync(file, "utf8");
    for (const forbidden of rule.forbidden) {
      if (source.includes(forbidden)) {
        violations.push(`${path.relative(root, file)} imports forbidden boundary ${JSON.stringify(forbidden)}`);
      }
    }
  }
}

const applicationWriteOwner = path.join(sourceRoot, "main", "application-session-service.ts");
const repositoryWriteClient = path.join(sourceRoot, "main", "repository-write-client.ts");
const repositoryReadClient = path.join(sourceRoot, "main", "repository-read-client.ts");
const persistenceWorkerClient = path.join(sourceRoot, "main", "persistence-worker-client.ts");
const publicMainBarrel = path.join(sourceRoot, "main", "index.ts");
const rawWriteFixture = path.join(root, "test", "fixtures", "module-boundaries", "raw-persistence-write.ts");
const repositoryWriteFixture = path.join(root, "test", "fixtures", "module-boundaries", "raw-repository-write.ts");
const rawReadFixture = path.join(root, "test", "fixtures", "module-boundaries", "raw-repository-read.ts");
const testConfig = ts.getParsedCommandLineOfConfigFile(path.join(root, "tsconfig.test.json"), {}, ts.sys);
if (testConfig === undefined) {
  throw new Error("tsconfig.test.json could not be parsed for module-boundary validation.");
}
const typeProgram = ts.createProgram({
  rootNames: [...listSourceFiles(sourceRoot), rawWriteFixture, repositoryWriteFixture, rawReadFixture],
  options: testConfig.options,
});
const typeChecker = typeProgram.getTypeChecker();

for (const file of listSourceFiles(sourceRoot)) {
  const sourceRelativePath = path.relative(sourceRoot, file);
  if (
    file === applicationWriteOwner ||
    file === repositoryWriteClient ||
    file === repositoryReadClient ||
    file === persistenceWorkerClient ||
    sourceRelativePath === "persistence-worker" ||
    sourceRelativePath.startsWith(`persistence-worker${path.sep}`)
  ) {
    continue;
  }
  const source = fs.readFileSync(file, "utf8");
  const sourceFile = typeProgram.getSourceFile(file) ?? ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const inspect = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleName = node.moduleSpecifier.text;
      if (moduleName.endsWith("/repository-write-client.js")) {
        violations.push(`${path.relative(root, file)} imports RepositoryWriteClient outside the Application Service`);
      }
      if (moduleName.endsWith("/repository-read-client.js")) {
        violations.push(`${path.relative(root, file)} imports RepositoryReadClient outside the Application Service`);
      }
      if (moduleName.endsWith("/repository-write-model.js")) {
        const imports = node.importClause?.namedBindings;
        if (imports !== undefined && ts.isNamespaceImport(imports)) {
          violations.push(`${path.relative(root, file)} imports Repository write command construction types`);
        }
        if (imports !== undefined && ts.isNamedImports(imports)) {
          for (const element of imports.elements) {
            const importedName = element.propertyName?.text ?? element.name.text;
            if (importedName.endsWith("Command") || importedName === "REPOSITORY_WRITE_OPERATIONS") {
              violations.push(
                `${path.relative(root, file)} imports Repository write command construction type ${JSON.stringify(importedName)}`,
              );
            }
          }
        }
      }
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const moduleName = node.moduleSpecifier.text;
      if (moduleName.endsWith("/repository-write-client.js")) {
        violations.push(
          `${path.relative(root, file)} re-exports RepositoryWriteClient outside the Application Service`,
        );
      }
      if (moduleName.endsWith("/repository-read-client.js")) {
        violations.push(`${path.relative(root, file)} re-exports RepositoryReadClient outside the Application Service`);
      }
      if (moduleName.endsWith("/repository-write-model.js")) {
        if (node.exportClause === undefined || ts.isNamespaceExport(node.exportClause)) {
          violations.push(`${path.relative(root, file)} re-exports Repository write command construction types`);
        } else {
          for (const element of node.exportClause.elements) {
            const exportedSourceName = element.propertyName?.text ?? element.name.text;
            if (exportedSourceName.endsWith("Command") || exportedSourceName === "REPOSITORY_WRITE_OPERATIONS") {
              violations.push(
                `${path.relative(root, file)} re-exports Repository write command construction type ${JSON.stringify(exportedSourceName)}`,
              );
            }
          }
        }
      }
    }
    if (isRepositoryClientDynamicImport(node, "repository-write-client.js")) {
      violations.push(
        `${path.relative(root, file)} dynamically imports RepositoryWriteClient outside the Application Service`,
      );
    }
    if (isRepositoryClientDynamicImport(node, "repository-read-client.js")) {
      violations.push(
        `${path.relative(root, file)} dynamically imports RepositoryReadClient outside the Application Service`,
      );
    }
    if (isRepositoryWriteRequest(node)) {
      violations.push(`${path.relative(root, file)} calls RepositoryWriteClient outside the Application Service`);
    }
    if (isRawPersistenceRequest(node)) {
      violations.push(`${path.relative(root, file)} sends a raw PersistenceWorkerClient request`);
    }
    if (isRepositoryReadRequest(node)) {
      violations.push(`${path.relative(root, file)} calls RepositoryReadClient outside the Application Service`);
    }
    ts.forEachChild(node, inspect);
  };
  inspect(sourceFile);
}

{
  const fixtureSource = typeProgram.getSourceFile(repositoryWriteFixture);
  if (
    fixtureSource === undefined ||
    !containsRepositoryWriteRequest(fixtureSource) ||
    !containsRepositoryClientDynamicImport(fixtureSource, "repository-write-client.js")
  ) {
    violations.push(
      `${path.relative(root, repositoryWriteFixture)} no longer exercises the Repository write boundary rule`,
    );
  }
}

{
  const fixtureSource = typeProgram.getSourceFile(rawReadFixture);
  if (fixtureSource === undefined || !containsRepositoryReadRequest(fixtureSource)) {
    violations.push(`${path.relative(root, rawReadFixture)} no longer exercises the Repository read boundary rule`);
  }
}

{
  const fixtureSource = typeProgram.getSourceFile(rawWriteFixture);
  if (fixtureSource === undefined || !containsRawPersistenceRequest(fixtureSource)) {
    violations.push(`${path.relative(root, rawWriteFixture)} no longer exercises the raw write boundary rule`);
  }
}

for (const file of [applicationWriteOwner]) {
  const source = fs.readFileSync(file, "utf8");
  if (source.includes("REPOSITORY_WRITE_OPERATIONS") || source.includes("repository.session.")) {
    violations.push(`${path.relative(root, file)} exposes a raw persistence operation name`);
  }
}

{
  const source = fs.readFileSync(publicMainBarrel, "utf8");
  const sourceFile = ts.createSourceFile(publicMainBarrel, source, ts.ScriptTarget.Latest, true);
  for (const statement of sourceFile.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.endsWith("/application-session-service.js")
    ) {
      violations.push(
        `${path.relative(root, publicMainBarrel)} exposes the Application Session implementation or DI options`,
      );
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.endsWith("/persistence-worker-client.js") &&
      (statement.exportClause === undefined ||
        ts.isNamespaceExport(statement.exportClause) ||
        (ts.isNamedExports(statement.exportClause) &&
          statement.exportClause.elements.some(
            (element) => (element.propertyName?.text ?? element.name.text) === "PersistenceWorkerClient",
          )))
    ) {
      violations.push(`${path.relative(root, publicMainBarrel)} exposes PersistenceWorkerClient raw requests`);
    }
  }
}

function isRawPersistenceRequest(node) {
  if (!ts.isCallExpression(node) || !isMethodCall(node, "request")) return false;
  const signatureDeclaration = typeChecker.getResolvedSignature(node)?.declaration;
  return (
    signatureDeclaration !== undefined &&
    path.resolve(signatureDeclaration.getSourceFile().fileName) === path.resolve(persistenceWorkerClient)
  );
}

function isMethodCall(node, methodName) {
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text === methodName;
  return (
    ts.isElementAccessExpression(node.expression) &&
    node.expression.argumentExpression !== undefined &&
    ts.isStringLiteral(node.expression.argumentExpression) &&
    node.expression.argumentExpression.text === methodName
  );
}

function isRepositoryClientDynamicImport(node, clientFileName) {
  if (!ts.isCallExpression(node) || node.expression.kind !== ts.SyntaxKind.ImportKeyword) return false;
  const moduleSpecifier = node.arguments[0];
  return (
    moduleSpecifier !== undefined &&
    ts.isStringLiteral(moduleSpecifier) &&
    moduleSpecifier.text.endsWith(`/${clientFileName}`)
  );
}

function containsRepositoryClientDynamicImport(sourceFile, clientFileName) {
  let found = false;
  const inspect = (node) => {
    if (isRepositoryClientDynamicImport(node, clientFileName)) {
      found = true;
      return;
    }
    ts.forEachChild(node, inspect);
  };
  inspect(sourceFile);
  return found;
}

function isRepositoryWriteRequest(node) {
  if (!ts.isCallExpression(node)) return false;
  const signatureDeclaration = typeChecker.getResolvedSignature(node)?.declaration;
  return (
    signatureDeclaration !== undefined &&
    path.resolve(signatureDeclaration.getSourceFile().fileName) === path.resolve(repositoryWriteClient)
  );
}

function containsRepositoryWriteRequest(sourceFile) {
  let found = false;
  const inspect = (node) => {
    if (isRepositoryWriteRequest(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, inspect);
  };
  inspect(sourceFile);
  return found;
}

function containsRawPersistenceRequest(sourceFile) {
  let found = false;
  const inspect = (node) => {
    if (isRawPersistenceRequest(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, inspect);
  };
  inspect(sourceFile);
  return found;
}

function isRepositoryReadRequest(node) {
  if (!ts.isCallExpression(node)) return false;
  const signatureDeclaration = typeChecker.getResolvedSignature(node)?.declaration;
  return (
    signatureDeclaration !== undefined &&
    path.resolve(signatureDeclaration.getSourceFile().fileName) === path.resolve(repositoryReadClient)
  );
}

function containsRepositoryReadRequest(sourceFile) {
  let found = false;
  const inspect = (node) => {
    if (isRepositoryReadRequest(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, inspect);
  };
  inspect(sourceFile);
  return found;
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("module boundaries: ok");
}
