// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared block-drag wiring for the Milkdown surfaces.
 *
 * Extracted from `MilkdownPreview` so that `MilkdownEditor` can reuse
 * the exact same multi-block snapshot + drag-image construction logic.
 * Keeping a single owner for the dragstart pipeline guarantees that
 * single-block drags out of the editor look identical to single-block
 * drags out of a preview card, and that multi-block drags work the
 * same way on both surfaces.
 *
 * The helper does NOT decide whether the drag callback fires — that's
 * controlled by the caller via `onDragStartRef`. Callers wire it up
 * inside the same effect that mounts Crepe, after the mount root has
 * been resolved.
 */

import type { MilkdownDragRange, MilkdownInstance } from './createMilkdown';
import type { MilkdownBlockDragEvent } from './types';

/**
 * Build a drag preview that visually matches the live editor — used
 * for BOTH single-block and multi-block drags so the two paths look
 * identical (a single-block preview is just an N=1 case of the same
 * builder).
 *
 * Three correctness requirements drive the design:
 *
 *  1. **`setDragImage` must actually render it.** Some browsers have
 *     historically had quirks rasterizing elements that live inside
 *     unusual roots (e.g. Shadow DOM in older Chromium). Mounting the
 *     preview directly in `document.body` (light DOM) sidesteps that
 *     class of issue and keeps behavior identical across engines.
 *
 *  2. **Editor styling must apply.** Crepe's theme, our
 *     `milkdown-overrides.css`, and the KaTeX stylesheet are all
 *     imported by `createMilkdown.ts` and end up in `document.head`
 *     via Vite, so any element in `document.body` can pick them up —
 *     PROVIDED the selectors' ancestor chain is satisfied. The
 *     overrides are scoped under `.milkdown .ProseMirror …`, so we
 *     wrap the cloned blocks with that exact ancestor chain. Crepe's
 *     own list / heading / code rules are scoped the same way, so the
 *     single wrapper covers both.
 *
 *  3. **Parent context for list items.** A bare `<li>` cloned outside
 *     its `<ul>` / `<ol>` parent loses its list marker positioning
 *     (browsers anchor `::marker` against the list wrapper, and Crepe
 *     adds list-specific padding on the wrapper too). We therefore
 *     group consecutive `blockElements` that share an immediate
 *     `<ul>` / `<ol>` parent and shallow-clone that wrapper so the
 *     selected items render inside a real list. This also makes the
 *     single-list-item case render with its bullet, just like in the
 *     editor.
 *
 * The preview is positioned far off-screen (`top:-10000px`) so it does
 * not affect layout while still being rasterized — a `display:none`
 * element produces no visual snapshot for `setDragImage`, but an
 * off-screen positioned element does.
 *
 * The "lifted card" chrome (translucent surface, border, soft shadow)
 * is applied via the `.milkdown-drag-preview-host` rule in
 * `milkdown-overrides.css` — keep visual styling there, keep
 * positioning / structural styling here.
 *
 * Caller is responsible for removing the returned element after the
 * browser has snapshotted it.
 */
function buildBlockDragImage(
  blockElements: HTMLElement[],
  mountRoot: HTMLElement,
): HTMLElement {
  // Outer host: positions off-screen and matches the editor's content
  // width so line wrapping in the preview matches what the user saw.
  const host = document.createElement('div');
  host.className = 'milkdown-drag-preview-host';
  host.style.position = 'absolute';
  host.style.top = '-10000px';
  host.style.left = '-10000px';
  host.style.pointerEvents = 'none';
  host.style.zIndex = '2147483647';

  const editorContentRoot = mountRoot.querySelector('.milkdown');
  const referenceWidth =
    editorContentRoot?.getBoundingClientRect().width ??
    blockElements[0]?.getBoundingClientRect().width;
  if (referenceWidth) host.style.width = `${referenceWidth}px`;

  // Reproduce the editor's ancestor chain so `.milkdown .ProseMirror …`
  // selectors from Crepe and our overrides match the cloned content.
  const milkdownLayer = document.createElement('div');
  milkdownLayer.className = 'milkdown';

  const proseLayer = document.createElement('div');
  proseLayer.className = 'ProseMirror';
  // Natural block flow — Crepe / overrides already supply the paragraph
  // and list margins via `.milkdown .ProseMirror …` selectors that our
  // wrapper now satisfies, so we don't need flex / gap here.

  milkdownLayer.appendChild(proseLayer);
  host.appendChild(milkdownLayer);

  const stripIds = (el: HTMLElement) => {
    el.removeAttribute('id');
    el.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
  };

  // Walk the array, grouping consecutive blocks that share an
  // immediate parent. A "list group" gets a shallow-cloned list
  // wrapper; everything else is appended directly.
  let i = 0;
  while (i < blockElements.length) {
    const start = blockElements[i];
    const parent = start.parentElement;
    let end = i + 1;
    while (
      end < blockElements.length &&
      blockElements[end].parentElement === parent
    ) {
      end++;
    }
    const groupItems = blockElements.slice(i, end);

    const parentTag = parent?.tagName;
    if (parent && (parentTag === 'UL' || parentTag === 'OL')) {
      const wrapper = parent.cloneNode(false) as HTMLElement;
      stripIds(wrapper);
      for (const item of groupItems) {
        const clone = item.cloneNode(true) as HTMLElement;
        stripIds(clone);
        wrapper.appendChild(clone);
      }
      proseLayer.appendChild(wrapper);
    } else {
      for (const item of groupItems) {
        const clone = item.cloneNode(true) as HTMLElement;
        stripIds(clone);
        proseLayer.appendChild(clone);
      }
    }

    i = end;
  }

  document.body.appendChild(host);
  return host;
}

