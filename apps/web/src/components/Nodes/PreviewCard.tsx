import { getNodeIcon } from '../../config/nodeIcons.ts';
import { SkeletonLines } from '../Common/SkeletonLines';

import type { CSSProperties, ReactNode } from 'react';

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
  /** Accent color hex for the gradient. Falls back to a neutral gray. */
  accentColor?: string | null;
  /** Called when the info area (title + summary) is clicked. */
  onInfoClick?: () => void;
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
  accentColor,
  onInfoClick,
  children,
}: PreviewCardProps) {
  const NodeTypeIcon = getNodeIcon(nodeType);

  const borderColor = accentColor ? `${accentColor}40` : 'var(--edge-default)';

  const hoverBg: CSSProperties = accentColor
    ? {
        ['--info-hover-bg' as string]: `color-mix(in srgb, ${accentColor} 8%, transparent)`,
      }
    : {
        ['--info-hover-bg' as string]: 'rgba(0,0,0,0.03)',
      };

  return (
    <div className="bg-surface relative flex h-full w-full flex-col overflow-hidden">
      {/* Full-card skeleton when loading */}
      {loading && !image ? (
        <SkeletonLines className="h-full w-full justify-center" />
      ) : (
        <>
          {/* Cover image */}
          {image ? (
            <img
              src={image}
              alt={imageAlt}
              className="bg-bg-default w-full shrink object-cover"
              style={{ minHeight: 0, objectPosition: imagePosition }}
              loading="lazy"
              draggable={false}
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          ) : null}

          {/* Info area — grows with node height, clickable to expand */}
          <div
            className="flex flex-1 shrink cursor-pointer flex-col transition-colors duration-150 hover:bg-[var(--info-hover-bg)]"
            style={{
              borderTop: `2px solid ${borderColor}`,
              ...hoverBg,
            }}
            onClick={() => {
              // e.stopPropagation();
              onInfoClick?.();
            }}
          >
            <div className="flex min-w-0 shrink-0 items-start gap-2 px-4 pt-2">
              <div
                className="flex flex-none translate-y-1 items-center"
                style={accentColor ? { color: accentColor } : undefined}
              >
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
              <span
                className="line-clamp-2 min-w-0 font-medium wrap-break-word"
                style={accentColor ? { color: accentColor } : undefined}
              >
                {title}
              </span>
            </div>

            {/* Summary — clamp is applied by callers on the text element */}
            {children ? (
              <div className="overflow-hidden px-4 pb-2">{children}</div>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
