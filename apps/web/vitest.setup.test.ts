// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { setTimeout as delay } from 'node:timers/promises';

import { expect, it, vi } from 'vitest';

it('cancels browser callbacks when the test DOM is torn down', async () => {
  const callback = vi.fn();
  const timeout = setTimeout(callback, 20);
  const interval = setInterval(callback, 20);
  try {
    await (
      window as unknown as { happyDOM: { abort(): Promise<void> } }
    ).happyDOM.abort();
    // This wait belongs to Node so closing the browser cannot cancel it.
    await delay(50);
    expect(callback).not.toHaveBeenCalled();
  } finally {
    clearTimeout(timeout);
    clearInterval(interval);
  }
});
