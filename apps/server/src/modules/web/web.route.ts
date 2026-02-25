import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { z } from 'zod';

import { getKnowledgeRepository } from '../knowledge/knowledge.repository.js';

import type {
  WebLookupQuery,
  WebPreviewResponse,
  WebReaderResponse,
} from '@sediment/shared';
import type { FastifyPluginAsync } from 'fastify';

const querySchema = z
  .object({
    sourceId: z.string().min(1),
  })
  .strict();

type Querystring = WebLookupQuery;

function safeParseMetaJson(metaJson: string | null): Record<string, unknown> {
  if (!metaJson) return {};
  try {
    const parsed = JSON.parse(metaJson) as unknown;
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
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
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ message: 'Invalid query' });
      }

      const { sourceId } = parsed.data;

      const repository = await getKnowledgeRepository();
      const source = repository.findSourceById(sourceId);
      if (!source || source.type !== 'web') {
        return reply.code(404).send({ message: 'Source not ingested' });
      }

      const meta = safeParseMetaJson(source.metaJson);
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
        title: (source.title ?? '').trim() || uri || sourceId,
        contentHtml: content ? toPreviewHtml(content) : undefined,
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
      };
      return reply.send(payload);
    },
  );

  fastify.get<{ Querystring: Querystring }>(
    '/reader',
    async (request, reply) => {
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ message: 'Invalid query' });
      }

      const { sourceId } = parsed.data;

      const repository = await getKnowledgeRepository();
      const source = repository.findSourceById(sourceId);
      if (!source || source.type !== 'web') {
        return reply.code(404).send({ message: 'Source not ingested' });
      }

      const markdown = (source.content ?? '').trim();
      if (!markdown) {
        return reply.code(404).send({ message: 'Source has no content yet' });
      }

      const meta = safeParseMetaJson(source.metaJson);
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
        title: (source.title ?? '').trim() || uri || sourceId,
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
};

export default webRoutes;
