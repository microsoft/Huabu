import { getNodeIcon } from '../../config/nodeIcons.ts';

import type { ReactNode } from 'react';

/**
 * Shared card layout used by WebNode and PDFNode (cover mode).
 * Renders: cover image → icon + site label + title → optional children.
 */
export interface PreviewCardProps {
  image?: string;
  imageAlt?: string;
  /** Node type — determines the icon via nodeIcons config. */
  nodeType: string;
  /** Optional favicon URL that overrides the node-type icon. */
  favicon?: string;
  title: string;
  /** Show a loading spinner in the image area. */
  loading?: boolean;
  /** Which part of the image to anchor when cropped. Defaults to 'center'. */
  imagePosition?: 'top' | 'center';
  children?: ReactNode;
}

export function PreviewCard({
  image,
  imageAlt = '',
  nodeType,
  favicon,
  title,
  loading = false,
  imagePosition = 'center',
  children,
}: PreviewCardProps) {
  const NodeTypeIcon = getNodeIcon(nodeType);

  return (
    <div className="bg-surface flex h-full w-full flex-col justify-evenly overflow-hidden">
      {/* Full-card skeleton when loading */}
      {loading && !image ? (
        <div className="skeleton-lines h-full w-full justify-center">
          <div className="skeleton-line" />
          <div className="skeleton-line" />
          <div className="skeleton-line" />
        </div>
      ) : (
        <>
          {/* Cover image */}
          {image ? (
            <img
              src={image}
              alt={imageAlt}
              className="bg-bg-default w-full shrink object-cover"
              style={{
                minHeight: 0,
                objectPosition: imagePosition,
              }}
              loading="lazy"
              draggable={false}
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          ) : null}

          {/* Icon + title — always visible, vertically centered */}
          <div className="flex min-w-0 shrink-0 items-start gap-2 px-2 py-1">
            <div className="text-fg-muted flex flex-none translate-y-1 items-center">
              {favicon ? (
                <img
                  src={favicon}
                  alt=""
                  className="h-4 w-4 rounded-sm"
                  loading="lazy"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                  }}
                />
              ) : (
                <NodeTypeIcon size={16} />
              )}
            </div>
            <span className="text-fg-default line-clamp-2 min-w-0 text-base font-medium wrap-break-word">
              {title}
            </span>
          </div>

          {/* Extra content (e.g. summary, contentHtml) — fills remaining space,
              but always reserves at least ~2 lines so text is never fully hidden */}
          {children ? (
            <div className="min-h-13 flex-1 shrink overflow-hidden">
              {children}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
