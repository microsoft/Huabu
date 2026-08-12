// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Fullscreen, ArrowUpRight, ImageOff } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { resolveAccent } from '@huabu/shared';

import { getWebPreview } from '@/api/web';

import { getNodeIcon } from '../../../config/nodeIcons.ts';
import { useNodeLOD } from '../../../hooks/useNodeLOD.ts';
import { useNodeScale } from '../../../hooks/useNodeScale.ts';
import useCanvasStore from '../../../store/canvasStore.ts';
import { openPreviewNode } from '../../../store/previewWorkspace/actions.ts';
import { FloatingToolbar } from '../../Common/FloatingToolbar.tsx';
import { Loading } from '../../Common/Loading';
import { getAccentTokens } from '../accentTokens.ts';
import { getMissingFileKind, MissingFileBanner } from '../MissingFileBanner';
import { NodeWrapper } from '../NodeWrapper.tsx';
import { useDeferredHydration } from '../shared/nodeHydrationScheduler.ts';

import type { CanvasWebNodeData } from '../types.ts';
import type { Node, NodeProps } from '@xyflow/react';
import type { CSSProperties } from 'react';

export type WebNodeType = Node<CanvasWebNodeData, 'web'>;

const REMOTE_URL_RE = /^https?:\/\//i;

function shortenForToolbar(src: string): string {
  if (!src) return 'Website';
  if (!REMOTE_URL_RE.test(src)) return src; // artifact key like `art_xxx.html`
  try {
    return new URL(src).hostname;
  } catch {
    return src;
  }
}

