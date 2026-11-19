// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { PropertySymbol } from 'happy-dom';
import { vi } from 'vitest';

/**
 * Records every value assigned to one inline style property.
 *
 * Happy DOM drops values it cannot parse (`color-mix()`, shorthands holding
 * CSS variables), so reading `element.style` back cannot prove what a
 * component assigned. Happy DOM exposes named style properties through a
 * Proxy that forwards to `setProperty`, which is the one place to observe
 * the assignment.
 *
 * Each call receives the assigned value; its mock context is the element
 * that owns the style declaration.
 *
 * @param property CSS property name in kebab-case, e.g. `border-color`.
 */
export function spyOnAssignedStyle(property: string) {
  const assigned = vi.fn<(this: Element | null, value: string) => void>();
  const setProperty = CSSStyleDeclaration.prototype.setProperty;
  const spy = vi
    .spyOn(CSSStyleDeclaration.prototype, 'setProperty')
    .mockImplementation(function (
      this: CSSStyleDeclaration,
      name,
      value,
      priority,
    ) {
      if (name === property) {
        const element = (
          this as unknown as { [PropertySymbol.element]: Element | null }
        )[PropertySymbol.element];
        assigned.call(element, String(value));
      }
      return setProperty.call(this, name, value, priority);
    });
  return Object.assign(assigned, { restore: () => spy.mockRestore() });
}
