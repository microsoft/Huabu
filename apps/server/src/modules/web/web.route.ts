// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

import {
  interactiveViewDefinitionV1Schema,
  webLookupQuerySchema,
} from '@huabu/shared';

import { space } from '../storage/index.js';

import type {
  WebLookupQuery,
  WebPageResponse,
  WebPreviewResponse,
  WebReaderResponse,
} from '@huabu/shared';
import type { FastifyPluginAsync } from 'fastify';

type Querystring = WebLookupQuery;

const REMOTE_URL_RE = /^https?:\/\//i;
const DATA_URL_RE = /^data:/i;

function isMhtmlArtifactKey(src: string): boolean {
  return src.toLowerCase().endsWith('.mhtml');
}

function toReaderHtml(markdown: string): string {
  const rawHtml = marked.parse(markdown) as string;

  const clean = sanitizeHtml(rawHtml, {
    allowedTags: [
      'p',
      'br',
      'hr',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'blockquote',
      'pre',
      'code',
      'ul',
      'ol',
      'li',
      'strong',
      'em',
      'del',
      'a',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'div',
      'span',
      'img',
      'figure',
      'figcaption',
    ],
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
      code: ['class'],
      th: ['colspan', 'rowspan'],
      td: ['colspan', 'rowspan'],
      img: [
        'src',
        'alt',
        'title',
        'width',
        'height',
        'loading',
        'referrerpolicy',
      ],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      a: (tagName: string, attribs: Record<string, string>) => {
        const href = typeof attribs.href === 'string' ? attribs.href : '';
        return {
          tagName,
          attribs: {
            ...attribs,
            href,
            target: '_blank',
            rel: 'noopener noreferrer',
          },
        };
      },
      img: (tagName: string, attribs: Record<string, string>) => {
        const src = typeof attribs.src === 'string' ? attribs.src : '';
        return {
          tagName,
          attribs: {
            ...attribs,
            src,
            loading: 'lazy',
            referrerpolicy: 'no-referrer',
          },
        };
      },
    },
  });

  return clean;
}

/**
 * Convert markdown to sanitized HTML for compact node preview.
 * Strips links (replaced with plain text) and images entirely.
 */
function toPreviewHtml(markdown: string): string {
  const rawHtml = marked.parse(markdown) as string;

  const clean = sanitizeHtml(rawHtml, {
    allowedTags: [
      'p',
      'br',
      'hr',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'blockquote',
      'pre',
      'code',
      'ul',
      'ol',
      'li',
      'strong',
      'em',
      'del',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'div',
      'span',
    ],
    allowedAttributes: {
      code: ['class'],
      th: ['colspan', 'rowspan'],
      td: ['colspan', 'rowspan'],
    },
  });

  return clean;
}

const webRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: Querystring }>(
    '/preview',
    async (request, reply) => {
      const parsed = webLookupQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ message: 'Invalid query' });
      }

      const { canvasId, nodeId } = parsed.data;

      const source = (await space(canvasId).nodes.read(nodeId))?.record;
      if (!source || source.type !== 'web') {
        return reply.code(404).send({ message: 'Source not ingested' });
      }

      const meta = source as unknown as Record<string, unknown>;
      const uri = source.src ?? '';

      const hostname = (() => {
        try {
          return new URL(uri).hostname;
        } catch {
          return '';
        }
      })();

      const content = (source.content ?? '').trim();

      const payload: WebPreviewResponse = {
        url: uri,
        label: (source.label ?? '').trim() || undefined,
        contentHtml: content ? toPreviewHtml(content) : undefined,
        summary:
          typeof meta.summary === 'string' && meta.summary.trim()
            ? meta.summary.trim()
            : undefined,
        image:
          typeof meta.image === 'string' && meta.image.trim()
            ? meta.image.trim()
            : undefined,
        favicon:
          typeof meta.favicon === 'string' && meta.favicon.trim()
            ? meta.favicon.trim()
            : undefined,
        siteName:
          typeof meta.siteName === 'string' && meta.siteName.trim()
            ? meta.siteName.trim()
            : hostname || undefined,
        embeddable:
          typeof meta.embeddable === 'boolean' ? meta.embeddable : undefined,
        mhtmlArtifact:
          typeof meta.mhtmlArtifact === 'string' && meta.mhtmlArtifact.trim()
            ? meta.mhtmlArtifact.trim()
            : undefined,
      };
      return reply.send(payload);
    },
  );

  fastify.get<{ Querystring: Querystring }>(
    '/reader',
    async (request, reply) => {
      const parsed = webLookupQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ message: 'Invalid query' });
      }

      const { canvasId, nodeId } = parsed.data;

      const source = (await space(canvasId).nodes.read(nodeId))?.record;
      if (!source || source.type !== 'web') {
        return reply.code(404).send({ message: 'Source not ingested' });
      }

      const markdown = (source.content ?? '').trim();
      if (!markdown) {
        return reply.code(404).send({ message: 'Source has no content yet' });
      }

      const meta = source as unknown as Record<string, unknown>;
      const uri = source.src ?? '';
      const hostname = (() => {
        try {
          return new URL(uri).hostname;
        } catch {
          return '';
        }
      })();

      const html = toReaderHtml(markdown);
      const payload: WebReaderResponse = {
        url: uri,
        label: (source.label ?? '').trim(),
        html,
        contentMarkdown: markdown,
        siteName:
          typeof meta.siteName === 'string' && meta.siteName.trim()
            ? meta.siteName.trim()
            : hostname || undefined,
      };
      return reply.send(payload);
    },
  );

  /**
   * Resolve the iframe target for a web node's Preview panel.
   *
   * Two flavours:
   *   - Remote URL nodes  → returns the canonical URL so the iframe loads
   *                         the live site. Cross-origin; the desktop main
   *                         process strips `X-Frame-Options` /
   *                         `frame-ancestors` so most sites render. In a
   *                         plain browser the iframe will often fail — the
   *                         client falls back to the reader view.
   *   - HTML artifact nodes → returns the same-origin artifact URL
   *                         (`/api/canvas/<id>/artifact/<key>`). Always
   *                         renders.
   */
  fastify.get<{ Querystring: Querystring }>('/page', async (request, reply) => {
    const parsed = webLookupQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ message: 'Invalid query' });
    }

    const { canvasId, nodeId } = parsed.data;

    const source = (await space(canvasId).nodes.read(nodeId))?.record;
    if (!source || source.type !== 'web') {
      return reply.code(404).send({ message: 'Source not ingested' });
    }

    const src = (source.src ?? '').trim();
    if (!src) {
      return reply.code(404).send({ message: 'Web node has no source' });
    }

    // `embeddable` was captured during the original fetch and stored as
    // top-level frontmatter on the node sidecar. Surfaced verbatim so the
    // plain-browser client can skip the live iframe attempt when we
    // already know the page refuses embedding. `undefined` for nodes
    // that predate this signal — the client should optimistically try
    // live in that case.
    const meta = source as unknown as Record<string, unknown>;
    const embeddable =
      typeof meta.embeddable === 'boolean' ? meta.embeddable : undefined;

    // One-shot snapshot wins over the live URL: when the preprocess
    // pipeline has captured an `.mhtml` artifact, point the iframe at
    // the same-origin artifact route instead of refetching the remote
    // site every render. The artifact route decodes `.mhtml` payloads
    // and serves the inner HTML as `text/html`, so the embed model is
    // identical to a regular HTML artifact — always embeddable.
    const mhtmlArtifact =
      typeof meta.mhtmlArtifact === 'string' && meta.mhtmlArtifact.trim()
        ? meta.mhtmlArtifact.trim()
        : null;
    if (mhtmlArtifact) {
      const payload: WebPageResponse = {
        src: `/api/canvas/${encodeURIComponent(canvasId)}/artifact/${encodeURIComponent(mhtmlArtifact)}`,
        kind: 'html',
        embeddable: true,
        // Static archive of an already-rendered page. The client must
        // embed it with scripts off — see `WebPageResponse.snapshot`.
        snapshot: true,
      };
      return reply.send(payload);
    }

    if (REMOTE_URL_RE.test(src)) {
      const payload: WebPageResponse = { src, kind: 'url', embeddable };
      return reply.send(payload);
    }

    // `data:` URLs (AI-generated HTML snippets, inline base64 docs, etc.)
    // are self-contained — the browser renders them directly, no fetch
    // round-trip needed. Pass through as-is. Treat them as `html` kind
    // because they share the artifact security model (we control the
    // bytes, but the iframe still needs `allow-same-origin` off to keep
    // them from reaching the host page).
    if (DATA_URL_RE.test(src)) {
      const payload: WebPageResponse = { src, kind: 'html', embeddable: true };
      return reply.send(payload);
    }

    const structuralNodes = (await space(canvasId).read())?.state.nodes as
      | Array<{
          id?: unknown;
          type?: unknown;
          data?: Record<string, unknown>;
        }>
      | undefined;
    const structuralNode = structuralNodes?.find((node) => node.id === nodeId);
    if (
      structuralNode?.type === 'web' &&
      interactiveViewDefinitionV1Schema.safeParse(
        structuralNode.data?.interactiveView,
      ).success
    ) {
      const payload: WebPageResponse = {
        src: `/api/interactive-views/${encodeURIComponent(canvasId)}/${encodeURIComponent(nodeId)}/renderer`,
        kind: 'html',
        embeddable: true,
      };
      return reply.send(payload);
    }

    // Artifact key (e.g. `art_abc.html`) — build the same-origin URL the
    // browser can request directly. The artifact route serves the file
    // with its original Content-Type so the iframe gets a real HTML
    // document. Same-origin URLs are always embeddable.
    const payload: WebPageResponse = {
      src: `/api/canvas/${encodeURIComponent(canvasId)}/artifact/${encodeURIComponent(src)}`,
      kind: 'html',
      embeddable: true,
      ...(isMhtmlArtifactKey(src) ? { snapshot: true } : {}),
    };
    return reply.send(payload);
  });
};

export default webRoutes;
