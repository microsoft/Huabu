// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Literal, non-overlapping case-insensitive matches in original UTF-16 offsets. */
export function* literalTextMatches(
  text: string,
  query: string,
): Generator<{ start: number; end: number }> {
  const needle = query.toLowerCase();
  if (!needle) return;
  const lower = text.toLowerCase();
  let offsets: number[] | undefined;
  if (lower.length !== text.length) {
    offsets = [];
    let sourceOffset = 0;
    for (const character of text) {
      for (let index = 0; index < character.toLowerCase().length; index++)
        offsets.push(sourceOffset);
      sourceOffset += character.length;
    }
    offsets.push(text.length);
  }
  let from = 0;
  while (true) {
    const index = lower.indexOf(needle, from);
    if (index < 0) return;
    const start = offsets?.[index] ?? index;
    const end = offsets?.[index + needle.length] ?? index + needle.length;
    const accepted =
      !offsets ||
      ((index === 0 || offsets[index - 1] !== start) &&
        offsets[index + needle.length - 1] !== end);
    if (accepted) yield { start, end };
    from = index + (accepted ? needle.length : 1);
  }
}
