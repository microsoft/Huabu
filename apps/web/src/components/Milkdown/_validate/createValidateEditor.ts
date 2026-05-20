/**
 * Phase 1a validation harness: minimal Crepe factory for round-trip testing
 * and manual feature verification (KaTeX, drag handle, IME).
 *
 * Scope: this whole `_validate/` directory is dev-only scaffolding and
 * MUST be deleted at the end of Phase 1b. Do not import from it elsewhere.
 */

import { Crepe } from '@milkdown/crepe';
import { replaceAll } from '@milkdown/utils';

import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/classic.css';
import 'katex/dist/katex.min.css';

export interface ValidateEditorHandle {
  /** Snapshot the editor's current document as markdown. */
  getMarkdown(): string;
  /**
   * Replace the entire document with new markdown.
   *
   * Wraps Milkdown's `replaceAll` macro — this is the operation the AI
   * streaming path will use to push fresh content into a live editor,
   * so it (not editor construction) is what Gate G5 should measure.
   */
  setMarkdown(markdown: string): void;
  /** Tear down the editor and release its ProseMirror view. */
  destroy(): Promise<void>;
  /** Underlying Crepe instance (for manual experiments only). */
  readonly crepe: Crepe;
}

/**
 * Build a Crepe instance with the feature set we plan to ship in Phase 1b.
 *
 * Disabled features:
 *  - `ImageBlock` — pulls Vue into the bundle; we'll re-evaluate later.
 *  - `AI` and `TopBar` — Crepe-native chrome that conflicts with our own UI.
 */
export async function createValidateEditor(
  root: HTMLElement,
  initialMarkdown: string,
): Promise<ValidateEditorHandle> {
  const crepe = new Crepe({
    root,
    defaultValue: initialMarkdown,
    features: {
      [Crepe.Feature.ImageBlock]: false,
      [Crepe.Feature.AI]: false,
      [Crepe.Feature.TopBar]: false,
    },
  });
  await crepe.create();
  return {
    crepe,
    getMarkdown: () => crepe.getMarkdown(),
    setMarkdown: (markdown: string) => {
      crepe.editor.action(replaceAll(markdown));
    },
    destroy: async () => {
      await crepe.destroy();
    },
  };
}
