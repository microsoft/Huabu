// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared label-ownership policy.
 *
 * A label is "protected" when a user or an agent set it explicitly and it is
 * non-empty. Protected labels must never be overwritten by an auto-generated
 * (LLM / extracted) label. This single predicate is consumed in two places so
 * the rule has one source of truth:
 *
 *   - {@link file://../dispatcher.ts `buildPlan`} — drops `generate_label` from
 *     the execution plan so the expensive Enrich stage never runs.
 *   - {@link file://./stages/project.ts `project`} — refuses to emit a
 *     `label` patch even if some earlier stage produced a suggestion.
 */
export function isLabelProtected(
  labelSource: unknown,
  label: unknown,
): boolean {
  const source = typeof labelSource === 'string' ? labelSource : undefined;
  const text = typeof label === 'string' ? label : '';
  return (source === 'user' || source === 'agent') && text.trim().length > 0;
}
