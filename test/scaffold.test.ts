import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { PERSISTENCE_PROTOCOL_VERSION } from "../src/shared/persistence-protocol.js";
import { resolveCurrentSchemaArtifacts, resolveSchemaV1Artifacts } from "../src/persistence-worker/schema-artifacts.js";

test("persistence protocol starts at version 1", () => {
  assert.equal(PERSISTENCE_PROTOCOL_VERSION, 1);
});

test("schema v1 artifacts resolve from the source worker location", () => {
  const artifacts = resolveSchemaV1Artifacts();

  assert.equal(fs.existsSync(artifacts.ddlUrl), true);
  assert.equal(fs.existsSync(artifacts.manifestUrl), true);
});

test("schema v1 manifest remains the immutable released artifact", () => {
  const artifacts = resolveSchemaV1Artifacts();
  const manifest = JSON.parse(fs.readFileSync(artifacts.manifestUrl, "utf8")) as {
    schemaVersion: unknown;
    schemaDefinitionSha256: unknown;
  };

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.schemaDefinitionSha256, "0218a796da70d9c44ca928062968663962a8dbc63138d23a443bd3dda47cb022");
});

test("current schema artifacts resolve independently from immutable schema v1", () => {
  const current = resolveCurrentSchemaArtifacts();
  const version1 = resolveSchemaV1Artifacts();

  assert.equal(fs.existsSync(current.ddlUrl), true);
  assert.equal(fs.existsSync(current.manifestUrl), true);
  assert.notEqual(current.ddlUrl.href, version1.ddlUrl.href);
  assert.notEqual(current.manifestUrl.href, version1.manifestUrl.href);
});
