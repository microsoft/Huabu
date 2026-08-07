// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Offscreen height measurer — one hidden Milkdown instance reused as a
 * measuring tape.
 *
 * `onlyRenderVisibleElements` unmounts offscreen nodes, so a note the
 * user has not looked at can never measure itself. This is the only way
 * to give such a note a real footprint before it is reached, which is
 * what makes the correction invisible rather than merely bounded.
 *
 * ## Why a singleton
 *
 * Almost all of Milkdown's cost is in *building* an instance, not in
 * replacing its document. Amortizing one build across every queued note
 * is what makes offscreen measurement affordable at all. It also
 * guarantees a single CSS context, so no two notes can drift apart
 * because of where they happened to be measured.
 *
 * ## Host constraints, each of which is a failure mode if violated
 *
 * - `visibility: hidden`, never `display: none` — a display-none subtree
 *   has no layout and measures zero.
 * - Fixed at the node type's reference width, because an intrinsic height
 *   is only meaningful paired with the width it was measured at.
 * - Built from the same box classes as the mounted note
 *   (`NOTE_CONTENT_HOST_CLASS`), so the two cannot silently diverge.
 */

import { getHeightRefWidth } from '@huabu/shared/canvas-engine';

import { resolveArtifactUrl } from '@/api/artifact';
import {
  NOTE_CONTENT_HOST_CLASS,
  readNoteIntrinsicHeight,
} from '@/components/Nodes/note/noteContentHost';

import { awaitStableHeight, imagesDecoded } from './stability';

import type { StableHeight } from './stability';
import type { MilkdownInstance } from '@/components/Milkdown/createMilkdown';

export interface OffscreenMeasureRequest {
  markdown: string;
  /** Resolves artifact-key image `src`s. Absent outside a canvas. */
  canvasId?: string;
}

interface Host {
  container: HTMLDivElement;
  content: HTMLDivElement;
  instance: MilkdownInstance;
}

let hostPromise: Promise<Host> | null = null;
/** Serializes measurements: one document lives in the instance at a time. */
let tail: Promise<unknown> = Promise.resolve();
/** Latest canvas id, read by the instance's image resolver. */
let activeCanvasId: string | undefined;

/**
 * Measure the intrinsic content height of a markdown document as the
 * note body would render it.
 *
 * Requests are serialized, so a caller waiting on this is also waiting
 * on everything queued ahead of it. That is intended: the queue behind
 * it is idle-scheduled, and a single instance cannot hold two documents.
 */
export function measureNoteHeightOffscreen(
  request: OffscreenMeasureRequest,
): Promise<StableHeight> {
  const run = tail.then(() => measureNow(request));
  // Keep the chain alive even if one measurement throws.
  tail = run.catch(() => undefined);
  return run;
}

async function measureNow(
  request: OffscreenMeasureRequest,
): Promise<StableHeight> {
  const host = await ensureHost();
  activeCanvasId = request.canvasId;
  host.instance.setMarkdown(request.markdown);
  return awaitStableHeight({
    sample: () => readNoteIntrinsicHeight(host.content),
    imagesSettled: () => imagesDecoded(host.content),
  });
}

async function ensureHost(): Promise<Host> {
  hostPromise ??= buildHost().catch((error: unknown) => {
    // A rejected singleton would otherwise poison every later measurement
    // in this app session. Clear it so the prewarm queue's retry can build a
    // fresh editor after a transient chunk-load or Milkdown mount failure.
    hostPromise = null;
    throw error;
  });
  return hostPromise;
}

async function buildHost(): Promise<Host> {
  const container = document.createElement('div');
  // Off-screen but still laid out. `visibility: hidden` keeps the
  // subtree in the layout tree; `display: none` would measure zero.
  container.style.position = 'absolute';
  container.style.top = '0';
  container.style.left = '-100000px';
  container.style.visibility = 'hidden';
  container.style.pointerEvents = 'none';
  container.setAttribute('aria-hidden', 'true');
  container.dataset.huabuHeightMeasurer = 'true';

  const content = document.createElement('div');
  content.className = NOTE_CONTENT_HOST_CLASS;
  // The note's content renders unscaled at its type's reference width;
  // the scale factor is applied to the *result*, not to the measurement.
  content.style.width = `${getHeightRefWidth('note') ?? 400}px`;

  container.appendChild(content);
  document.body.appendChild(container);

  // Imported here rather than at module scope: `canvasStore` reaches this
  // file, and the app shell reaches `canvasStore`, so a static edge would
  // pull the whole editor toolchain (Milkdown + ProseMirror + CodeMirror +
  // KaTeX, ~2.7 MB) into the entry chunk and in front of the first paint.
  // `buildHost` is already async and only runs once a measurement is
  // actually requested, which is inside a canvas — where the editor chunk
  // is loaded anyway.
  const { createMilkdown } =
    await import('@/components/Milkdown/createMilkdown');
  const instance = await createMilkdown({
    root: content,
    initialMarkdown: '',
    editable: false,
    previewMode: false,
    toolbarMode: 'none',
    resolveImageSrc: (src) =>
      activeCanvasId ? resolveArtifactUrl(src, activeCanvasId) : src,
  });

  return { container, content, instance };
}

/** Tear the measurer down. Called on canvas unmount and by tests. */
export async function destroyOffscreenMeasurer(): Promise<void> {
  const pending = hostPromise;
  hostPromise = null;
  tail = Promise.resolve();
  activeCanvasId = undefined;
  if (!pending) return;
  const host = await pending.catch(() => null);
  if (!host) return;
  await host.instance.destroy();
  host.container.remove();
}
