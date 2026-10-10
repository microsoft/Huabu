// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { InkInterpretation } from '../types/api/agent.js';

export const INK_INTERPRETATION_TEXT_LIMIT = 120;
export const INK_INTERPRETATION_EXPLANATION_LIMIT = 600;

/** Read new reports and historical tool payloads without importing zod into Web. */
export function readInkInterpretation(
  value: unknown,
): InkInterpretation | undefined {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== 'object') return undefined;
  let data = value as Record<string, unknown>;
  if (data.tool === 'report_ink_intent') {
    if (data.status === 'error') return { state: 'failed' };
    if (
      data.status !== 'success' ||
      !data.data ||
      typeof data.data !== 'object'
    )
      return undefined;
    data = data.data as Record<string, unknown>;
  }
  if (data.status === 'clarify' || data.status === 'unsupported') {
    return { state: 'legacy' };
  }
  if (data.status !== undefined && data.status !== 'inferred') return undefined;
  if (typeof data.text !== 'string') return undefined;
  const text = data.text.trim();
  if (
    !text ||
    text.length > INK_INTERPRETATION_TEXT_LIMIT ||
    /[\r\n]/.test(text)
  )
    return undefined;
  if (data.explanation !== undefined && typeof data.explanation !== 'string')
    return undefined;
  const explanation = data.explanation?.trim();
  if (
    explanation !== undefined &&
    (!explanation || explanation.length > INK_INTERPRETATION_EXPLANATION_LIMIT)
  )
    return undefined;
  return { state: 'reported', text, ...(explanation ? { explanation } : {}) };
}

export function settleInkInterpretation(
  interpretation: InkInterpretation | undefined,
  outcome: 'done' | 'error' | 'interrupted',
): InkInterpretation {
  if (interpretation && interpretation.state !== 'pending')
    return interpretation;
  return {
    state:
      outcome === 'done'
        ? 'missing'
        : outcome === 'error'
          ? 'failed'
          : 'interrupted',
  };
}
