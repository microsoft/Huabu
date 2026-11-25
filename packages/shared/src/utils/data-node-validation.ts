// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Pure, dependency-free (zod-free) runtime validation and formatting helpers
 * for JSON Data Nodes and Interactive View schemas/values.
 *
 * Exported from `@huabu/shared/data-node-validation` so the web client can
 * enforce identical schema, bounds, and secret-key validation without pulling
 * `zod` into the browser bundle.
 */

export type InteractiveViewJsonValue =
  | string
  | number
  | boolean
  | null
  | InteractiveViewJsonValue[]
  | { [key: string]: InteractiveViewJsonValue };

export type InteractiveViewStateSchemaV1 =
  | {
      type: 'string';
      enum?: string[];
      minLength?: number;
      maxLength?: number;
    }
  | {
      type: 'number';
      enum?: number[];
      minimum?: number;
      maximum?: number;
    }
  | {
      type: 'boolean';
    }
  | {
      type: 'null';
    }
  | {
      type: 'array';
      items: InteractiveViewStateSchemaV1;
      minItems?: number;
      maxItems?: number;
    }
  | {
      type: 'object';
      properties: Record<string, InteractiveViewStateSchemaV1>;
      required?: string[];
      additionalProperties: false;
    };

export type DataNodeSchemaV1 = InteractiveViewStateSchemaV1;

const MAX_INTERACTIVE_VIEW_JSON_DEPTH = 32;
const MAX_INTERACTIVE_VIEW_JSON_NODES = 10_000;
const MAX_INTERACTIVE_VIEW_JSON_COLLECTION_SIZE = 1_000;
const MAX_INTERACTIVE_VIEW_JSON_STRING_LENGTH = 65_536;

/** Maximum UTF-8 byte length of a Data Node's serialized JSON body. */
export const DATA_NODE_MAX_BYTES = 65_536;

const PROHIBITED_SECRET_KEY_PATTERN =
  /(?:password|passwd|secret|token|apikey|privatekey|credentials?)$/;

export function isProhibitedSecretFieldName(key: string): boolean {
  const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return PROHIBITED_SECRET_KEY_PATTERN.test(normalizedKey);
}

export function validateDataNodeSecretKeys(
  value: unknown,
  path = '$',
): string | null {
  const pending: Array<{ value: unknown; path: string }> = [{ value, path }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (
      !current ||
      current.value === null ||
      typeof current.value !== 'object'
    ) {
      continue;
    }
    if (Array.isArray(current.value)) {
      for (let i = current.value.length - 1; i >= 0; i -= 1) {
        pending.push({
          value: current.value[i],
          path: `${current.path}[${i}]`,
        });
      }
      continue;
    }
    for (const [key, entry] of Object.entries(current.value)) {
      if (isProhibitedSecretFieldName(key)) {
        return `${current.path}.${key} is a prohibited secret field`;
      }
      pending.push({ value: entry, path: `${current.path}.${key}` });
    }
  }
  return null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function validateInteractiveViewJsonBounds(
  value: unknown,
): string | null {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      break;
    }
    visited += 1;
    if (visited > MAX_INTERACTIVE_VIEW_JSON_NODES) {
      return 'JSON input contains too many values';
    }
    if (current.depth > MAX_INTERACTIVE_VIEW_JSON_DEPTH) {
      return 'JSON input is nested too deeply';
    }
    if (
      current.value === null ||
      typeof current.value === 'boolean' ||
      (typeof current.value === 'number' && Number.isFinite(current.value))
    ) {
      continue;
    }
    if (typeof current.value === 'string') {
      if (current.value.length > MAX_INTERACTIVE_VIEW_JSON_STRING_LENGTH) {
        return 'JSON input contains an oversized string';
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_INTERACTIVE_VIEW_JSON_COLLECTION_SIZE) {
        return 'JSON input contains an oversized array';
      }
      for (const entry of current.value) {
        pending.push({ value: entry, depth: current.depth + 1 });
      }
      continue;
    }
    if (!isPlainRecord(current.value)) {
      return 'Input must contain only JSON values';
    }
    const entries = Object.entries(current.value);
    if (entries.length > MAX_INTERACTIVE_VIEW_JSON_COLLECTION_SIZE) {
      return 'JSON input contains an oversized object';
    }
    for (const [key, entry] of entries) {
      if (key.length > 1_024) {
        return 'JSON input contains an oversized key';
      }
      pending.push({ value: entry, depth: current.depth + 1 });
    }
  }
  return null;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPositiveIntUpTo(value: unknown, max: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= max
  );
}

function hasOnlyAllowedKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): string | null {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      return key;
    }
  }
  return null;
}

