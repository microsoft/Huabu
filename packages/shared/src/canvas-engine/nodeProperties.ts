// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type {
  NodeProperties,
  NodePropertiesPatch,
} from '../types/api/canvas.js';

export function isNodeProperties(value: unknown): value is NodeProperties {
  return value !== undefined && hasValidNodeProperties({ properties: value });
}

export function orderedPropertyKeys(
  properties: unknown = {},
  displayKeys: unknown = [],
): string[] {
  if (!isNodeProperties(properties)) {
    console.warn(
      '[node-properties] Invalid property bag; skipping its display',
    );
    return [];
  }
  const validDisplayKeys =
    Array.isArray(displayKeys) &&
    displayKeys.every((key) => typeof key === 'string');
  if (!validDisplayKeys)
    console.warn(
      '[node-properties] Invalid display keys; using property order',
    );
  return [
    ...new Set([
      ...(validDisplayKeys ? displayKeys : []),
      ...Object.keys(properties),
    ]),
  ].filter((key) => Object.prototype.hasOwnProperty.call(properties, key));
}

export function mergeNodeProperties(
  current: NodeProperties | undefined,
  patch: NodePropertiesPatch,
): NodeProperties {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else
      Object.defineProperty(next, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
  }
  return next;
}

/** Engine validation stays dependency-free for browser consumers. */
export function hasValidNodeProperties(
  data: Record<string, unknown>,
  patch = false,
): boolean {
  if (data.properties !== undefined) {
    if (
      !data.properties ||
      typeof data.properties !== 'object' ||
      Array.isArray(data.properties)
    )
      return false;
    if (
      !Object.values(data.properties).every(
        (value) =>
          (patch && value === null) ||
          typeof value === 'string' ||
          typeof value === 'boolean' ||
          (typeof value === 'number' && Number.isFinite(value)) ||
          (Array.isArray(value) &&
            value.every((item) => typeof item === 'string')),
      )
    )
      return false;
  }
  if (
    data.propertyDisplayKeys !== undefined &&
    (!Array.isArray(data.propertyDisplayKeys) ||
      !data.propertyDisplayKeys.every((key) => typeof key === 'string'))
  )
    return false;
  return true;
}
