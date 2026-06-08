import clsx from 'clsx';
import { Fullscreen, ArrowUpRight, ImageOff } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';

import { resolveAccent } from '@sediment/shared';

import { resolveArtifactUrl } from '@/api/artifact';
import { getWebPreview } from '@/api/web';

import { getNodeIcon } from '../../../config/nodeIcons.ts';
import { isElectron } from '../../../hooks/useElectron.ts';
import { useNodeScale } from '../../../hooks/useNodeScale.ts';
import useCanvasStore from '../../../store/canvasStore.ts';
import { FloatingToolbar } from '../../Common/FloatingToolbar.tsx';
import { LoadingState } from '../../Common/LoadingState.tsx';
import { getAccentTokens } from '../accentTokens.ts';
import { NodeWrapper } from '../NodeWrapper.tsx';

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
    const scale = useNodeScale(id, 'web');
    const openExpanded = useCanvasStore((s) => s.openExpanded);
    const canvasId = useCanvasStore((s) => s.canvasId);
    const ingestion = useCanvasStore((state) => state.ingestionByNodeId[id]);

    const [preview, setPreview] = useState<Awaited<
      ReturnType<typeof getWebPreview>
    > | null>(null);
    const [previewLoading, setPreviewLoading] = useState(false);
    const [previewError, setPreviewError] = useState<string | null>(null);

    const src = typeof data?.src === 'string' ? data.src : '';
    const isRemoteUrl = REMOTE_URL_RE.test(src);
    const isDataUrl = /^data:/i.test(src);
    // "Artifact" = canvas-local HTML file uploaded by the user (e.g.
    // `art_abc.html`). Identified by elimination: has content but isn't
    // a remote URL or a self-contained `data:` URL.
    const isHtmlArtifact = src.length > 0 && !isRemoteUrl && !isDataUrl;

    // URL surfaced as the "open externally" link in the floating toolbar.
    // Only remote http(s) URLs have a meaningful destination — uploaded
    // HTML artifacts live under our same-origin `/api/canvas/...` path
    // and `data:` URLs are self-contained, so there's no point opening
    // either in the system browser.
    const externalHref = useMemo(
      () => (isRemoteUrl ? src : ''),
      [isRemoteUrl, src],
    );

    // Iframe target for the live snapshot. Same canonical form the Preview
    // panel uses — remote URL, self-contained data URL, or same-origin
    // artifact URL. All three can be set directly as an iframe `src`.
    const livePreviewSrc = useMemo(() => {
      if (isRemoteUrl) return src;
      if (isDataUrl) return src;
      if (isHtmlArtifact) return resolveArtifactUrl(src, canvasId);
      return '';
    }, [isRemoteUrl, isDataUrl, isHtmlArtifact, src, canvasId]);

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
    }, [src, canvasId, ingestion?.status, id]);

    // Live iframe is reserved for the desktop build only. The Electron
    // main process strips `X-Frame-Options` / CSP `frame-ancestors`, so
    // the iframe always loads. In a plain browser those headers stay in
    // place and ~50% of real sites would render as a blank gray box —
    // we'd rather always show the og:image / favicon fallback than gamble
    // on the iframe. Interaction with the live page still lives in the
    // Preview panel (which the toolbar's Fullscreen button opens).
    const inElectron = useMemo(() => isElectron(), []);
    const liveIframeSrc = inElectron ? livePreviewSrc : '';

    // Track the live iframe's load state so we can fade it in (avoids
    // a flash of about:blank while the page paints).
    const [iframeReady, setIframeReady] = useState(false);
    useEffect(() => {
      setIframeReady(false);
    }, [liveIframeSrc]);

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
          title="Open Large View"
          onClick={(e) => {
            e.stopPropagation();
            openExpanded(id);
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
        actions={WebActions}
        resizable
        keepAspectRatio={false}
      >
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
                Invalid URL
              </div>
            ) : (
              <div className="flex h-full w-full flex-col">
                {/* ── Thumbnail area ──────────────────────────────────
                    Always shows *something* — never the empty gray box
                    or the browser's broken-image placeholder. Layer
                    order (bottom → top):
                      1. Accent-tinted background (or paper-white).
                      2. Centered favicon / globe icon "logo card" — the
                         baseline fallback that's always visible.
                      3. og:image cover (when present and not failed).
                      4. Live iframe (desktop only). */}
                <div
                  className="relative min-h-0 flex-1 overflow-hidden"
                  style={thumbBgStyle}
                >
                  {/* Layer 1: logo / favicon fallback. Always rendered so
                      a broken og:image (Layer 2) and a slow / blocked
                      iframe (Layer 3) both reveal a sensible visual
                      underneath instead of a gray box. */}
                  <div
                    className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6"
                    style={accentFg}
                  >
                    {showThumbFavicon ? (
                      <img
                        src={favicon}
                        alt=""
                        className="h-16 w-16 rounded-md object-contain"
                        decoding="async"
                        onError={() => setThumbFaviconFailed(true)}
                      />
                    ) : (
                      <NodeTypeIcon size={56} strokeWidth={1.25} />
                    )}
                    {siteName ? (
                      <span className="text-fg-muted max-w-full truncate text-sm">
                        {siteName}
                      </span>
                    ) : null}
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
                      style={{ objectPosition: 'top' }}
                      decoding="async"
                      draggable={false}
                      onError={() => setCoverImageFailed(true)}
                    />
                  ) : null}

                  {/* Layer 3: live iframe. Mounted only inside Electron
                      (the browser variant never gets past X-Frame-Options
                      reliably enough to be worth the gray-box risk).
                      `allow-scripts` so SPA-only sites render at all;
                      no `allow-same-origin` so the embed cannot reach
                      our cookies. Pointer-events disabled — node view
                      is a thumbnail; interaction lives in Preview. */}
                  {liveIframeSrc ? (
                    <iframe
                      src={liveIframeSrc}
                      sandbox="allow-scripts"
                      referrerPolicy="no-referrer"
                      title="Live snapshot"
                      className={clsx(
                        'bg-surface pointer-events-none absolute inset-0 block h-full w-full border-0 transition-opacity duration-200',
                        iframeReady ? 'opacity-100' : 'opacity-0',
                      )}
                      onLoad={() => setIframeReady(true)}
                    />
                  ) : null}

                  {previewLoading && !preview ? <LoadingState overlay /> : null}
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
            <LoadingState overlay message="Processing..." />
          ) : null}

          {/* Subtle "no preview" hint when extraction failed but the node still mounts. */}
          {previewError && !preview && ingestion?.status !== 'pending' ? (
            <div className="text-fg-subtle pointer-events-none absolute right-2 bottom-2 z-10 flex items-center gap-1 text-xs">
              <ImageOff size={12} />
            </div>
          ) : null}
        </div>
      </NodeWrapper>
    );
  },
);
