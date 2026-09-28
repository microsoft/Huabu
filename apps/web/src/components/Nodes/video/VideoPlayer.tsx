// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Film } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { resolveArtifactUrl } from '@/api/artifact';

import { videoCoverSource, youtubeEmbedUrl } from './videoSource';

function NativeVideo({
  src,
  poster,
  title,
  startPlayback,
  onPlaybackError,
}: {
  src: string;
  poster?: string;
  title: string;
  startPlayback: boolean;
  onPlaybackError?: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useLayoutEffect(() => {
    const video = ref.current;
    let disposed = false;
    if (video && startPlayback) {
      // This mount is committed by the explicit Play gesture, not selection or preview.
      void video.play().catch(() => {
        if (!disposed) onPlaybackError?.();
      });
    }
    // Removal must stop audio as well as hide the controls (including preview close).
    return () => {
      disposed = true;
      video?.pause();
    };
  }, [startPlayback, onPlaybackError]);
  return (
    <video
      ref={ref}
      src={src}
      poster={poster}
      aria-label={title}
      controls
      playsInline
      preload="metadata"
      onError={onPlaybackError}
      className="h-full w-full object-contain"
    >
      {/* User-supplied videos do not provide a caption source. */}
      <track kind="captions" />
    </video>
  );
}

/** Shared canvas/expanded player. Inactive instances load only a source-matched poster. */
export function VideoPlayer({
  data,
  canvasId,
  active,
  startPlayback = false,
  onPlaybackError,
  placeholder = 'glyph',
}: {
  data: Record<string, unknown>;
  canvasId: string;
  active: boolean;
  startPlayback?: boolean;
  onPlaybackError?: () => void;
  /** The canvas supplies its own Play action; previews retain a neutral fallback. */
  placeholder?: 'glyph' | 'empty';
}) {
  const { t } = useTranslation();
  const src = typeof data.src === 'string' ? data.src : '';
  const cover = videoCoverSource(data);
  const poster = cover ? resolveArtifactUrl(cover, canvasId) : undefined;
  const title = typeof data.label === 'string' ? data.label : 'Video';
  const embed = youtubeEmbedUrl(src, startPlayback);
  return (
    <div
      className="bg-fg-default/5 relative h-full w-full overflow-hidden rounded-[inherit]"
      data-video-player
    >
      {active && src ? (
        embed ? (
          <iframe
            key={embed}
            src={embed}
            title={title}
            className="h-full w-full border-0"
            sandbox="allow-scripts allow-same-origin allow-presentation"
            allow={`${startPlayback ? 'autoplay; ' : ''}encrypted-media; fullscreen; picture-in-picture`}
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <NativeVideo
            key={resolveArtifactUrl(src, canvasId)}
            src={resolveArtifactUrl(src, canvasId)}
            poster={poster}
            title={title}
            startPlayback={startPlayback}
            onPlaybackError={onPlaybackError}
          />
        )
      ) : (
        <div className="pointer-events-none flex h-full w-full items-center justify-center select-none">
          {poster ? (
            <img
              src={poster}
              alt={title}
              draggable={false}
              className="h-full w-full object-contain"
            />
          ) : (
            <div className="text-fg-subtle flex flex-col items-center gap-2 text-sm">
              {(placeholder === 'glyph' || !src) && (
                <Film size={48} strokeWidth={1.5} aria-hidden />
              )}
              {!src && <span>{t('node.noVideoSource')}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
