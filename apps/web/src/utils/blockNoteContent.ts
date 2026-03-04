import type { BlockNoteEditor } from '@blocknote/core';

/**
 * Loads content into a BlockNote editor.
 *
 * Prefers `contentJson` when it is in sync with `markdown`. Sync is determined
 * by comparing `markdown` against `contentJsonSource` — the markdown string
 * that was canonical at the time `contentJson` was last generated. This avoids
 * the lossy `blocksToMarkdownLossy` round-trip (which cannot faithfully
 * reproduce tables and other rich blocks).
 *
 * Falls back to parsing `markdown` when:
 * - `contentJson` is absent, OR
 * - `contentJsonSource` doesn't match `markdown` (edited externally, e.g. by
 *   the AI agent writing directly to `content`).
 *
 * @returns `true` if `contentJson` was used directly,
 *          `false` if markdown was re-parsed (caller should write back a fresh
 *          `contentJson` and `contentJsonSource`).
 */
export async function loadBlockNoteContent(
  editor: BlockNoteEditor<any, any, any>,
  markdown: string,
  contentJson: string | null,
  contentJsonSource: string | null,
): Promise<boolean> {
  if (contentJson !== null && contentJsonSource === markdown) {
    try {
      const parsed: unknown = JSON.parse(contentJson);
      if (Array.isArray(parsed)) {
        editor.replaceBlocks(editor.document, parsed);
        return true;
      }
    } catch {
      // Malformed JSON — fall through
    }
  }

  // Parse from Markdown (new note, legacy data, or external edit)
  const md = markdown.trim() === '' ? '\n' : markdown;
  const blocks = await editor.tryParseMarkdownToBlocks(md);
  editor.replaceBlocks(editor.document, blocks);
  return false;
}
