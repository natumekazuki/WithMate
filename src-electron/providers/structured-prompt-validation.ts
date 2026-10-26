const SUPPORTED_SCHEMA_KEYS = new Set([
  "type", "enum", "anyOf", "oneOf", "properties", "required", "additionalProperties", "items",
  "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems",
  "$schema", "title", "description",
]);
const SCHEMA_TYPES = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);

function inspectSchema(schema: unknown, path: string): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [`${path} must be a schema object`];
  const record = schema as Record<string, unknown>;
  const errors = Object.keys(record).filter((key) => !SUPPORTED_SCHEMA_KEYS.has(key))
    .map((key) => `${path}: unsupported schema keyword ${key}`);
  if (record.type !== undefined && (typeof record.type !== "string" || !SCHEMA_TYPES.has(record.type))) {
    errors.push(`${path}: unsupported schema type`);
  }
  if (record.enum !== undefined && (!Array.isArray(record.enum) || !record.enum.length
    || record.enum.some((value) => value !== null && !["string", "boolean", "number"].includes(typeof value)))) {
    errors.push(`${path}: enum must contain primitive values`);
  }
  for (const key of ["anyOf", "oneOf"]) {
    const branches = record[key];
    if (branches === undefined) continue;
    if (!Array.isArray(branches) || !branches.length) errors.push(`${path}.${key} must contain schemas`);
    else branches.forEach((branch, index) => errors.push(...inspectSchema(branch, `${path}.${key}[${index}]`)));
  }
  if (record.properties !== undefined) {
    if (!record.properties || typeof record.properties !== "object" || Array.isArray(record.properties)) {
      errors.push(`${path}.properties must be an object`);
    } else {
      for (const [key, child] of Object.entries(record.properties)) errors.push(...inspectSchema(child, `${path}.${key}`));
    }
  }
  if (record.required !== undefined && (!Array.isArray(record.required) || record.required.some((key) => typeof key !== "string"))) {
    errors.push(`${path}.required must be a string array`);
  }
  if (record.additionalProperties !== undefined && typeof record.additionalProperties !== "boolean") {
    errors.push(`${path}: only boolean additionalProperties is supported`);
  }
  if (record.items !== undefined) errors.push(...inspectSchema(record.items, `${path}.items`));
  for (const key of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]) {
    const bound = record[key];
    if (bound !== undefined && (typeof bound !== "number" || !Number.isFinite(bound)
      || (["minLength", "maxLength", "minItems", "maxItems"].includes(key) && (!Number.isInteger(bound) || bound < 0)))) {
      errors.push(`${path}.${key} is not a valid bound`);
    }
  }
  return errors;
}

export function validateStructuredPromptSchemaValue(schema: unknown, value: unknown): string[] {
  const errors = inspectSchema(schema, "$schema");
  return errors.length ? errors : validateValue(schema, value);
}

function validateValue(schema: unknown, value: unknown, path = "$"): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return [];
  }

  const schemaRecord = schema as Record<string, unknown>;
  const errors: string[] = [];
  const anyOf = schemaRecord.anyOf;
  if (Array.isArray(anyOf)) {
    if (!anyOf.some((candidate) => validateValue(candidate, value, path).length === 0)) {
      errors.push(`${path} must match at least one anyOf schema`);
    }
  }

  const oneOf = schemaRecord.oneOf;
  if (Array.isArray(oneOf)) {
    const matchedCount = oneOf.filter((candidate) => validateValue(candidate, value, path).length === 0)
      .length;
    if (matchedCount !== 1) {
      errors.push(`${path} must match exactly one oneOf schema`);
    }
  }

  const expectedType = schemaRecord.type;
  if (typeof expectedType === "string" && !matchesJsonSchemaType(value, expectedType)) {
    errors.push(`${path} must be ${expectedType}`);
    return errors;
  }

  const enumValues = schemaRecord.enum;
  if (Array.isArray(enumValues) && !enumValues.some((enumValue) => Object.is(enumValue, value))) {
    errors.push(`${path} must match one of the enum values`);
  }

  if (typeof value === "number") {
    if (typeof schemaRecord.minimum === "number" && value < schemaRecord.minimum) {
      errors.push(`${path} must be >= ${schemaRecord.minimum}`);
    }
    if (typeof schemaRecord.maximum === "number" && value > schemaRecord.maximum) {
      errors.push(`${path} must be <= ${schemaRecord.maximum}`);
    }
  }

  if (typeof value === "string") {
    if (typeof schemaRecord.minLength === "number" && [...value].length < schemaRecord.minLength) {
      errors.push(`${path} length must be >= ${schemaRecord.minLength}`);
    }
    if (typeof schemaRecord.maxLength === "number" && [...value].length > schemaRecord.maxLength) {
      errors.push(`${path} length must be <= ${schemaRecord.maxLength}`);
    }
  }

  if (schemaRecord.type === "object" || schemaRecord.properties || schemaRecord.required) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${path} must be object`);
      return errors;
    }

    const valueRecord = value as Record<string, unknown>;
    const properties = schemaRecord.properties && typeof schemaRecord.properties === "object" && !Array.isArray(schemaRecord.properties)
      ? schemaRecord.properties as Record<string, unknown>
      : {};
    const required = Array.isArray(schemaRecord.required)
      ? schemaRecord.required.filter((property): property is string => typeof property === "string")
      : [];

    for (const property of required) {
      if (!Object.prototype.hasOwnProperty.call(valueRecord, property)) {
        errors.push(`${path}.${property} is required`);
      }
    }

    if (schemaRecord.additionalProperties === false) {
      for (const property of Object.keys(valueRecord)) {
        if (!Object.prototype.hasOwnProperty.call(properties, property)) {
          errors.push(`${path}.${property} is not allowed`);
        }
      }
    }

    for (const [property, propertySchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(valueRecord, property)) {
        errors.push(...validateValue(propertySchema, valueRecord[property], `${path}.${property}`));
      }
    }
  }

  if (schemaRecord.type === "array" || schemaRecord.items) {
    if (!Array.isArray(value)) {
      errors.push(`${path} must be array`);
      return errors;
    }

    if (typeof schemaRecord.minItems === "number" && value.length < schemaRecord.minItems) {
      errors.push(`${path} length must be >= ${schemaRecord.minItems}`);
    }
    if (typeof schemaRecord.maxItems === "number" && value.length > schemaRecord.maxItems) {
      errors.push(`${path} length must be <= ${schemaRecord.maxItems}`);
    }

    if (schemaRecord.items) {
      for (const [index, item] of value.entries()) {
        errors.push(...validateValue(schemaRecord.items, item, `${path}[${index}]`));
      }
    }
  }

  return errors;
}

function matchesJsonSchemaType(value: unknown, expectedType: string): boolean {
  switch (expectedType) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "null":
      return value === null;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return !!value && typeof value === "object" && !Array.isArray(value);
    case "string":
      return typeof value === "string";
    default:
      return false;
  }
}
