// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Rewrites of stored Space state that a schema version applies once.
 *
 * A port, in the other direction: something storage is given. A SQL backend
 * knows how to read and replace every Space's state inside an upgrade
 * transaction. It does not know what a Space's state means: the rule
 * that computes the new state belongs to the module that owns the meaning
 * (`canvas/order-keys-upgrade-rule.ts`), which provides it here by name. So the backends, and the
 * code that only reads a database without upgrading it, do not depend on
 * the canvas engine.
 *
 * An upgrade that needs a rewrite nobody provided fails; it never skips the
 * step and records the version as reached.
 */

/** The new state of a Space, or `null` when it is to be left as it is. */
export type SpaceStateRewrite = (state: unknown) => unknown | null;

/** Version 5: the order keys of Spaces stored before nodes carried them. */
export const SPACE_ORDER_KEYS_REWRITE = 'space-order-keys';

const rewrites = new Map<string, SpaceStateRewrite>();

export function provideSpaceStateRewrite(
  name: string,
  rewrite: SpaceStateRewrite,
): void {
  rewrites.set(name, rewrite);
}

export function spaceStateRewrite(name: string): SpaceStateRewrite {
  const rewrite = rewrites.get(name);
  if (!rewrite)
    throw new Error(
      `The database upgrade needs the Space state rewrite "${name}", which was not provided`,
    );
  return rewrite;
}
