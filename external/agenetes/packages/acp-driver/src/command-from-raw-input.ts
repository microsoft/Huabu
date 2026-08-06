/**
 * Derive a human-readable command string from a tool call's ACP
 * `rawInput`. Shell/terminal tools carry `{ command }` (string or argv
 * array); other tools have no command. Returns `undefined` when no usable
 * command is present so renderers can stay title-only.
 *
 * NOTE: this is a verbatim, dependency-free copy of the host's
 * `commandFromRawInput` (packages/shared assistant-parts). It is
 * duplicated here rather than imported because this package must not
 * depend on `@huabu/shared`; the host keeps its own copy for the
 * history builder + web. The logic is a tiny, stable pure function.
 */
export function commandFromRawInput(rawInput: unknown): string | undefined {
  if (!rawInput || typeof rawInput !== 'object') return undefined;
  const cmd = (rawInput as Record<string, unknown>).command;
  if (typeof cmd === 'string' && cmd.trim().length > 0) return cmd.trim();
  if (Array.isArray(cmd) && cmd.every((c) => typeof c === 'string')) {
    const joined = cmd.join(' ').trim();
    return joined.length > 0 ? joined : undefined;
  }
  return undefined;
}
