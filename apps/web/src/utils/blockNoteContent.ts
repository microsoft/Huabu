import type { BlockNoteEditor } from '@blocknote/core';

/**
 * Loads content into a BlockNote editor.
 *
 * Prefers `contentJson` when available and in sync with `markdown` (lossless,
 * no round-trip loss). Falls back to parsing `markdown` when JSON is absent or
 * stale (e.g. `content` was edited externally without updating `contentJson`).
 *
 * @returns `true` if `contentJson` was used directly,
 *          `false` if markdown was re-parsed (caller may want to write back a
 *          fresh `contentJson`).
 */
export async function loadBlockNoteContent(
  editor: BlockNoteEditor<any, any, any>,
  markdown: string,
  contentJson: string | null,
): Promise<boolean> {
  if (contentJson !== null) {
    try {
      const parsed: unknown = JSON.parse(contentJson);
      if (Array.isArray(parsed)) {
        const derived = editor.blocksToMarkdownLossy(parsed).trim();
        if (derived === markdown.trim()) {
          // JSON is in sync — load directly (lossless, no round-trip)
          editor.replaceBlocks(editor.document, parsed);
          return true;
        }
        // JSON is stale — fall through to re-parse from Markdown
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
