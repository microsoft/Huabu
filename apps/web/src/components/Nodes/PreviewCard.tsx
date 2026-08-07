// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { resolveAccent } from '@huabu/shared';

import { getAccentTokens } from './accentTokens';
import { getNodeIcon } from '../../config/nodeIcons.ts';
import { Loading } from '../Common/Loading';

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
  children,
}: PreviewCardProps) {
  const NodeTypeIcon = getNodeIcon(nodeType);

  // accentColor may be a palette token, legacy hex, or null.
  const resolvedAccent = resolveAccent(accentColor);
  const accentTokens = resolvedAccent ? getAccentTokens(resolvedAccent) : null;

  const borderColor = accentTokens?.divider ?? 'var(--edge-default)';

  // Foreground for icon + title — derived via the same formula as
  // SemanticPlaceholder so the color does not jump when LOD changes.
  const accentFg: CSSProperties | undefined = accentTokens
    ? { color: accentTokens.fg }
    : undefined;

  // Info-area background — a very subtle accent tint so the section reads
  // as related to the cover image without competing with it.
  const infoAreaStyle: CSSProperties = {
    borderTop: `2px solid ${borderColor}`,
    background: accentTokens?.softBg ?? 'transparent',
  };

  return (
    <div className="bg-surface relative flex h-full w-full flex-col overflow-hidden">
      {/* Full-card skeleton when loading */}
      {loading && !image ? (
        <Loading
          variant="skeleton"
          layout="bare"
          className="h-full w-full justify-center"
        />
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

          {/* Info area — grows with node height. */}
          <div className="flex flex-1 shrink flex-col" style={infoAreaStyle}>
            <div className="min-w-0 shrink-0 px-4 pt-2">
              {/* Float the icon so the title wraps underneath it instead
                  of staying indented on subsequent lines. */}
              <div
                className="float-left mr-2 flex translate-y-1.75 items-center"
                style={accentFg}
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
                className="min-w-0 text-lg font-medium wrap-break-word"
                style={accentFg}
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