export interface AttachBlockDragOptions {
  /** DOM root where Crepe is mounted (the `.milkdown` ancestor). */
  mountRoot: HTMLElement;
  /** Ref pointing at the live Milkdown instance (may be null pre-mount). */
  instanceRef: { current: MilkdownInstance | null };
  /** Ref pointing at the latest user-supplied drag callback. */
  onDragStartRef: {
    current: ((event: MilkdownBlockDragEvent) => void) | undefined;
  };
}

/**
 * Install the capture-phase mousedown + bubble-phase dragstart + dragend
 * handlers required to support dragging Crepe blocks out of the editor
 * onto an arbitrary HTML5 drop target (in our case: the canvas surface).
 * Both block-handle drags and native drags started directly on an image
 * are normalized to the same block payload.
 *
 * The capture-phase mousedown fires BEFORE Crepe's BlockService
 * bubble-phase handler. When the user already has a multi-block text
 * selection and now mousedowns on the block handle, Crepe would
 * normally dispatch a single-block `NodeSelection`, clobbering the
 * multi-block range; its `dragstart` then serializes only that single
 * block. We defuse that in two steps:
 *   1. Snapshot the multi-block range so `dragstart` can serialize it
 *      explicitly (the source of truth even if PM's state was later
 *      mutated by someone else).
 *   2. `event.stopPropagation()` to PREVENT Crepe's mousedown from
 *      running at all. That leaves view.state.selection as the
 *      original multi-block TextSelection and Crepe's `#activeSelection`
 *      as null, so its `dragstart` writes no data — our bubble-phase
 *      handler owns the entire payload.
 *
 * For single-block drags (no multi-block range present) we DON'T stop
 * propagation: Crepe's mousedown is required to dispatch the
 * NodeSelection that `getDragPayload(null)` falls back to.
 *
 * Native HTML5 drag is started by the browser based on the handle's
 * `draggable="true"` attribute and does not depend on Crepe's
 * mousedown handler running, so the user-visible drag begins normally
 * either way.
 *
 * The bubble-phase dragstart fires AFTER Crepe's BlockService handler
 * (registered on the inner `.milkdown-block-handle` wrapper). Crepe
 * has already populated `dataTransfer` with `text/html` / `text/plain`
 * and set the drag image; we layer the Huabu markdown payload
 * through the user-supplied callback and substitute a unified drag
 * image that mirrors the editor's exact styling for BOTH single- and
 * multi-block drags. The HTML5 spec says the last `setDragImage` call
 * during dragstart wins, so our call overrides Crepe's earlier one.
 *
 * Returns the cleanup function the caller's effect should run on
 * teardown.
 */
