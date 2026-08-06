// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Canvas-scoped artifact URL helpers.
 *
 * Pure runtime utilities — intentionally zod-free so the web bundle
 * can import them at runtime without dragging zod in. The matching
 * request schema (with zod) lives in `types/api/artifact.ts`.
 *
 * Canonical URL shape:
 *   `/api/canvas/<canvasId>/artifact/<key>`
 * where `<key>` is `<artifactId><ext>` (the on-disk filename).
 */

/**
 * Regex capturing `(canvasId, key)` from a canvas-scoped artifact URL.
 * Matches both relative paths and absolute URLs that embed the same path.
 */
export const ARTIFACT_URL_REGEX =
  /\/api\/canvas\/([^/?#]+)\/artifact\/([^/?#]+)/;

/** Build the canonical relative URL for a stored artifact. */
export function artifactApiPath(canvasId: string, filename: string): string {
  return `/api/canvas/${canvasId}/artifact/${filename}`;
}

/**
 * Parse a canvas-scoped artifact URL into its `(canvasId, key)` parts.
 * Returns `null` for unrelated URLs (data:, https://external, plain
 * paths). Accepts both relative paths and absolute URLs (the latter is
 * used by legacy data persisted with a hardcoded port).
 */
export function parseArtifactUrl(
  url: string,
): { canvasId: string; key: string } | null {
  if (!url || url.startsWith('data:')) return null;
  const match = ARTIFACT_URL_REGEX.exec(url);
  if (!match || !match[1] || !match[2]) return null;
  return { canvasId: match[1], key: match[2] };
}

/**
 * Node `data` field names that may carry a canvas-scoped artifact URL.
 * Single source of truth for paste-clone logic, legacy migration, and
 * any code path that needs to walk the artifact references attached to
 * a node. Kept narrow on purpose — adding a field here will broaden the
 * surface that the cross-canvas paste-clone treats as cloneable.
 */
export const ARTIFACT_DATA_FIELDS = ['src', 'coverUrl'] as const;

/**
 * Node `data` field names, keyed by node type, whose value is a Markdown
 * body that may embed artifact references inline (`![alt](<key>)`)
 * rather than carrying them in a dedicated top-level field. Counterpart
 * of `ARTIFACT_DATA_FIELDS` for the paste-clone walk.
 *
 * Keyed by node type on purpose: `content` also exists on `text` and
 * `question` nodes, whose bodies are plain prose rather than Markdown.
 * Rewriting an image destination there would silently edit what the
 * user typed. Read this through `markdownArtifactFields`.
 */
const ARTIFACT_MARKDOWN_FIELDS_BY_TYPE: Readonly<
  Record<string, readonly string[]>
> = {
  note: ['content'],
};

/**
 * The Markdown-bearing `data` fields to walk for artifact references on
 * a node, given its `data`. Empty for node types whose body is not
 * Markdown — see `ARTIFACT_MARKDOWN_FIELDS_BY_TYPE`.
 */
export function markdownArtifactFields(
  data: Record<string, unknown>,
): readonly string[] {
  const type = data['type'];
  if (typeof type !== 'string') return [];
  return ARTIFACT_MARKDOWN_FIELDS_BY_TYPE[type] ?? [];
}

/**
 * Classify an artifact reference as persisted by the front-end.
 *
 * Accepts both the canonical bare key (`<artifactId><ext>`, canvas
 * implied by the owning node) and the legacy canvas-scoped URL, and
 * rejects anything the server-side clone cannot handle (`data:`,
 * `blob:`, external `http(s)` URLs, arbitrary paths).
 *
 * `canvasId` is `null` for a bare key — the caller decides which canvas
 * owns it (for paste-clone that is the clipboard's source canvas).
 */
export function parseArtifactRef(
  value: unknown,
): { canvasId: string | null; key: string } | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.startsWith('data:') || value.startsWith('blob:')) return null;
  const parsed = parseArtifactUrl(value);
  if (parsed) return { canvasId: parsed.canvasId, key: parsed.key };
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  if (value.includes('/')) return null;
  return { canvasId: null, key: value };
}

/**
 * Markdown image syntax, splitting the leading `![alt](` from the link
 * destination so the destination alone can be rewritten in place.
 * The destination is either `<…>`-wrapped or a bare run of characters;
 * any trailing title and the closing paren are left untouched.
 */
const MARKDOWN_IMAGE_REGEX = /(!\[[^\]]*\]\(\s*)(<[^<>]*>|[^\s()]+)/g;

/** Strip the optional `<…>` wrapper from a Markdown link destination. */
function unwrapDestination(destination: string): string {
  return destination.startsWith('<') && destination.endsWith('>')
    ? destination.slice(1, -1)
    : destination;
}

/**
 * Collect the distinct artifact references embedded in a Markdown body,
 * in their raw (unwrapped) source form. External and inline images are
 * skipped — see `parseArtifactRef`.
 */
export function collectMarkdownArtifactRefs(markdown: string): string[] {
  if (!markdown) return [];
  const refs = new Set<string>();
  for (const match of markdown.matchAll(MARKDOWN_IMAGE_REGEX)) {
    const destination = unwrapDestination(match[2] ?? '');
    if (parseArtifactRef(destination)) refs.add(destination);
  }
  return [...refs];
}

/**
 * Rewrite embedded Markdown image destinations through `resolve`, which
 * receives the raw (unwrapped) destination and returns its replacement,
 * or `null` / `undefined` to leave it as-is.
 *
 * Only inline image syntax is covered — reference-style images
 * (`![alt][ref]`) and raw `<img>` HTML are left alone, since neither is
 * produced by the editor. The replacement is written unwrapped, so a
 * resolver must not return a destination containing whitespace or
 * parentheses (artifact keys never do).
 */
export function rewriteMarkdownArtifactRefs(
  markdown: string,
  resolve: (ref: string) => string | null | undefined,
): string {
  if (!markdown) return markdown;
  return markdown.replace(
    MARKDOWN_IMAGE_REGEX,
    (whole, prefix: string, destination: string) => {
      const next = resolve(unwrapDestination(destination));
      return next ? `${prefix}${next}` : whole;
    },
  );
}
