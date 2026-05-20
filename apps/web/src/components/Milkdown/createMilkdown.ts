/**
 * Internal Milkdown factory. NOT exported from the package barrel — only
 * `MilkdownEditor` and `MilkdownPreview` consume it.
 *
 * Why a thin handle and not the raw Crepe:
 *  - Keeps the surface area we depend on minimal (just five verbs).
 *  - Lets us swap Crepe for raw `@milkdown/kit` later without touching
 *    component code.
 *  - Hides the async lifecycle: callers always receive a ready instance.
 */

import { Crepe } from '@milkdown/crepe';
import { replaceAll } from '@milkdown/utils';

import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/classic.css';
import 'katex/dist/katex.min.css';

export interface MilkdownFactoryOptions {
  /** Element the editor view will be mounted into. */
  root: HTMLElement;
  /** Initial markdown payload. */
  initialMarkdown: string;
  /** Default `true`. */
  editable?: boolean;
  /** Optional placeholder text shown when the doc is empty. */
  placeholder?: string;
}

export interface MilkdownInstance {
  /** Read the current document as markdown. */
  getMarkdown(): string;
  /**
   * Replace the entire document. Uses Milkdown's `replaceAll` macro so
   * undo history is preserved.
   */
  setMarkdown(markdown: string): void;
  /** Toggle the editor between editable and read-only. */
  setReadonly(readonly: boolean): void;
  /**
   * Subscribe to markdown changes. Returns an unsubscribe function.
   * Listeners receive the raw editor output — components are expected to
   * apply `normalizeMarkdown` before propagating.
   */
  onMarkdownUpdated(listener: (markdown: string) => void): () => void;
  /** Tear down the ProseMirror view and release resources. */
  destroy(): Promise<void>;
}

/**
 * Build and start a Crepe-backed editor.
 *
 * The feature set is hand-picked to match what we ship in Sediment:
 *  - `ImageBlock` is disabled because it pulls Vue into the bundle.
 *  - `AI` and `TopBar` are disabled because we render our own chrome.
 *
 * Everything else (block-edit drag handle, list-item, table, latex,
 * placeholder, toolbar, link-tooltip, cursor) is on.
 */
export async function createMilkdown(
  options: MilkdownFactoryOptions,
): Promise<MilkdownInstance> {
  const { root, initialMarkdown, editable = true, placeholder } = options;

  const crepe = new Crepe({
    root,
    defaultValue: initialMarkdown,
    features: {
      [Crepe.Feature.ImageBlock]: false,
      [Crepe.Feature.AI]: false,
      [Crepe.Feature.TopBar]: false,
    },
    featureConfigs: placeholder
      ? {
          [Crepe.Feature.Placeholder]: { text: placeholder },
        }
      : undefined,
  });

  // Register the markdown listener BEFORE `create()`. Crepe's `on()` runs
  // the callback during editor construction, so subscribers must be queued
  // up front.
  const listeners = new Set<(markdown: string) => void>();
  crepe.on((api) => {
    api.markdownUpdated((_ctx, markdown) => {
      for (const listener of listeners) listener(markdown);
    });
  });

  await crepe.create();
  crepe.setReadonly(!editable);

  return {
    getMarkdown: () => crepe.getMarkdown(),
    setMarkdown: (markdown: string) => {
      crepe.editor.action(replaceAll(markdown));
    },
    setReadonly: (readonly: boolean) => {
      crepe.setReadonly(readonly);
    },
    onMarkdownUpdated: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    destroy: async () => {
      listeners.clear();
      await crepe.destroy();
    },
  };
}