const STRING_SCHEMA_KEYS = new Set(['type', 'enum', 'minLength', 'maxLength']);
const NUMBER_SCHEMA_KEYS = new Set(['type', 'enum', 'minimum', 'maximum']);
const PRIMITIVE_SCHEMA_KEYS = new Set(['type']);
const ARRAY_SCHEMA_KEYS = new Set(['type', 'items', 'minItems', 'maxItems']);
const OBJECT_SCHEMA_KEYS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
]);

/**
 * Pure structural parser/validator for `DataNodeSchemaV1` /
 * `InteractiveViewStateSchemaV1` (mirrors `interactiveViewStateSchemaV1Schema`
 * without requiring `zod` at runtime).
 */
export function parseDataNodeSchemaStructure(
  raw: unknown,
  path = '$',
): { ok: true; schema: DataNodeSchemaV1 } | { ok: false; message: string } {
  if (!isPlainRecord(raw)) {
    return { ok: false, message: `${path} must be a schema object` };
  }
  switch (raw.type) {
    case 'string': {
      const unknownKey = hasOnlyAllowedKeys(raw, STRING_SCHEMA_KEYS);
      if (unknownKey) {
        return {
          ok: false,
          message: `${path}.${unknownKey} is not an allowed string schema field`,
        };
      }
      if (
        raw.enum !== undefined &&
        (!Array.isArray(raw.enum) ||
          raw.enum.length === 0 ||
          !raw.enum.every((item) => typeof item === 'string'))
      ) {
        return {
          ok: false,
          message: `${path}.enum must be a non-empty string array`,
        };
      }
      if (raw.minLength !== undefined && !isNonNegativeInt(raw.minLength)) {
        return {
          ok: false,
          message: `${path}.minLength must be a non-negative integer`,
        };
      }
      if (
        raw.maxLength !== undefined &&
        !isPositiveIntUpTo(raw.maxLength, 65_536)
      ) {
        return {
          ok: false,
          message: `${path}.maxLength must be a positive integer <= 65536`,
        };
      }
      return {
        ok: true,
        schema: {
          type: 'string',
          ...(raw.enum !== undefined ? { enum: raw.enum as string[] } : {}),
          ...(raw.minLength !== undefined
            ? { minLength: raw.minLength as number }
            : {}),
          ...(raw.maxLength !== undefined
            ? { maxLength: raw.maxLength as number }
            : {}),
        },
      };
    }
    case 'number': {
      const unknownKey = hasOnlyAllowedKeys(raw, NUMBER_SCHEMA_KEYS);
      if (unknownKey) {
        return {
          ok: false,
          message: `${path}.${unknownKey} is not an allowed number schema field`,
        };
      }
      if (
        raw.enum !== undefined &&
        (!Array.isArray(raw.enum) ||
          raw.enum.length === 0 ||
          !raw.enum.every(
            (item) => typeof item === 'number' && Number.isFinite(item),
          ))
      ) {
        return {
          ok: false,
          message: `${path}.enum must be a non-empty finite number array`,
        };
      }
      if (
        raw.minimum !== undefined &&
        (typeof raw.minimum !== 'number' || !Number.isFinite(raw.minimum))
      ) {
        return {
          ok: false,
          message: `${path}.minimum must be a finite number`,
        };
      }
      if (
        raw.maximum !== undefined &&
        (typeof raw.maximum !== 'number' || !Number.isFinite(raw.maximum))
      ) {
        return {
          ok: false,
          message: `${path}.maximum must be a finite number`,
        };
      }
      return {
        ok: true,
        schema: {
          type: 'number',
          ...(raw.enum !== undefined ? { enum: raw.enum as number[] } : {}),
          ...(raw.minimum !== undefined
            ? { minimum: raw.minimum as number }
            : {}),
          ...(raw.maximum !== undefined
            ? { maximum: raw.maximum as number }
            : {}),
        },
      };
    }
    case 'boolean':
    case 'null': {
      const unknownKey = hasOnlyAllowedKeys(raw, PRIMITIVE_SCHEMA_KEYS);
      if (unknownKey) {
        return {
          ok: false,
          message: `${path}.${unknownKey} is not allowed on ${raw.type} schema`,
        };
      }
      return { ok: true, schema: { type: raw.type } };
    }
    case 'array': {
      const unknownKey = hasOnlyAllowedKeys(raw, ARRAY_SCHEMA_KEYS);
      if (unknownKey) {
        return {
          ok: false,
          message: `${path}.${unknownKey} is not an allowed array schema field`,
        };
      }
      const itemsParsed = parseDataNodeSchemaStructure(
        raw.items,
        `${path}.items`,
      );
      if (!itemsParsed.ok) {
        return itemsParsed;
      }
      if (raw.minItems !== undefined && !isNonNegativeInt(raw.minItems)) {
        return {
          ok: false,
          message: `${path}.minItems must be a non-negative integer`,
        };
      }
      if (
        raw.maxItems !== undefined &&
        !isPositiveIntUpTo(raw.maxItems, 1_000)
      ) {
        return {
          ok: false,
          message: `${path}.maxItems must be a positive integer <= 1000`,
        };
      }
      return {
        ok: true,
        schema: {
          type: 'array',
          items: itemsParsed.schema,
          ...(raw.minItems !== undefined
            ? { minItems: raw.minItems as number }
            : {}),
          ...(raw.maxItems !== undefined
            ? { maxItems: raw.maxItems as number }
            : {}),
        },
      };
    }
    case 'object': {
      const unknownKey = hasOnlyAllowedKeys(raw, OBJECT_SCHEMA_KEYS);
      if (unknownKey) {
        return {
          ok: false,
          message: `${path}.${unknownKey} is not an allowed object schema field`,
        };
      }
      if (
        raw.additionalProperties !== undefined &&
        raw.additionalProperties !== false
      ) {
        return {
          ok: false,
          message: `${path}.additionalProperties must be false`,
        };
      }
      if (!isPlainRecord(raw.properties)) {
        return {
          ok: false,
          message: `${path}.properties must be an object`,
        };
      }
      const properties: Record<string, InteractiveViewStateSchemaV1> = {};
      for (const [key, propRaw] of Object.entries(raw.properties)) {
        if (key.length < 1 || key.length > 128) {
          return {
            ok: false,
            message: `${path}.properties key "${key}" must be 1..128 characters`,
          };
        }
        const propParsed = parseDataNodeSchemaStructure(
          propRaw,
          `${path}.properties.${key}`,
        );
        if (!propParsed.ok) {
          return propParsed;
        }
        properties[key] = propParsed.schema;
      }
      if (
        raw.required !== undefined &&
        (!Array.isArray(raw.required) ||
          !raw.required.every(
            (item) =>
              typeof item === 'string' &&
              item.length >= 1 &&
              item.length <= 128,
          ))
      ) {
        return {
          ok: false,
          message: `${path}.required must be an array of property names`,
        };
      }
      return {
        ok: true,
        schema: {
          type: 'object',
          properties,
          ...(raw.required !== undefined
            ? { required: raw.required as string[] }
            : {}),
          additionalProperties: false,
        },
      };
    }
    default:
      return {
        ok: false,
        message: `${path}.type must be one of string, number, boolean, null, array, object`,
      };
  }
}

