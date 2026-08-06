// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { type CDPSession, type Page } from '@playwright/test';

/**
 * Shared helpers for canvas gesture end-to-end tests.
 *
 * Multi-touch is issued through CDP `Input.dispatchTouchEvent` because
 * Playwright's `page.touchscreen` only supports a single tap. These
 * helpers exist so gesture tests read as intent ("pinch out", "one-finger
 * drag") rather than raw touch-point math.
 */

export interface Point {
  x: number;
  y: number;
}

/**
 * Open a brand-new canvas from the home page and wait until the React
 * Flow pane is interactive. Avoids depending on any pre-existing canvas
 * id so the suite is portable across environments.
 */
export async function openNewCanvas(page: Page): Promise<void> {
  await page.goto('/');
  const createButton = page
    .getByRole('button', { name: /New Space|Create your first Space/i })
    .first();
  await createButton.waitFor({ state: 'visible' });
  await createButton.click();
  await page.waitForURL(/\/canvas\//);
  await page.waitForSelector('.react-flow__pane');
  await page.waitForSelector('.react-flow__viewport');
}

/** Current React Flow viewport transform string (`translate(...) scale(...)`). */
export async function readViewportTransform(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      (document.querySelector('.react-flow__viewport') as HTMLElement | null)
        ?.style.transform ?? '',
  );
}

/** Center of the React Flow pane in viewport (screen) coordinates. */
export async function paneCenter(page: Page): Promise<Point> {
  return page.evaluate(() => {
    const pane = document.querySelector('.react-flow__pane');
    if (!pane) throw new Error('react-flow pane not found');
    const r = pane.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
}

/** Drive a two-finger pinch centred on `center`, scaling the finger gap. */
export async function pinch(
  client: CDPSession,
  center: Point,
  fromGap: number,
  toGap: number,
  steps = 8,
): Promise<void> {
  const half = (gap: number) => gap / 2;
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: center.x - half(fromGap), y: center.y },
      { x: center.x + half(fromGap), y: center.y },
    ],
  });
  for (let i = 1; i <= steps; i++) {
    const gap = fromGap + ((toGap - fromGap) * i) / steps;
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: center.x - half(gap), y: center.y },
        { x: center.x + half(gap), y: center.y },
      ],
    });
  }
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
}

/** Drive a single-finger drag from `from` by `(dx, dy)` screen pixels. */
export async function oneFingerDrag(
  client: CDPSession,
  from: Point,
  dx: number,
  dy: number,
  steps = 8,
): Promise<void> {
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: from.x, y: from.y }],
  });
  for (let i = 1; i <= steps; i++) {
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: from.x + (dx * i) / steps, y: from.y + (dy * i) / steps },
      ],
    });
  }
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
}

/** Single-finger tap (touch down then up at the same point, no drag). */
export async function touchTap(client: CDPSession, at: Point): Promise<void> {
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: at.x, y: at.y }],
  });
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
}

/** Drive a single-finger drag through an ordered list of screen points. */
export async function oneFingerPath(
  client: CDPSession,
  points: Point[],
): Promise<void> {
  if (points.length === 0) return;
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: points[0].x, y: points[0].y }],
  });
  for (let i = 1; i < points.length; i++) {
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: points[i].x, y: points[i].y }],
    });
  }
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
}

/** Parse the `scale(n)` factor out of a viewport transform string. */
export function scaleOf(transform: string): number {
  const match = /scale\(([-0-9.]+)\)/.exec(transform);
  if (!match) throw new Error(`no scale in transform: ${transform}`);
  return Number(match[1]);
}

/** Parse the `translate(x, y)` offset out of a viewport transform string. */
export function translateOf(transform: string): Point {
  const match = /translate\(([-0-9.]+)px,\s*([-0-9.]+)px\)/.exec(transform);
  if (!match) throw new Error(`no translate in transform: ${transform}`);
  return { x: Number(match[1]), y: Number(match[2]) };
}
