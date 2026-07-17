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