export function validateInteractiveViewStateSchema(
  schema: InteractiveViewStateSchemaV1,
  path = '$',
): string | null {
  switch (schema.type) {
    case 'string':
      if (
        schema.minLength !== undefined &&
        schema.maxLength !== undefined &&
        schema.minLength > schema.maxLength
      ) {
        return `${path}.minLength must not exceed maxLength`;
      }
      return null;
    case 'number':
      if (
        schema.minimum !== undefined &&
        schema.maximum !== undefined &&
        schema.minimum > schema.maximum
      ) {
        return `${path}.minimum must not exceed maximum`;
      }
      return null;
    case 'boolean':
    case 'null':
      return null;
    case 'array':
      if (
        schema.minItems !== undefined &&
        schema.maxItems !== undefined &&
        schema.minItems > schema.maxItems
      ) {
        return `${path}.minItems must not exceed maxItems`;
      }
      return validateInteractiveViewStateSchema(schema.items, `${path}.items`);
    case 'object': {
      for (const required of schema.required ?? []) {
        if (!(required in schema.properties)) {
          return `${path}.required references undeclared property "${required}"`;
        }
      }
      for (const [key, property] of Object.entries(schema.properties)) {
        if (isProhibitedSecretFieldName(key)) {
          return `${path}.properties.${key} is a prohibited secret field`;
        }
        const issue = validateInteractiveViewStateSchema(
          property,
          `${path}.properties.${key}`,
        );
        if (issue) {
          return issue;
        }
      }
      return null;
    }
  }
}

