// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The measurement font must be the font the DOM renders.
 *
 * The node's CSS keeps the authored family stack, so a measurement that
 * silently drops a family the engine honours (`ui-sans-serif` on Safari)
 * sizes the node from a different typeface than the one on screen. That
 * error is a fraction of a percent wide, but it is enough to flip a line
 * that fits into a line that wraps, and the node then reserves a line of
 * height that renders empty.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STACK = 'ui-sans-serif, system-ui, sans-serif';

/** Fresh module state — the probe result is memoised per engine. */
async function loadBuildFontStr() {
  vi.resetModules();
  const mod = await import('../textMeasure');
  return mod.buildFontStr;
}

/**
 * A context whose `font` setter rejects `ui-*` generics the way an engine
 * without CSS Fonts L4 support does: silently, keeping the previous value.
 */
function makeRejectingContext() {
  let font = '10px sans-serif';
  return {
    get font() {
      return font;
    },
    set font(next: string) {
      if (!/\bui-(sans-serif|serif|monospace|rounded)\b/i.test(next)) {
        font = next;
      }
    },
    measureText: (text: string) => ({ width: text.length * 6 }),
  };
}

describe('buildFontStr', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the authored stack when the engine accepts it', async () => {
    const buildFontStr = await loadBuildFontStr();

    expect(buildFontStr(16, STACK, 'normal', 'normal')).toBe(`16px ${STACK}`);
  });

  it('carries weight and style through', async () => {
    const buildFontStr = await loadBuildFontStr();

    expect(buildFontStr(16, STACK, 'bold', 'italic')).toBe(
      `italic bold 16px ${STACK}`,
    );
  });

  describe('on an engine that rejects ui-* generics', () => {
    beforeEach(() => {
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
        makeRejectingContext() as unknown as CanvasRenderingContext2D,
      );
    });

    it('falls back to the family CSS itself would land on', async () => {
      const buildFontStr = await loadBuildFontStr();

      // An engine that cannot parse `ui-sans-serif` in `ctx.font` cannot
      // parse it in a stylesheet either, so the DOM skips it too and both
      // sides resolve `system-ui`.
      expect(buildFontStr(16, STACK, 'normal', 'normal')).toBe(
        '16px system-ui, sans-serif',
      );
    });

    it('never leaves the stack empty', async () => {
      const buildFontStr = await loadBuildFontStr();

      expect(buildFontStr(16, 'ui-rounded', 'normal', 'normal')).toBe(
        '16px sans-serif',
      );
    });
  });
});