export function attachBlockDragListeners(
  options: AttachBlockDragOptions,
): () => void {
  const { mountRoot, instanceRef, onDragStartRef } = options;

  // Snapshot of the multi-block text selection captured at mousedown,
  // BEFORE Crepe's bubble-phase handler replaces it with a single-block
  // NodeSelection. Read by `dragstart` to decide whether to issue a
  // multi-block payload.
  let priorSelection: MilkdownDragRange | null = null;

  // True while `view.dragging` holds a slice THIS module registered.
  // Ownership is tracked so `dragend` tears down only our own state and
  // leaves Crepe's / ProseMirror's drag lifecycle untouched.
  let ownsDraggingSlice = false;

  const mousedownCaptureHandler = (event: Event) => {
    const target = event.target as HTMLElement | null;
    if (!target?.closest('.milkdown-block-handle')) {
      priorSelection = null;
      return;
    }
    // Suppress the browser's native Shift+click "extend text
    // selection" behaviour when the click lands on the block handle.
    // Without this, holding Shift while mousedown-ing the handle would
    // either cancel the pending drag (Chrome) or extend the editor
    // selection through the handle's position (Firefox) instead of
    // starting a drag. Crepe's own mousedown listener still runs and
    // installs the NodeSelection via `view.dispatch`, and the browser
    // still initiates the drag from the handle's `draggable=true`
    // attribute.
    const mouseEvent = event as MouseEvent;
    if (mouseEvent.shiftKey) event.preventDefault();
    const instance = instanceRef.current;
    const range = instance?.getMultiBlockSelectionRange() ?? null;
    priorSelection = range;
    if (range) {
      // ProseMirror's native drop reads the live selection to build the
      // moved slice. Keep it aligned with the full-block range used by our
      // Markdown payload; otherwise a partial text selection moves only
      // fragments even though the drag preview shows complete blocks.
      instance?.setDragSelection(range);
      event.stopPropagation();
    }
  };

  const dragHandler = (event: DragEvent) => {
    const callback = onDragStartRef.current;
    const instance = instanceRef.current;
    if (!callback || !instance) return;

    const target = event.target as HTMLElement | null;
    const handle = target?.closest('.milkdown-block-handle');
    const image = target?.closest('.ProseMirror img');
    if (!handle && !image) return;

    const snapshot = handle
      ? (priorSelection ?? instance.getMultiBlockSelectionRange())
      : instance.getDragRangeAtDOM(image as HTMLElement);
    // Only a handle drag over an existing multi-block selection took the
    // `stopPropagation` branch in `mousedown`, so only that path is left
    // without a `view.dragging` entry.
    const isMultiBlockHandleDrag = Boolean(handle && snapshot);
    // Clear immediately so a subsequent single-block drag isn't
    // accidentally treated as multi-block.
    priorSelection = null;
    if (!handle && !snapshot) return;

    const payload = instance.getDragPayload(snapshot);
    if (!payload) return;

    const { markdown: dragMarkdown, blockElements, range } = payload;
    const sourceContentAfterMove = instance.getDocAfterRangeRemoved(range);

    // Crepe's block handle lives outside `view.dom`, so ProseMirror's own
    // dragstart handler never sees this event — Crepe's BlockService fills
    // `view.dragging` instead. For a multi-block selection we suppressed
    // that mousedown, leaving `activeSelection` empty and nobody to
    // register the slice, so a self-drop would reparse the transfer as a
    // copy. Supply the full-block slice ourselves to restore the atomic
    // delete-and-insert.
    //
    // Deliberately narrow: a single-block handle drag is already covered
    // by Crepe, and an image drag starts INSIDE `view.dom`, where
    // ProseMirror records a `NodeSelection`-backed `Dragging` whose
    // `node` drives an exact `node.replace(tr)` on drop. Overwriting that
    // with a plain slice would downgrade the move to `deleteSelection()`
    // against an unrelated caret, duplicating the image.
    //
    // `move: true` only mirrors Crepe's shape; ProseMirror's drop decides
    // move-vs-copy from the modifier key, never from this flag.
    if (isMultiBlockHandleDrag) {
      instance.setDraggingSlice(range);
      ownsDraggingSlice = true;
    }

    if (blockElements.length > 0 && event.dataTransfer) {
      // 'all' (vs 'copyMove') so that macOS Cmd-modified drags — which
      // the OS reports as NSDragOperationGeneric / Link — still pass
      // the browser's effectAllowed/dropEffect intersection check.
      // The actual move-vs-copy decision is made by the drop target
      // based on a platform-aware modifier key (Option on macOS, Ctrl
      // elsewhere); see `handleNoteDrop` / Canvas `onDrop`.
      event.dataTransfer.effectAllowed = 'all';
      const preview = buildBlockDragImage(blockElements, mountRoot);
      // Anchor the preview's top-left near the cursor; the block
      // handle sits just to the LEFT of a block, so (0, 0) reads as
      // "the content the user was about to drag is hugging their
      // cursor".
      event.dataTransfer.setDragImage(preview, 0, 0);
      // Keep the preview around long enough for the browser to
      // snapshot it, then tear it down on the next tick.
      window.setTimeout(() => preview.remove(), 0);
    }

    callback({
      markdown: dragMarkdown,
      sourceContentAfterMove,
      nativeEvent: event,
    });
  };

  // Defensive: clear the snapshot when the drag ends (or is cancelled),
  // so a stale range can't poison a future drag. A slice we registered
  // ourselves is torn down here too — ProseMirror's own `dragend` cleanup
  // is bound to `view.dom`, which a handle-originated drag never reaches,
  // so without this a stale `view.dragging` would hijack the next drop
  // into this editor.
  const dragEndHandler = () => {
    priorSelection = null;
    if (!ownsDraggingSlice) return;
    ownsDraggingSlice = false;
    instanceRef.current?.clearDraggingSlice();
  };

  mountRoot.addEventListener('mousedown', mousedownCaptureHandler, {
    capture: true,
  });
  mountRoot.addEventListener('dragstart', dragHandler);
  mountRoot.addEventListener('dragend', dragEndHandler);

  return () => {
    mountRoot.removeEventListener('mousedown', mousedownCaptureHandler, {
      capture: true,
    });
    mountRoot.removeEventListener('dragstart', dragHandler);
    mountRoot.removeEventListener('dragend', dragEndHandler);
  };
}
