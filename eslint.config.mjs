import babel from "@babel/eslint-parser";
import { defineConfig, globalIgnores } from "eslint/config";
import jsdoc from "eslint-plugin-jsdoc";

const declarations = {
  enableFixer: false,
  checkGetters: true,
  checkSetters: true,
  require: { ClassDeclaration: true, FunctionDeclaration: true, MethodDefinition: true },
  contexts: [
    "TSDeclareFunction",
    "TSTypeAliasDeclaration",
    "TSInterfaceDeclaration",
    "TSMethodSignature",
    "TSEnumDeclaration",
    "ExportNamedDeclaration > VariableDeclaration",
    "VariableDeclaration:has(VariableDeclarator[init.type=/^(ArrowFunctionExpression|FunctionExpression)$/])",
    "VariableDeclaration:has(VariableDeclarator[init.callee.name=/^(memo|forwardRef)$/])",
    "Property[method=true]",
    ":matches(Property, PropertyDefinition)[value.type=/^(ArrowFunctionExpression|FunctionExpression)$/]",
  ],
};

const testNames = "/^(test|it|describe|suite|before|after|beforeEach|afterEach)$/";
const testObjects = "/^(test|it|describe|suite|t|context)$/";
const testMethods = "/^(skip|todo|only|test|it|describe|suite|before|after|beforeEach|afterEach)$/";
const testCalls = [
  ["ExpressionStatement", "expression"],
  ["ExpressionStatement", "expression.argument"],
  ["ReturnStatement", "argument"],
  ["ReturnStatement", "argument.argument"],
].flatMap(([statement, call]) => [
  `${statement}[${call}.type=CallExpression][${call}.callee.name=${testNames}]`,
  `${statement}[${call}.type=CallExpression][${call}.callee.object.name=${testObjects}][${call}.callee.property.name=${testMethods}]`,
]);

export default defineConfig([
  globalIgnores([
    "dist/",
    "dist-electron/",
    "release/",
    "tmp/",
    ".playwright-cli/",
    "resources/cli/withmate-session.mjs",
    "resources/skills/withmate-glossary/bin/withmate-glossary.mjs",
  ]),
  {
    files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
    linterOptions: { noInlineConfig: true },
    languageOptions: {
      parser: babel,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: { babelrc: false, configFile: false, parserOpts: { plugins: ["typescript"] } },
      },
    },
    plugins: { jsdoc },
    settings: { jsdoc: { mode: "typescript", maxLines: 1 } },
    rules: {
      "jsdoc/require-jsdoc": ["error", declarations],
      "jsdoc/require-description": ["error", { contexts: ["any"], descriptionStyle: "body" }],
      "jsdoc/match-description": ["error", {
        contexts: ["any"],
        mainDescription: { match: "[\\u3040-\\u30ff\\u3400-\\u9fff]", message: "JSDoc の本文は日本語で説明してください。" },
      }],
    },
  },
  {
    files: ["**/*.{jsx,tsx}"],
    languageOptions: {
      parserOptions: { babelOptions: { parserOpts: { plugins: ["typescript", "jsx"] } } },
    },
  },
  {
    files: ["tests/**/*.test.{ts,tsx}"],
    rules: {
      "jsdoc/require-jsdoc": ["error", {
        ...declarations,
        contexts: [...declarations.contexts, ...testCalls],
      }],
    },
  },
]);
