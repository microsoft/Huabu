/**
 * Shared style application for Shadow DOM instances.
 *
 * Two strategies are combined:
 *
 *  1. Constructable Stylesheets (`adoptedStyleSheets`) — every same-origin
 *     stylesheet from the document is converted once into a single shared
 *     `CSSStyleSheet` object and then attached synchronously to each shadow
 *     root. No network round-trip, no async parsing, no FOUC.
 *
 *  2. `<link>` clone fallback — for stylesheets we cannot read (cross-origin
 *     `cssRules` access throws `SecurityError`) we fall back to cloning the
 *     original `<link>` element into the shadow root. This preserves
 *     correctness at the cost of the original async behaviour for those
 *     specific sheets only.
 *
 * The cache is invalidated when document stylesheets change (e.g. after
 * Vite HMR replaces a `<style>` / `<link>` element).
 */

interface StyleCache {
  sheets: CSSStyleSheet[];
  fallbackLinks: HTMLLinkElement[];
}

let cache: StyleCache | null = null;
let lastSnapshotKey = '';

/**
 * Build a lightweight fingerprint of the current document stylesheets so
 * we can detect when the cache is stale (e.g. after HMR).
 */
function buildSnapshotKey(): string {
  const links = Array.from(
    document.querySelectorAll('link[rel="stylesheet"]'),
  ).map((l) => (l as HTMLLinkElement).href);
  const inlineCount = document.querySelectorAll('style').length;
  return `${links.join(',')}|${inlineCount}`;
}

/**
 * Try to extract the full CSS text from a `CSSStyleSheet`. Returns `null`
 * if the sheet is cross-origin and `cssRules` is inaccessible.
 */
function readSheetText(sheet: CSSStyleSheet): string | null {
  try {
    const rules = sheet.cssRules;
    let text = '';
    for (let i = 0; i < rules.length; i++) {
      text += rules[i].cssText + '\n';
    }
    return text;
  } catch {
    return null;
  }
}

function rebuildCache(): StyleCache {
  const sheets: CSSStyleSheet[] = [];
  const fallbackLinks: HTMLLinkElement[] = [];

  for (const sheet of Array.from(document.styleSheets)) {
    const text = readSheetText(sheet as CSSStyleSheet);
    if (text !== null) {
      try {
        const constructed = new CSSStyleSheet();
        // `replaceSync` rejects `@import`; strip them defensively. Imported
        // sheets appear separately in `document.styleSheets` anyway, so
        // they will be picked up on their own iteration.
        const sanitized = text.replace(/@import[^;]+;/g, '');
        constructed.replaceSync(sanitized);
        sheets.push(constructed);
        continue;
      } catch {
        // Fall through to link-clone fallback if construction fails.
      }
    }

    // Cross-origin or unparseable — fall back to cloning the original link.
    const owner = sheet.ownerNode;
    if (owner instanceof HTMLLinkElement) {
      fallbackLinks.push(owner.cloneNode(true) as HTMLLinkElement);
    }
  }

  return { sheets, fallbackLinks };
}

function getCache(): StyleCache {
  const key = buildSnapshotKey();
  if (cache && key === lastSnapshotKey) return cache;
  cache = rebuildCache();
  lastSnapshotKey = key;
  return cache;
}

/**
 * Apply the shared document styles to a Shadow DOM root.
 *
 * Same-origin stylesheets are attached via `adoptedStyleSheets` (synchronous,
 * shared across all shadow roots). Any cross-origin sheets we cannot read
 * are appended as cloned `<link>` elements, preserving the original async
 * loading behaviour for those specific sheets only.
 */
export function applySharedStyles(shadowRoot: ShadowRoot): void {
  const { sheets, fallbackLinks } = getCache();

  // `adoptedStyleSheets` is settable on `ShadowRoot` in all engines that
  // support Constructable Stylesheets (Chromium 73+, Safari 16.4+,
  // Firefox 101+). The check guards older runtimes.
  if ('adoptedStyleSheets' in shadowRoot) {
    shadowRoot.adoptedStyleSheets = sheets;
  }

  for (const link of fallbackLinks) {
    shadowRoot.appendChild(link.cloneNode(true));
  }
}