export const WebNode = memo(
  ({ id, data, selected }: NodeProps<WebNodeType>) => {
    const { t } = useTranslation();
    const scale = useNodeScale(id, 'web');
    const isMinimalLOD = useNodeLOD(id, 'web') === 'minimal';
    const canvasId = useCanvasStore((s) => s.canvasId);
    const ingestion = useCanvasStore((state) => state.ingestionByNodeId[id]);

    const [preview, setPreview] = useState<Awaited<
      ReturnType<typeof getWebPreview>
    > | null>(null);
    const [previewLoading, setPreviewLoading] = useState(false);
    const [previewError, setPreviewError] = useState<string | null>(null);

    // Defer the per-node preview fetch through the shared per-frame
    // hydration scheduler. Without this, every WebNode on a freshly-
    // opened canvas would fire its `/api/web/preview` request in the
    // same tick and trigger a setState storm as each result lands
    // ~simultaneously. Minimal LOD skips the queue entirely; once the node
    // returns to full LOD, the hook grants one node per frame so requests +
    // paints stream in. See `../shared/nodeHydrationScheduler`.
    const webHydrated = useDeferredHydration(isMinimalLOD);

    const src = typeof data?.src === 'string' ? data.src : '';
    const missingFileKind = getMissingFileKind(data);
    const isRemoteUrl = REMOTE_URL_RE.test(src);

    // URL surfaced as the "open externally" link in the floating toolbar.
    // Only remote http(s) URLs have a meaningful destination — uploaded
    // HTML artifacts live under our same-origin `/api/canvas/...` path
    // and `data:` URLs are self-contained, so there's no point opening
    // either in the system browser.
    const externalHref = useMemo(
      () => (isRemoteUrl ? src : ''),
      [isRemoteUrl, src],
    );

    useEffect(() => {
      if (ingestion?.status === 'pending') {
        setPreview(null);
        setPreviewError(null);
        setPreviewLoading(false);
        return;
      }

      if (!src || !canvasId) {
        setPreview(null);
        setPreviewError(null);
        setPreviewLoading(false);
        return;
      }

      // Stagger the preview fetch through the shared hydration
      // scheduler so a canvas full of web nodes doesn't fire N
      // /api/web/preview requests + N React setState bursts in the
      // same frame on first mount. The hook returns `true` once this
      // node is granted a slot; subsequent re-runs (ingestion status
      // changes, src updates) re-enter this effect with `webHydrated`
      // already true, so the staggering cost is paid exactly once per
      // node lifetime. Minimal LOD also suppresses the request; entering it
      // while a request is in flight runs this effect's cleanup and ignores
      // the eventual result.
      if (isMinimalLOD) return;
      if (!webHydrated) return;

      let cancelled = false;
      setPreviewLoading(true);
      setPreviewError(null);

      void (async () => {
        try {
          const result = await getWebPreview({ canvasId, nodeId: id });
          if (cancelled) return;
          setPreview(result);
        } catch (error) {
          if (cancelled) return;
          // 404 here is normal — happens when the node markdown hasn't
          // been written yet (first render before preprocessing has
          // persisted anything). The next effect run (when ingestion
          // transitions out of pending) will retry.
          setPreview(null);
          setPreviewError(
            error instanceof Error ? error.message : String(error),
          );
        } finally {
          if (!cancelled) setPreviewLoading(false);
        }
      })();

      return () => {
        cancelled = true;
      };
    }, [src, canvasId, ingestion?.status, id, isMinimalLOD, webHydrated]);

    // Track image-load failures so we degrade cleanly. Without these the
    // browser would show its built-in "broken image" placeholder (the
    // sad-face document icon) for a few hundred ms before our onError
    // could hide the element, which looks like the node is broken.
    const [coverImageFailed, setCoverImageFailed] = useState(false);
    const [thumbFaviconFailed, setThumbFaviconFailed] = useState(false);
    const [footerFaviconFailed, setFooterFaviconFailed] = useState(false);

    const summary = preview?.summary;
    const title = preview?.label || data?.label || src;
    const favicon = preview?.favicon;
    const fallbackImage = preview?.image;
    const siteName = preview?.siteName;

    // Reset image-failure flags whenever the preview payload changes so a
    // re-preprocess that swaps in a fresh URL gets another chance to load.
    useEffect(() => {
      setCoverImageFailed(false);
      setThumbFaviconFailed(false);
      setFooterFaviconFailed(false);
    }, [fallbackImage, favicon]);

    // Accent tokens used by the footer divider + tinted backgrounds so
    // the node visually echoes any user-picked color. Mirrors the styling
    // of PreviewCard / PDFNode so Web nodes sit consistently next to
    // other node types.
    const resolvedAccent = resolveAccent(data.style?.accent);
    const accentTokens = resolvedAccent
      ? getAccentTokens(resolvedAccent)
      : null;
    const footerStyle: CSSProperties = {
      borderTop: `2px solid ${accentTokens?.divider ?? 'var(--edge-default)'}`,
      background: accentTokens?.softBg ?? 'transparent',
    };
    const accentFg: CSSProperties | undefined = accentTokens
      ? { color: accentTokens.fg }
      : undefined;
    // Thumbnail background: use the accent's soft tint when set, otherwise
    // `bg-surface` (paper-white) instead of `bg-default` (gray) so an
    // empty / loading state never looks like a broken placeholder.
    const thumbBgStyle: CSSProperties = {
      background: accentTokens?.softBg ?? 'var(--surface)',
    };

    const NodeTypeIcon = getNodeIcon('web');

    // Should we render the og:image cover? Only when it loaded successfully.
    const showCoverImage = !!fallbackImage && !coverImageFailed;
    // Big centered favicon when we can't show a cover image.
    const showThumbFavicon = !!favicon && !thumbFaviconFailed;

    const WebActions = (
      <>
        {externalHref ? (
          <a
            href={externalHref}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="nodrag text-fg-muted hover:text-info flex flex-1 cursor-pointer items-center gap-1 overflow-hidden text-xs font-medium transition-colors"
          >
            <span className="max-w-24 truncate">{shortenForToolbar(src)}</span>
            <ArrowUpRight size={14} strokeWidth={2} />
          </a>
        ) : null}
        <FloatingToolbar.ActionButton
          title={t('node.openLargeView')}
          onClick={(e) => {
            e.stopPropagation();
            openPreviewNode(id);
          }}
        >
          <Fullscreen />
        </FloatingToolbar.ActionButton>
      </>
    );

    return (
      <NodeWrapper
        id={id}
        data={data}
        type={'web'}
        selected={selected}
        actions={missingFileKind ? undefined : WebActions}
        resizable
        keepAspectRatio={false}
      >
        {missingFileKind ? (
          <MissingFileBanner nodeId={id} />
        ) : (
          <div className="bg-surface relative flex h-full w-full flex-col overflow-hidden rounded-lg">
            <div
              style={{
                transform: `scale(${scale})`,
                transformOrigin: 'top left',
                width: `${100 / scale}%`,
                height: `${100 / scale}%`,
              }}
            >
              {!src ? (
                <div className="text-fg-subtle flex h-full w-full items-center justify-center text-base">
                  {t('node.invalidUrl')}
                </div>
              ) : (
                <div className="flex h-full w-full flex-col">
                  {/* ── Thumbnail area ──────────────────────────────────
                    Static preview only — no live iframe (the embedded
                    page's scripts were a large per-node perf cost and are
                    reserved for the expanded Preview panel now). Layer
                    order (bottom → top):
                      1. Accent-tinted background (or paper-white).
                      2. Favicon "logo card", or a "No preview" hint when
                         even the favicon is missing.
                      3. og:image cover (when present and not failed). */}
                  <div
                    className="relative min-h-0 flex-1 overflow-hidden"
                    style={thumbBgStyle}
                  >
                    {/* Layer 1: favicon fallback, or a "No preview" hint.
                      Always rendered so a missing / broken og:image
                      (Layer 2) reveals a sensible visual underneath
                      instead of a gray box. */}
                    <div
                      className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6"
                      style={accentFg}
                    >
                      {showThumbFavicon ? (
                        <>
                          <img
                            src={favicon}
                            alt=""
                            className="h-16 w-16 rounded-md object-contain"
                            decoding="async"
                            onError={() => setThumbFaviconFailed(true)}
                          />
                          {siteName ? (
                            <span className="text-fg-muted max-w-full truncate text-sm">
                              {siteName}
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <>
                          <NodeTypeIcon
                            size={40}
                            strokeWidth={1.25}
                            className="text-fg-subtle"
                          />
                          <span className="text-fg-subtle text-sm">
                            {siteName || t('node.noPreview')}
                          </span>
                        </>
                      )}
                    </div>

                    {/* Layer 2: og:image cover. Sits above the favicon
                      fallback and hides it when the image loads. On
                      error we flip state so the fallback re-appears
                      (preventing the broken-image flash). */}
                    {showCoverImage ? (
                      <img
                        src={fallbackImage}
                        alt={title}
                        className="absolute inset-0 block h-full w-full object-cover"
                        decoding="async"
                        draggable={false}
                        onError={() => setCoverImageFailed(true)}
                      />
                    ) : null}

                    {previewLoading && !preview ? (
                      <Loading layout="overlay" variant="skeleton" />
                    ) : null}
                  </div>

                  {/* ── Footer: icon + title + AI summary ───────────────
                    Fixed-content height so it never grows; the thumbnail
                    above absorbs any extra space when the user resizes. */}
                  <div
                    className="flex shrink-0 flex-col gap-1 px-4 pt-2 pb-3"
                    style={footerStyle}
                  >
                    <div className="flex items-start gap-2" style={accentFg}>
                      <span className="mt-1 flex shrink-0 items-center">
                        {favicon && !footerFaviconFailed ? (
                          <img
                            src={favicon}
                            alt=""
                            className="h-4 w-4 rounded-sm"
                            decoding="async"
                            onError={() => setFooterFaviconFailed(true)}
                          />
                        ) : (
                          <NodeTypeIcon size={16} />
                        )}
                      </span>
                      <span className="min-w-0 text-base font-medium wrap-break-word">
                        {title}
                      </span>
                    </div>
                    {previewError && ingestion?.status !== 'pending' ? (
                      <p className="text-fg-subtle text-sm"></p>
                    ) : summary ? (
                      <p className="text-fg-muted line-clamp-3 text-sm leading-relaxed">
                        {summary}
                      </p>
                    ) : null}
                  </div>
                </div>
              )}
            </div>

            {/* Loading overlay while preprocessing is in-flight. */}
            {ingestion?.status === 'pending' && !preview ? (
              <Loading
                layout="overlay"
                variant="skeleton"
                message={t('node.processing')}
              />
            ) : null}

            {/* Subtle "no preview" hint when extraction failed but the node still mounts. */}
            {previewError && !preview && ingestion?.status !== 'pending' ? (
              <div className="text-fg-subtle pointer-events-none absolute right-2 bottom-2 z-10 flex items-center gap-1 text-xs">
                <ImageOff size={12} />
              </div>
            ) : null}
          </div>
        )}
      </NodeWrapper>
    );
  },
);
