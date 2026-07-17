export type SchemaArtifacts = Readonly<{
  ddlUrl: URL;
  manifestUrl: URL;
}>;

export function resolveSchemaV1Artifacts(): SchemaArtifacts {
  return {
    ddlUrl: new URL("../../schema/sqlite/v1.sql", import.meta.url),
    manifestUrl: new URL("../../schema/sqlite/manifest-v1.json", import.meta.url),
  };
}

export function resolveSchemaV2Artifacts(): SchemaArtifacts {
  return {
    ddlUrl: new URL("../../schema/sqlite/v2.sql", import.meta.url),
    manifestUrl: new URL("../../schema/sqlite/manifest-v2.json", import.meta.url),
  };
}

export function resolveCurrentSchemaArtifacts(): SchemaArtifacts {
  return resolveSchemaV2Artifacts();
}

export function resolveSchemaArtifactsForVersion(version: number): SchemaArtifacts | undefined {
  switch (version) {
    case 1:
      return resolveSchemaV1Artifacts();
    case 2:
      return resolveSchemaV2Artifacts();
    default:
      return undefined;
  }
}
