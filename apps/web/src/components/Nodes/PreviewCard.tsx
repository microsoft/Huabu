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
  children?: ReactNode;
}

export function PreviewCard({
  image,
  imageAlt = '',
  nodeType,
  favicon,
  title,
  children,
}: PreviewCardProps) {
  const NodeTypeIcon = getNodeIcon(nodeType);

  return (
    <div className="flex h-full w-full flex-col justify-evenly overflow-hidden bg-white">
      {/* Cover image — shrinks first when space is tight */}
      {image ? (
        <img
          src={image}
          alt={imageAlt}
          className="bg-background w-full shrink object-cover"
          style={{ minHeight: 0 }}
          loading="lazy"
          draggable={false}
          onError={(e) => {
            e.currentTarget.style.display = 'none';
          }}
        />
      ) : null}

      {/* Icon + title — always visible, vertically centered */}
      <div className="flex min-w-0 shrink-0 items-start gap-2 px-2 py-1">
        <div className="text-muted-foreground flex flex-none translate-y-1 items-center">
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
        <span className="text-main line-clamp-2 min-w-0 text-base font-medium wrap-break-word">
          {title}
        </span>
      </div>

      {/* Extra content (e.g. web page contentHtml) — fills remaining space */}
      {children}
    </div>
  );
}
