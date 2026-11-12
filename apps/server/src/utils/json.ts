// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createHash } from 'node:crypto';

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export function assertJsonValue(
  value: unknown,
  context: string,
  seen: Set<object>,
): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError(`${context} contains a non-finite number`);
    return;
  }
  // Preserve the existing record serializer's JSON.stringify semantics.
  if (value === undefined) return;
  if (typeof value !== 'object')
    throw new TypeError(`${context} contains a non-JSON value`);
  if (seen.has(value)) throw new TypeError(`${context} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index))
          throw new TypeError(`${context} contains a sparse array`);
        assertJsonValue(value[index], `${context}[${index}]`, seen);
      }
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError(`${context} contains a non-plain object`);
    for (const [key, entry] of Object.entries(value))
      assertJsonValue(entry, `${context}.${key}`, seen);
  } finally {
    seen.delete(value);
  }
}

export function stringifyJson(value: unknown, context: string): string {
  assertJsonValue(value, context, new Set());
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new TypeError(`${context} is not representable as JSON`);
  return encoded;
}

/** Hash JSON values independently of object property insertion order. */
export function digestJson(value: unknown): string {
  const normalized: unknown = JSON.parse(stringifyJson(value, 'Operation'));
  const canonical = (entry: unknown): string => {
    if (Array.isArray(entry)) return `[${entry.map(canonical).join(',')}]`;
    if (entry !== null && typeof entry === 'object')
      return `{${Object.entries(entry)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
        .join(',')}}`;
    return JSON.stringify(entry);
  };
  return createHash('sha256').update(canonical(normalized)).digest('hex');
}