export function validateInteractiveViewState(
  schema: InteractiveViewStateSchemaV1,
  value: InteractiveViewJsonValue,
  path = '$',
): string | null {
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') {
        return `${path} must be a string`;
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        return `${path} must contain at least ${schema.minLength} characters`;
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        return `${path} must contain at most ${schema.maxLength} characters`;
      }
      if (schema.enum && !schema.enum.includes(value)) {
        return `${path} must be one of the declared values`;
      }
      return null;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `${path} must be a finite number`;
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        return `${path} must be at least ${schema.minimum}`;
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        return `${path} must be at most ${schema.maximum}`;
      }
      if (schema.enum && !schema.enum.includes(value)) {
        return `${path} must be one of the declared values`;
      }
      return null;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${path} must be a boolean`;
    case 'null':
      return value === null ? null : `${path} must be null`;
    case 'array': {
      if (!Array.isArray(value)) {
        return `${path} must be an array`;
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        return `${path} must contain at least ${schema.minItems} items`;
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        return `${path} must contain at most ${schema.maxItems} items`;
      }
      for (let index = 0; index < value.length; index += 1) {
        const entry = value[index];
        if (entry === undefined) {
          return `${path}[${index}] must be valid JSON`;
        }
        const issue = validateInteractiveViewState(
          schema.items,
          entry,
          `${path}[${index}]`,
        );
        if (issue) {
          return issue;
        }
      }
      return null;
    }
    case 'object': {
      if (value === null || Array.isArray(value) || typeof value !== 'object') {
        return `${path} must be an object`;
      }
      for (const required of schema.required ?? []) {
        if (!(required in value)) {
          return `${path}.${required} is required`;
        }
      }
      for (const [key, entry] of Object.entries(value)) {
        const propertySchema = schema.properties[key];
        if (!propertySchema) {
          return `${path}.${key} is not a declared property`;
        }
        const issue = validateInteractiveViewState(
          propertySchema,
          entry,
          `${path}.${key}`,
        );
        if (issue) {
          return issue;
        }
      }
      return null;
    }
  }
}

export type DataNodeValidationResult =
  | {
      ok: true;
      value: InteractiveViewJsonValue;
      formatted: string;
    }
  | {
      ok: false;
      code: 'invalid_json' | 'invalid_data_schema' | 'invalid_data_value';
      message: string;
    };

function utf8ByteLength(input: string): number {
  return new TextEncoder().encode(input).byteLength;
}

/**
 * Parse, validate, and canonicalize (2-space indented) a Data Node's JSON body
 * against structural bounds, prohibited secret keys, and optional `dataSchema`.
 */
export function parseAndNormalizeDataNodeContent(
  rawContent: string,
  dataSchema?: DataNodeSchemaV1 | null,
): DataNodeValidationResult {
  if (utf8ByteLength(rawContent) > DATA_NODE_MAX_BYTES) {
    return {
      ok: false,
      code: 'invalid_data_value',
      message: `Data node content exceeds the ${DATA_NODE_MAX_BYTES}-byte limit`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch (error) {
    return {
      ok: false,
      code: 'invalid_json',
      message:
        error instanceof Error
          ? `Invalid JSON: ${error.message}`
          : 'Invalid JSON',
    };
  }
  return validateAndFormatDataNodeValue(parsed, dataSchema);
}

export function validateAndFormatDataNodeValue(
  rawValue: unknown,
  dataSchema?: DataNodeSchemaV1 | null,
): DataNodeValidationResult {
  const boundsIssue = validateInteractiveViewJsonBounds(rawValue);
  if (boundsIssue) {
    return { ok: false, code: 'invalid_data_value', message: boundsIssue };
  }
  const jsonValue = rawValue as InteractiveViewJsonValue;
  const secretIssue = validateDataNodeSecretKeys(jsonValue);
  if (secretIssue) {
    return { ok: false, code: 'invalid_data_value', message: secretIssue };
  }
  if (dataSchema !== undefined && dataSchema !== null) {
    const schemaCheck = parseDataNodeSchemaStructure(dataSchema);
    if (!schemaCheck.ok) {
      return {
        ok: false,
        code: 'invalid_data_schema',
        message: schemaCheck.message,
      };
    }
    const schemaIssue = validateInteractiveViewStateSchema(schemaCheck.schema);
    if (schemaIssue) {
      return { ok: false, code: 'invalid_data_schema', message: schemaIssue };
    }
    const valueIssue = validateInteractiveViewState(
      schemaCheck.schema,
      jsonValue,
    );
    if (valueIssue) {
      return { ok: false, code: 'invalid_data_value', message: valueIssue };
    }
  }
  const formatted = JSON.stringify(jsonValue, null, 2);
  if (utf8ByteLength(formatted) > DATA_NODE_MAX_BYTES) {
    return {
      ok: false,
      code: 'invalid_data_value',
      message: `Formatted data node content exceeds the ${DATA_NODE_MAX_BYTES}-byte limit`,
    };
  }
  return { ok: true, value: jsonValue, formatted };
}
