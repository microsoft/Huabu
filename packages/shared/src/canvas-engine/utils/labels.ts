// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Utility functions for auto-generated node labels.
 * Ensures consistency across canvas operations and ingestion.
 */

/**
 * Mapping of node types to their label prefixes.
 */
export const NODE_TYPE_TO_PREFIX: Record<string, string> = {
  frame: 'Frame',
  image: 'Image',
  video: 'Video',
  web: 'Web',
  pdf: 'PDF',
  note: 'Note',
  text: 'Text',
  question: 'Question',
  sketch: 'Sketch',
};

/**
 * Extract the number from an auto-generated label.
 * Returns null if the label doesn't match the pattern.
 */
export function extractLabelNumber(
  label: string,
  prefix: string,
): number | null {
  const pattern = new RegExp(`^${prefix} (\\d+)$`);
  const match = label.match(pattern);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Generate the next available auto-generated label for a node type.
 * Scans existing labels to find the next sequential number.
 */
export function generateNextLabel(
  nodeType: string,
  existingLabels: (string | undefined | null)[],
): string {
  const prefix = NODE_TYPE_TO_PREFIX[nodeType] || 'Untitled';

  // Collect all existing numbers for this prefix
  const existingNumbers = new Set<number>();

  existingLabels.forEach((label) => {
    if (label) {
      const num = extractLabelNumber(label, prefix);
      if (num !== null) {
        existingNumbers.add(num);
      }
    }
  });

  // Find the next available number
  let nextNumber = 1;
  while (existingNumbers.has(nextNumber)) {
    nextNumber++;
  }

  return `${prefix} ${nextNumber}`;
}

/**
 * Deduplicate a label against existing labels.
 * If the label is unique, return it as-is.
 * If it already exists, append or increment a numeric suffix:
 *   "photo.png" → "photo.png 2" → "photo.png 3" etc.
 *
 * This is used by node creation flows so that every node
 * entering the canvas gets a unique label while keeping the user's intent.
 */
export function deduplicateLabel(
  label: string,
  existingLabels: (string | undefined | null)[],
): string {
  const existing = new Set(
    existingLabels.filter((l): l is string => typeof l === 'string'),
  );

  // If unique already, use as-is
  if (!existing.has(label)) return label;

  // Try "label 2", "label 3", ...
  // First strip existing trailing " N" if present, so "Image 1" doesn't become "Image 1 2"
  const trailingSuffix = label.match(/^(.+?) (\d+)$/);
  const base = trailingSuffix ? trailingSuffix[1] : label;
  const startNum = trailingSuffix ? parseInt(trailingSuffix[2], 10) + 1 : 1;

  let n = startNum;
  while (existing.has(`${base} ${n}`)) {
    n++;
  }
  return `${base} ${n}`;
}
