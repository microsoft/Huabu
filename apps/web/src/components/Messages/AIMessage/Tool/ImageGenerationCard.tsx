// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * ImageGenerationCard — disclosure-shaped renderer for the
 * `generate_image` tool. Title is a self-describing summary
 * ("Generating image…", "Generated \"prompt\"", "Edited image from
 * 2 refs"); the expanded body shows a thumbnail preview of the
 * produced PNG plus the prompt / size / quality metadata so the user
 * can verify a slow generation succeeded without first having to
 * drop the result onto the canvas.
 *
 * Error state surfaces the provider message inline — `generate_image`
 * is one of the slowest tools (5–30s) and the most common failure
 * surfaces (deployment / api-version misconfig, capability mismatch)
 * are otherwise invisible from the chat.
 */

import { ImagePlus, X as XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { partIsExecuting, truncate } from './helpers';
import { resolveArtifactUrl } from '../../../../api/artifact';
import useCanvasStore from '../../../../store/canvasStore';
import { Loading } from '../../../Common/Loading';
import { AssistantDisclosure } from '../../AssistantDisclosure';

import type { ImageGenerationToolPart } from '@huabu/shared';

interface ImageGenerationCardProps {
  part: ImageGenerationToolPart;
}

function pickDataFields(part: ImageGenerationToolPart) {
  // Args + result are flat-merged on `data.data` by the stream
  // merger. The envelope is `success` while the call is in flight
  // (provisional args only) and may flip to `error` on failure.
  const env = part.data;
  if (!env) {
    return { args: {}, error: undefined as string | undefined };
  }
  if (env.status === 'success') {
    const merged = (env.data ?? {}) as Record<string, unknown>;
    return { args: merged, error: undefined as string | undefined };
  }
  return {
    args: {} as Record<string, unknown>,
    error: typeof env.error === 'string' ? env.error : undefined,
  };
}

export function ImageGenerationCard({ part }: ImageGenerationCardProps) {
  const { t } = useTranslation();
  const canvasId = useCanvasStore((s) => s.canvasId);
  const { args, error: rawError } = pickDataFields(part);
  const executing = partIsExecuting(part);
  const failed = part.status === 'failed' || rawError !== undefined;
  const error =
    rawError ?? (failed ? t('messages.imageGenerationFailed') : undefined);

  const prompt = typeof args.prompt === 'string' ? args.prompt : undefined;
  const size = typeof args.size === 'string' ? args.size : undefined;
  const quality = typeof args.quality === 'string' ? args.quality : undefined;
  const refs = Array.isArray(args.referenceArtifactSrcs)
    ? (args.referenceArtifactSrcs as string[])
    : [];
  const src = typeof args.src === 'string' ? args.src : undefined;
  const width = typeof args.width === 'number' ? args.width : undefined;
  const height = typeof args.height === 'number' ? args.height : undefined;
  const revisedPrompt =
    typeof args.revisedPrompt === 'string' ? args.revisedPrompt : undefined;

  // ── Title ──────────────────────────────────────────────────────────
  const promptSnippet = prompt ? truncate(prompt, 60) : undefined;
  const mode = refs.length > 0 ? 'edit' : 'generate';
  let title: string;
  if (executing) {
    title = promptSnippet
      ? t('messages.generatingImageWithPrompt', { prompt: promptSnippet })
      : t('messages.generatingImage');
  } else if (failed) {
    title = promptSnippet
      ? t('messages.imageGenerationFailedWithPrompt', { prompt: promptSnippet })
      : t('messages.imageGenerationFailed');
  } else if (mode === 'edit') {
    title = promptSnippet
      ? t('messages.editedImage', { prompt: promptSnippet })
      : t('messages.editedImageFromRefs', { count: refs.length });
  } else {
    title = promptSnippet
      ? t('messages.generatedImageWithPrompt', { prompt: promptSnippet })
      : t('messages.generatedImage');
  }

  // ── Icon (leading) ─────────────────────────────────────────────────
  const icon = executing ? (
    <Loading layout="inline" size="xs" className="text-info" />
  ) : failed ? (
    <XIcon size={12} className="text-danger" />
  ) : (
    <ImagePlus size={12} className="text-fg-muted/60" />
  );

  // ── Body (expanded) ────────────────────────────────────────────────
  // Preview area: spinner while in flight, error message on failure,
  // thumbnail (capped at ~256 px wide) once a src is available.
  const previewUrl = src ? resolveArtifactUrl(src, canvasId) : undefined;

  const dims =
    width && height && (width > 0 || height > 0) ? `${width}×${height}` : size;
  const metaBits = [
    mode === 'edit' ? t('messages.modeEdit') : t('messages.modeGenerate'),
    dims,
    quality,
    refs.length > 0
      ? t('messages.refsMeta', { count: refs.length })
      : undefined,
  ].filter((s): s is string => !!s);

  const body = (
    <div className="border-edge-default/40 ml-4 flex flex-col gap-2 border-l py-2 pl-3">
      {/* Preview */}
      {executing && !previewUrl ? (
        <div className="border-edge-default bg-bg-default flex h-32 w-48 items-center justify-center rounded-md border">
          <Loading layout="inline" size="sm" className="text-fg-muted" />
        </div>
      ) : previewUrl ? (
        <a
          href={previewUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block w-fit"
          title={t('messages.openFullImage')}
        >
          <img
            src={previewUrl}
            alt={prompt ?? t('messages.generatedImage')}
            className="border-edge-default max-h-64 max-w-full rounded-md border object-contain"
            loading="lazy"
          />
        </a>
      ) : null}

      {/* Error message */}
      {error ? (
        <div className="text-danger bg-bg-default rounded-sm px-2 py-1 text-xs whitespace-pre-wrap">
          {error}
        </div>
      ) : null}

      {/* Meta line */}
      {metaBits.length > 0 ? (
        <div className="text-fg-subtle text-xs">{metaBits.join(' · ')}</div>
      ) : null}

      {/* Prompt */}
      {prompt ? (
        <div className="text-fg-muted text-xs">
          <span className="text-fg-subtle">{t('messages.prompt')} </span>
          <span className="whitespace-pre-wrap">{prompt}</span>
        </div>
      ) : null}

      {/* Provider's revised prompt — surface so the user can see the
          model is re-interpreting their intent. */}
      {revisedPrompt && revisedPrompt !== prompt ? (
        <div className="text-fg-muted text-xs">
          <span className="text-fg-subtle">{t('messages.revised')} </span>
          <span className="whitespace-pre-wrap">{revisedPrompt}</span>
        </div>
      ) : null}

      {/* Reference artifact thumbnails — small row so the user can
          confirm the model received the right visual context. */}
      {refs.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-fg-subtle text-xs">
            {t('messages.references', { count: refs.length })}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {refs.map((refSrc, i) => {
              const url = resolveArtifactUrl(refSrc, canvasId);
              return (
                <a
                  key={`${refSrc}-${i}`}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={refSrc}
                  className="border-edge-default bg-bg-default block size-12 overflow-hidden rounded-sm border"
                >
                  <img
                    src={url}
                    alt={t('messages.referenceAlt', { count: i + 1 })}
                    className="size-full object-cover"
                    loading="lazy"
                  />
                </a>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );

  return (
    <AssistantDisclosure
      icon={icon}
      title={title}
      titleTooltip={prompt}
      collapseSignal={!executing}
    >
      {body}
    </AssistantDisclosure>
  );
}
