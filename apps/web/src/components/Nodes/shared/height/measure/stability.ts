// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Bounded stability protocol for asynchronous height measurement.
 *
 * An asynchronous measurement that never declares itself finished is
 * worse than a wrong one, because the queue that depends on it cannot
 * drain. Every measurer resolves under these rules:
 *
 *  1. Wait for fonts. A metric-incompatible fallback font is the single
 *     largest source of measurement error, and it resolves late.
 *  2. Accept a value only once two consecutive samples agree. ProseMirror
 *     reflows asynchronously, so the first frame after a document swap is
 *     routinely wrong.
 *  3. Resolve *provisionally* rather than waiting forever. A provisional
 *     height still beats the policy minimum by a wide margin, and it is
 *     treated as stale on the next load so it is never trusted
 *     indefinitely.
 *  4. Hard deadline. Whatever happens, the queue drains.
 */

/** Largest difference (px) between two samples still counted as settled. */
const SETTLE_TOLERANCE_PX = 1;

/** Give up and resolve with the best sample seen so far. */
const DEADLINE_MS = 2000;

export interface StableHeight {
  height: number;
  /**
   * The measurement settled before its inputs did — undecoded images, or
   * the deadline expiring. Real enough to use, never proof.
   */
  provisional: boolean;
}

export interface StabilityOptions {
  /** Sample the current height. Called once per animation frame. */
  sample: () => number;
  /**
   * Report whether every image in the measured subtree has decoded.
   * A note whose image has not decoded cannot reach its final height.
   */
  imagesSettled: () => boolean;
  deadlineMs?: number;
}

/**
 * Resolve once the measured height has stopped moving, or provisionally
 * once the deadline expires. Never rejects, never hangs.
 */
export async function awaitStableHeight(
  options: StabilityOptions,
): Promise<StableHeight> {
  const { sample, imagesSettled, deadlineMs = DEADLINE_MS } = options;

  await documentFontsReady();

  const expiresAt = Date.now() + deadlineMs;
  let previous = sample();

  for (;;) {
    await nextFrame();
    const current = sample();
    const settled = Math.abs(current - previous) <= SETTLE_TOLERANCE_PX;
    previous = current;

    if (settled && imagesSettled()) {
      return { height: current, provisional: false };
    }
    if (Date.now() >= expiresAt) {
      // Height settled but an image is still decoding, or nothing
      // settled at all. Either way the number is usable and the caller
      // will re-measure on the next load.
      return { height: current, provisional: true };
    }
  }
}

/** True once every `<img>` under `root` has finished decoding. */
export function imagesDecoded(root: HTMLElement): boolean {
  const images = root.querySelectorAll('img');
  for (const image of images) {
    if (!image.complete) return false;
  }
  return true;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function documentFontsReady(): Promise<void> {
  // `document.fonts` is absent in non-browser test environments.
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts) return;
  try {
    await fonts.ready;
  } catch {
    // A font failing to load is not a measurement failure; the fallback
    // metrics are what the user will see anyway.
  }
}
