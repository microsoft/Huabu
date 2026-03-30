/**
 * Shared style cache for Shadow DOM instances.
 *
 * Instead of each NoteNode cloning every <link> and <style> element from
 * the document head into its own shadow root, we maintain a single cached
 * list of cloned nodes and stamp them into each shadow root.
 *
 * The cache is invalidated when document stylesheets change (e.g. after
 * hot-module replacement in development).
 */

let cachedNodes: Node[] | null = null;
let lastSnapshotKey = '';

/**
 * Build a lightweight fingerprint of the current document stylesheets
 * so we can detect when the cache is stale.
 */
function buildSnapshotKey(): string {
  const links = Array.from(
    document.querySelectorAll('link[rel="stylesheet"]'),
  ).map((l) => (l as HTMLLinkElement).href);
  const inlineCount = document.querySelectorAll('style').length;
  return `${links.join(',')}|${inlineCount}`;
}

/**
 * Returns an array of cloned stylesheet nodes (both <link> and <style>)
 * ready to be appended into a Shadow DOM.  The clones are cached and
 * shared across all callers; the cache auto-refreshes when the document
 * stylesheets change.
 */
export function getSharedStyleNodes(): Node[] {
  const key = buildSnapshotKey();
  if (cachedNodes && key === lastSnapshotKey) {
    // Return fresh clones of the cached originals
    return cachedNodes.map((n) => n.cloneNode(true));
  }

  // Rebuild cache
  const nodes: Node[] = [];

  document
    .querySelectorAll('link[rel="stylesheet"]')
    .forEach((link) => nodes.push(link.cloneNode(true)));

  document
    .querySelectorAll('style')
    .forEach((style) => nodes.push(style.cloneNode(true)));

  cachedNodes = nodes;
  lastSnapshotKey = key;

  // Return clones so each shadow root gets its own copy
  return nodes.map((n) => n.cloneNode(true));
}
