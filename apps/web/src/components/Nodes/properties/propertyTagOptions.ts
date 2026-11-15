// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Every value already used for the property `name` across `nodes`, sorted.
 *
 * Options have no registry: a tag exists while some node uses it. Text values
 * of the same property count too, so a property being converted to tags can
 * pick up what other nodes still store as plain text.
 */
export function propertyTagOptions(
  nodes: readonly { data?: Record<string, unknown> }[],
  name: string,
): string[] {
  const options = new Set<string>();
  for (const node of nodes) {
    const properties = node.data?.properties;
    if (!properties || typeof properties !== 'object') continue;
    if (!Object.hasOwn(properties, name)) continue;
    const value = (properties as Record<string, unknown>)[name];
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'string' && item.trim()) options.add(item.trim());
    }
  }
  return [...options].sort((a, b) => a.localeCompare(b));
}
