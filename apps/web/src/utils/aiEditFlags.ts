/**
 * One-shot per-node attribution flag for note content edits.
 *
 * The canvas-command executor sets the flag for every `MERGE_NODE_DATA`
 * patch that (a) targets a note's `content` field AND (b) is part of a
 * batch with `source: 'agent'` — i.e. the AI agent authored the change.
 * `NotePreview` consumes the flag the next time the editor's
 * `onExternalUpdate` fires so it can decide whether to stamp
 * `MarkdownProvenance` (AI) or to merely shift existing markers
 * (non-AI, e.g. another panel echoing a user edit on the same node).
 *
 * The flag is stored outside React state on purpose:
 *  - The executor runs synchronously before any React re-render, so
 *    the flag is always set by the time `NotePreview` receives the
 *    new `data` prop.
 *  - Consumption is one-shot per `consumeAiContentEdit` call; if no
 *    consumer reads it (e.g. `VITE_PROVENANCE=off`) the flag should
 *    still be cleared so it does not leak into the next external
 *    update — call `consumeAiContentEdit` unconditionally at the top
 *    of the handler, branch on the boolean afterwards.
 *
 * Anonymous (unidentified) nodes never set or consume the flag — the
 * executor only marks a node when it has an `id`, and `NotePreview`
 * only consumes when its `id` prop is supplied.
 */
const pending = new Set<string>();

/**
 * Mark the given node id as having a pending AI-authored content edit.
 * Idempotent — subsequent calls before consumption do not stack.
 */
export function markAiContentEdit(nodeId: string): void {
  pending.add(nodeId);
}

/**
 * Atomically test-and-clear the flag for `nodeId`. Returns `true` iff
 * the flag was set; the caller should branch its provenance stamping
 * logic on this return value.
 */
export function consumeAiContentEdit(nodeId: string): boolean {
  if (!pending.has(nodeId)) return false;
  pending.delete(nodeId);
  return true;
}
