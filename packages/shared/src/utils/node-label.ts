// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Nonempty user/Agent labels are protected from automatic replacement. */
export function isLabelProtected(
  labelSource: unknown,
  label: unknown,
): boolean {
  const source = typeof labelSource === 'string' ? labelSource : undefined;
  const text = typeof label === 'string' ? label : '';
  return (source === 'user' || source === 'agent') && text.trim().length > 0;
}
