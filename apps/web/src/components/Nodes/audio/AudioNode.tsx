// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Pause, Play } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { resolveArtifactUrl, uploadAudio } from '@/api/artifact';
import { cn } from '@/components/Common/cn';
import useCanvasStore from '@/store/canvasStore.ts';

import { getMissingFileKind, MissingFileBanner } from '../MissingFileBanner';
import { NodeWrapper } from '../NodeWrapper';

import type { CanvasAudioNodeData } from '../types';
import type { Node, NodeProps } from '@xyflow/react';

export type AudioNodeType = Node<CanvasAudioNodeData, 'audio'>;

type RecorderState = 'idle' | 'recording' | 'uploading' | 'error';

/**
 * Pick the most widely supported MIME type for in-browser recording.
 * Chrome/Edge/Firefox all support webm/opus; Safari falls back to mp4.
 */
function pickRecorderMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return undefined;
}

function mimeToExt(mime: string): string {
  if (mime.includes('webm')) return '.webm';
  if (mime.includes('mp4')) return '.m4a';
  if (mime.includes('ogg')) return '.ogg';
  return '.webm';
}

function formatSeconds(sec: number): string {
  if (!isFinite(sec) || isNaN(sec) || sec < 0) return '0:00';
  const total = Math.floor(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const BAR_COUNT = 22;

/** Keyboard arrow-key seek step for the scrubber. */
const SEEK_STEP_SEC = 5;

// Deterministic pseudo-waveform: stable across renders for a given seed
// so the bars don't flicker on re-mount. Half-sine envelope tapers the
// edges so it reads as a natural recording, not random noise.
function makeWaveform(seed: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const heights: number[] = [];
  for (let i = 0; i < BAR_COUNT; i++) {
    h = Math.imul(h ^ (i * 2654435761), 1597334677);
    const r = ((h >>> 0) % 1000) / 1000;
    const envelope = Math.sin((Math.PI * i) / (BAR_COUNT - 1));
    const v = 0.25 + r * 0.75 * envelope;
    heights.push(Math.max(0.18, Math.min(1, v)));
  }
  return heights;
}

const LIVE_BARS = Array.from({ length: BAR_COUNT }, (_, i) => i);

export const AudioNode = memo(
  ({ id, data, selected }: NodeProps<AudioNodeType>) => {
    const { t } = useTranslation();
    const canvasId = useCanvasStore((s) => s.canvasId);
    const updateNodeData = useCanvasStore((s) => s.updateNodeData);

    const [recState, setRecState] = useState<RecorderState>('idle');
    const [elapsedMs, setElapsedMs] = useState(0);
    const [errMsg, setErrMsg] = useState<string | null>(null);

    const recorderRef = useRef<MediaRecorder | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const startedAtRef = useRef(0);
    const timerRef = useRef<number | null>(null);

    const audioRef = useRef<HTMLAudioElement | null>(null);
    const listenersRef = useRef<Array<[string, EventListener]> | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentSec, setCurrentSec] = useState(0);
    const [durationSec, setDurationSec] = useState(0);

    const cleanupStream = useCallback(() => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      const stream = streamRef.current;
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      recorderRef.current = null;
      chunksRef.current = [];
    }, []);

    useEffect(() => cleanupStream, [cleanupStream]);

    const startRecording = useCallback(async () => {
      if (!canvasId) {
        setErrMsg(t('node.noCanvasToSave'));
        setRecState('error');
        return;
      }
      setErrMsg(null);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        const mime = pickRecorderMime();
        const recorder = mime
          ? new MediaRecorder(stream, { mimeType: mime })
          : new MediaRecorder(stream);

        chunksRef.current = [];
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.onstop = async () => {
          const usedMime = recorder.mimeType || mime || 'audio/webm';
          const blob = new Blob(chunksRef.current, { type: usedMime });
          cleanupStream();
          if (blob.size === 0) {
            setRecState('idle');
            setElapsedMs(0);
            return;
          }
          setRecState('uploading');
          try {
            const ext = mimeToExt(usedMime);
            const file = new File([blob], `recording${ext}`, {
              type: usedMime,
            });
            const uri = await uploadAudio(file, canvasId);
            updateNodeData(id, { src: uri });
            setRecState('idle');
            setElapsedMs(0);
          } catch (err) {
            console.error('Audio upload failed:', err);
            setErrMsg(
              err instanceof Error ? err.message : t('node.uploadFailed'),
            );
            setRecState('error');
          }
        };

        streamRef.current = stream;
        recorderRef.current = recorder;
        startedAtRef.current = Date.now();
        recorder.start();
        setElapsedMs(0);
        timerRef.current = window.setInterval(() => {
          setElapsedMs(Date.now() - startedAtRef.current);
        }, 200);
        setRecState('recording');
      } catch (err) {
        console.error('getUserMedia failed:', err);
        setErrMsg(
          err instanceof Error
            ? t('node.micBlocked', { message: err.message })
            : t('node.microphoneAccessDenied'),
        );
        setRecState('error');
        cleanupStream();
      }
    }, [canvasId, cleanupStream, id, updateNodeData, t]);

    const stopRecording = useCallback(() => {
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        recorder.stop();
      } else {
        cleanupStream();
        setRecState('idle');
      }
    }, [cleanupStream]);

    const togglePlay = useCallback(() => {
      const a = audioRef.current;
      if (!a) return;
      if (a.paused) void a.play();
      else a.pause();
    }, []);

    const seekTo = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        const a = audioRef.current;
        if (!a || !isFinite(durationSec) || durationSec <= 0) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const ratio = Math.min(
          1,
          Math.max(0, (e.clientX - rect.left) / rect.width),
        );
        a.currentTime = ratio * durationSec;
        setCurrentSec(a.currentTime);
      },
      [durationSec],
    );

    const seekBy = useCallback(
      (deltaSec: number) => {
        const a = audioRef.current;
        if (!a || !isFinite(durationSec) || durationSec <= 0) return;
        a.currentTime = Math.min(
          durationSec,
          Math.max(0, a.currentTime + deltaSec),
        );
        setCurrentSec(a.currentTime);
      },
      [durationSec],
    );

    // Attach listeners via a callback ref so they bind the moment the
    // <audio> element enters the DOM. A `useEffect([data?.src])` would
    // miss this because zustand's `updateNodeData` re-renders BEFORE
    // React's `setRecState('idle')` flushes, so the effect runs while
    // the element is still unmounted (recState === 'uploading').
    const setAudioRef = useCallback((el: HTMLAudioElement | null) => {
      const prev = audioRef.current;
      if (prev && prev !== el) {
        // Clean up listeners from the previous element (if any).
        const handlers = listenersRef.current;
        if (handlers) {
          for (const [name, fn] of handlers) {
            prev.removeEventListener(name, fn);
          }
          listenersRef.current = null;
        }
      }
      audioRef.current = el;
      if (!el) return;

      const onMeta = () => {
        // MediaRecorder WebM blobs often report `duration === Infinity`
        // because the container is written without a known length. The
        // standard trick: seek past the end so the browser scans the
        // stream and emits a `durationchange` with the real value, then
        // seek back to 0.
        if (!isFinite(el.duration) || isNaN(el.duration)) {
          const onFix = () => {
            if (isFinite(el.duration) && !isNaN(el.duration)) {
              el.removeEventListener('durationchange', onFix);
              el.currentTime = 0;
              setDurationSec(el.duration);
              setCurrentSec(0);
            }
          };
          el.addEventListener('durationchange', onFix);
          try {
            el.currentTime = Number.MAX_SAFE_INTEGER;
          } catch {
            // Some browsers throw on out-of-range seek; the duration
            // will resolve on first play() instead.
          }
          return;
        }
        setDurationSec(el.duration);
        setCurrentSec(el.currentTime);
      };
      const onTime = () => setCurrentSec(el.currentTime);
      const onPlay = () => setIsPlaying(true);
      const onPause = () => setIsPlaying(false);
      const onEnded = () => setIsPlaying(false);
      const handlers: Array<[string, EventListener]> = [
        ['loadedmetadata', onMeta as EventListener],
        ['durationchange', onMeta as EventListener],
        ['timeupdate', onTime as EventListener],
        ['play', onPlay as EventListener],
        ['pause', onPause as EventListener],
        ['ended', onEnded as EventListener],
      ];
      for (const [name, fn] of handlers) {
        el.addEventListener(name, fn);
      }
      listenersRef.current = handlers;

      // The element may already have metadata if cached — sync state now.
      if (isFinite(el.duration) && !isNaN(el.duration)) {
        setDurationSec(el.duration);
      } else {
        // Kick off the duration-fix dance immediately if metadata is
        // already partially loaded.
        onMeta();
      }
      setCurrentSec(el.currentTime);
      setIsPlaying(!el.paused);
    }, []);

    const waveform = useMemo(
      () => makeWaveform(data?.src ?? id),
      [data?.src, id],
    );

    const stopRf = (e: React.SyntheticEvent) => e.stopPropagation();
    const hasAudio = typeof data?.src === 'string' && data.src.length > 0;
    const missingFileKind = getMissingFileKind(data);
    const progressRatio =
      durationSec > 0 ? Math.min(1, currentSec / durationSec) : 0;

    let body: React.ReactNode;
    if (recState === 'uploading') {
      body = (
        <span className="text-fg-muted w-full text-center text-xs">
          {t('node.saving')}
        </span>
      );
    } else if (hasAudio) {
      body = (
        <>
          <button
            type="button"
            aria-label={isPlaying ? t('node.pause') : t('node.play')}
            title={isPlaying ? t('node.pause') : t('node.play')}
            onClick={(e) => {
              e.stopPropagation();
              togglePlay();
            }}
            className="bg-inverse text-fg-inverse hover:bg-inverse/80 nodrag flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors"
          >
            {isPlaying ? (
              <Pause className="h-3.5 w-3.5 fill-current" />
            ) : (
              <Play className="ml-0.5 h-3.5 w-3.5 fill-current" />
            )}
          </button>
          <div
            className="nodrag flex h-8 flex-1 cursor-pointer items-center gap-[2px]"
            onClick={(e) => {
              e.stopPropagation();
              seekTo(e);
            }}
            role="slider"
            aria-label={t('node.seek')}
            aria-valuemin={0}
            aria-valuemax={durationSec || 0}
            aria-valuenow={currentSec}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
              e.preventDefault();
              e.stopPropagation();
              seekBy(e.key === 'ArrowLeft' ? -SEEK_STEP_SEC : SEEK_STEP_SEC);
            }}
          >
            {waveform.map((h, i) => {
              const played = i / BAR_COUNT <= progressRatio;
              return (
                <span
                  key={i}
                  aria-hidden
                  className={cn(
                    'inline-block w-[2px] rounded-full transition-colors',
                    played ? 'bg-fg-default' : 'bg-fg-subtle/50',
                  )}
                  style={{ height: `${Math.round(h * 100)}%` }}
                />
              );
            })}
          </div>
          <span className="text-fg-muted shrink-0 text-[11px] tabular-nums">
            {formatSeconds(isPlaying ? currentSec : durationSec)}
          </span>
          <audio
            ref={setAudioRef}
            src={resolveArtifactUrl(data.src, canvasId)}
            preload="metadata"
            className="hidden"
          >
            {/* User-recorded audio has no caption source. */}
            <track kind="captions" />
          </audio>
        </>
      );
    } else if (recState === 'recording') {
      body = (
        <>
          <button
            type="button"
            aria-label={t('node.stopRecording')}
            title={t('node.stopRecording')}
            onClick={(e) => {
              e.stopPropagation();
              stopRecording();
            }}
            className="border-danger/60 nodrag flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 transition-transform hover:scale-105"
          >
            <span className="bg-danger block h-3 w-3 rounded-[3px]" />
          </button>
          <div
            aria-hidden
            className="audio-live-bars flex h-8 flex-1 items-center justify-center gap-[2px]"
          >
            {LIVE_BARS.map((i) => (
              <span
                key={i}
                className="bg-danger inline-block w-[2px] rounded-full"
                style={{ animationDelay: `${(i * 60) % 900}ms` }}
              />
            ))}
          </div>
          <span className="text-danger shrink-0 text-[11px] font-medium tabular-nums">
            {formatSeconds(elapsedMs / 1000)}
          </span>
        </>
      );
    } else {
      body = (
        <>
          <button
            type="button"
            aria-label={t('node.startRecording')}
            title={t('node.startRecording')}
            onClick={(e) => {
              e.stopPropagation();
              void startRecording();
            }}
            className="border-edge-default nodrag flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-transform hover:scale-105"
          >
            <span className="bg-danger block h-4 w-4 rounded-full" />
          </button>
          <span className="text-fg-muted flex-1 text-center text-[12px]">
            {t('node.tapToRecord')}
          </span>
          <span className="text-fg-subtle shrink-0 text-[11px] tabular-nums">
            0:00
          </span>
        </>
      );
    }

    return (
      <NodeWrapper
        id={id}
        data={data}
        type={'audio'}
        selected={selected}
        minHeight={56}
        className={missingFileKind ? undefined : 'bg-surface'}
      >
        {missingFileKind ? (
          <MissingFileBanner nodeId={id} />
        ) : (
          <div
            role="presentation"
            className="flex h-full w-full items-center gap-2.5 px-3"
            onPointerDown={stopRf}
            onMouseDown={stopRf}
          >
            {body}
            {recState === 'error' && errMsg && (
              <span
                className="text-danger ml-1 truncate text-[10px]"
                title={errMsg}
              >
                {errMsg}
              </span>
            )}
          </div>
        )}
      </NodeWrapper>
    );
  },
);

AudioNode.displayName = 'AudioNode';
