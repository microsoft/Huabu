// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export function stripOfficeparserPreamble(markdown: string): string {
  if (typeof markdown !== 'string' || markdown.length === 0) return markdown;
  let out = markdown.replace(/^---\s*\n[\s\S]*?\n---\s*\n+/, '');
  out = out.replace(/^(?:[-*_]{3,}[ \t]*\n+)+/, '');
  return out;
}
